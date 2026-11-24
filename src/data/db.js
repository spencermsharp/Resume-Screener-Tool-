/**
 * DATA SERVICE LAYER — Vimenture Resume Screener
 * ------------------------------------------------------------------
 * Localhost phase: everything persists in localStorage.
 * Go-live phase:   swap the `backend` object below for a real DB/API.
 *                  Views only ever touch the exported repos
 *                  (Profiles, Candidates, Settings) — never storage
 *                  directly. That indirection is the DB-ready seam.
 *
 * FUTURE-PROOFING THE ROLES:
 * A "screening profile" is DATA, not code. Sales today; Accountant,
 * Telecom Analyst, etc. tomorrow — each is just another profile the
 * user creates in the UI. The screening engine is role-agnostic: it
 * reads whatever criteria a profile defines. No code changes to add
 * a new kind of role.
 */

import { uid, today } from '../utils.js';
import { lightStructure, nameFromFileName } from './parser.js';
import { loadConfig, isConfigured } from '../auth/supabaseClient.js';
import { currentUser } from '../auth/auth.js';
import { AUDIT_TABLE, collectionAuditRows, kvAuditRow } from './audit.js';

const KEYS = {
  profiles: 'qrs_profiles',
  candidates: 'qrs_candidates',   // each candidate = one APPLICATION (person ↔ job)
  people: 'qrs_people',           // global PERSON records (the recycle anchor)
  settings: 'qrs_settings',
  stages: 'qrs_stages',
  blacklist: 'qrs_blacklist',     // global blackball list (all companies)
  companies: 'qrs_companies',     // staffing: client companies
  placements: 'qrs_placements',   // staffing: active hires
  aiConfig: 'qrs_ai_config',      // SHARED AI on/off (admin-controlled, all users)
};

/**
 * WORKSPACES — the app runs in two modes that share the screening core
 * (AI screening, stages, Future Fit, blackball) but differ in business layer:
 *   - 'staffing'  → Kruew: external revenue (clients, placements, margin).
 *   - 'internal'  → Vimenture / Qualis in-house hiring (no money layer).
 * A position belongs to exactly one workspace via its `workspace` field.
 */
export const WORKSPACES = {
  staffing: { id: 'staffing', label: 'Kruew Staffing', companies: null },
  internal: { id: 'internal', label: 'Internal Hiring', companies: ['Vimenture', 'Qualis'] },
};

// Maps a localStorage key → Supabase sync config.
//   collection: an array of {id,...} items → one row per item in `table`.
//   kv:         a single blob → one row in `app_kv` keyed by `kvKey`.
const SYNC = {
  [KEYS.profiles]:   { kind: 'collection', table: 'positions' },
  [KEYS.candidates]: { kind: 'collection', table: 'candidates' },
  [KEYS.people]:     { kind: 'collection', table: 'people' },
  [KEYS.companies]:  { kind: 'collection', table: 'companies' },
  [KEYS.placements]: { kind: 'collection', table: 'placements' },
  // Blacklist is a per-ROW collection (not a blob) so concurrent adds/removes
  // from different devices can't clobber each other — safety-critical list.
  [KEYS.blacklist]:  { kind: 'collection', table: 'blacklist' },
  [KEYS.stages]:     { kind: 'kv', kvKey: 'stages' },
  // AI on/off is shared: an admin sets it once and every user's screening uses it.
  [KEYS.aiConfig]:   { kind: 'kv', kvKey: 'ai_config' },
  // NOTE: settings (current workspace) are deliberately NOT synced — they're
  // per-device UI state, not shared data.
};

// Lazily-loaded sync deps (avoids a hard import cycle at module load).
let _wq = null, _rest = null;
async function wq() { if (!_wq) _wq = await import('./writeQueue.js'); return _wq; }
async function rest() { if (!_rest) _rest = await import('./sbRest.js'); return _rest; }

// ── STORAGE BACKEND ───────────────────────────────────────────────────────────
// LOCAL mode (no Supabase): localStorage IS the data.
// CLOUD mode (Supabase configured): the synced keys live ONLY in memory. The
// server is the source of truth and the app pulls before its first render, so
// there's no reason to keep a multi-MB copy in localStorage (it was hitting the
// ~5 MB browser quota). Non-synced keys (settings, flags) stay in localStorage.
// Memory holds JSON strings so read() always returns a fresh copy, exactly like
// localStorage did — callers mutate what they read before writing it back.
const _mem = {};
let _cloud = null;            // decided once, on first use (see isCloud)
const _loaded = new Set();    // cloud: synced keys filled by a successful pull
let _writeError = null;       // cloud: last failure to queue a write (e.g. quota)

// window.APP_CONFIG is set by public/config.js, a classic script that runs
// before this module, so the config can be read synchronously at import time.
function isCloud() {
  if (_cloud == null) { loadConfig(); _cloud = isConfigured(); }
  return _cloud;
}

// Activity log: bulk/one-time jobs (migrations, seeding) run inside
// withoutAudit() so only real user changes are logged.
let _auditMuted = 0;
function withoutAudit(fn) { _auditMuted++; try { return fn(); } finally { _auditMuted--; } }
// Audit must never break a save: any error here only skips the log row.
function queueAudit(enqueueInsert, build) {
  try {
    const rows = build().filter(Boolean);
    if (rows.length) enqueueInsert(AUDIT_TABLE, rows, AUDIT_TABLE);
  } catch (e) { console.warn('[audit] row skipped', e); }
}

function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}

const backend = {
  read(key) {
    try {
      const raw = (isCloud() && SYNC[key]) ? _mem[key] : localStorage.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch { return null; }
  },

  // Store a value WITHOUT queueing a sync (used for server-confirmed data).
  put(key, value) {
    if (isCloud() && SYNC[key]) { if (value == null) delete _mem[key]; else _mem[key] = JSON.stringify(value); return; }
    if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value));
  },

  write(key, value) {
    // Cloud: refuse to touch shared data before the server copy has loaded, so a
    // write can never upload defaults or a partial list over the real data.
    if (isCloud() && SYNC[key] && !_loaded.has(key)) {
      throw new Error('Data is still loading from the server, so this change was not saved. Please try again in a moment.');
    }
    const prev = this.read(key);
    this.put(key, value);
    // Fire-and-forget sync so the UI stays instant (durable queue handles retries).
    this._sync(key, value, prev);
  },

  // Diff the new value against the previous and enqueue minimal Supabase writes.
  // Once the queue module is loaded this runs synchronously up to the enqueue,
  // so a pull can't land between the cache update and the queued op.
  async _sync(key, value, prev) {
    const cfg = SYNC[key];
    if (!cfg) return;
    // Read before any await: whether this is a logged change, and by whom.
    const audit = !_auditMuted;
    const who = audit ? currentUser() : null;
    try {
      const { enqueueUpsert, enqueueDelete, enqueueInsert } = _wq || await wq();
      if (cfg.kind === 'kv') {
        enqueueUpsert('app_kv', [{ key: cfg.kvKey, value, updated_at: new Date().toISOString() }], `kv:${cfg.kvKey}`);
        if (audit) queueAudit(enqueueInsert, () => [kvAuditRow(cfg.kvKey, prev, value, who)]);
        setSyncStatus({ status: 'syncing' });
        return;
      }
      // collection: upsert changed/new items, delete removed ones.
      const list = Array.isArray(value) ? value : [];
      const prevList = Array.isArray(prev) ? prev : [];
      const nextIds = new Set(list.map(x => String(x.id)));
      const changed = [];
      const prevById = {};
      prevList.forEach(x => { prevById[String(x.id)] = x; });
      // Activity rows, built before the _rev stamps below touch the records.
      let auditRows = [];
      if (audit) {
        try {
          auditRows = collectionAuditRows(cfg.table, prevById, list, prevList.filter(x => !nextIds.has(String(x.id))), who, id => Stages.label(id));
        } catch (e) { console.warn('[audit] rows skipped', e); }
      }
      const stamp = new Date().toISOString();
      for (const item of list) {
        const before = prevById[String(item.id)];
        if (!before || JSON.stringify(before) !== JSON.stringify(item)) {
          // Record a local revision time on the changed record.
          item._rev = stamp;
          changed.push({ id: String(item.id), data: item, updated_at: stamp });
        }
      }
      let touched = false;
      if (changed.length) {
        // Persist the _rev stamps we just set back into the local cache.
        this.put(key, list);
        enqueueUpsert(cfg.table, changed, cfg.table);
        touched = true;
      }
      for (const old of prevList) {
        if (!nextIds.has(String(old.id))) { enqueueDelete(cfg.table, String(old.id), 'id', cfg.table); touched = true; }
      }
      if (auditRows.length) queueAudit(enqueueInsert, () => auditRows);
      if (touched) setSyncStatus({ status: 'syncing' });
    } catch (e) {
      // Surface it: a write that couldn't be queued will never reach the server.
      console.error('[sync] enqueue failed', e);
      _writeError = {
        message: isQuotaError(e)
          ? 'Browser storage is full, so a change could not be queued for upload.'
          : `A change could not be queued for upload: ${e && e.message || e}`,
        at: new Date().toISOString(),
      };
      setSyncStatus({ status: 'error', error: _writeError.message, writeError: _writeError.message });
    }
  },

  // Pull every synced table from Supabase into the cache. The server is the
  // source of truth, with one exception: anything still waiting to upload (queue
  // or dead-letter) is overlaid from the queued op itself, so a pending edit is
  // never reverted and a pending delete never comes back.
  // Returns { ok, changed, reachable, empty }:
  //   ok        every table fetched (a missing table counts as fetched)
  //   changed   server data differs from the previous pull
  //   reachable tables that answered with rows (not missing, not failed)
  //   empty     reachable tables that returned zero rows
  async pullAll() {
    const r = await rest();
    const W = await wq();
    let ok = true, changed = false;
    const reachable = new Set(), empty = new Set();

    // 1) Fetch everything first (app_kv once for all kv keys).
    const kvRows = await r.sbSelect('app_kv');
    const fetched = {};
    for (const [lsKey, cfg] of Object.entries(SYNC)) {
      if (cfg.kind === 'collection') fetched[lsKey] = await r.sbSelect(cfg.table);
    }

    // 2) Snapshot pending work AFTER the fetch, so edits made while the
    //    download was in flight are included. No awaits from here on.
    const overlay = {};   // table -> Map(id -> data | DELETED)
    const DELETED = Symbol('deleted');
    for (const op of W.pendingOps()) {
      if (!op.table) continue;
      const m = overlay[op.table] || (overlay[op.table] = new Map());
      if (op.type === 'upsert') {
        for (const row of op.rows || []) {
          if (!row) continue;
          if (op.table === 'app_kv') { if (row.key != null) m.set(String(row.key), row.value); }
          else if (row.id != null && row.data) m.set(String(row.id), row.data);
        }
      } else if (op.type === 'delete' && op.id != null) m.set(String(op.id), DELETED);
    }

    const sigOf = rows => {
      let max = '';
      for (const x of rows) if (x && x.updated_at && x.updated_at > max) max = x.updated_at;
      return `${rows.length}|${max}`;
    };
    const markSig = (k, sig) => { if (this._sigs[k] !== undefined && this._sigs[k] !== sig) changed = true; this._sigs[k] = sig; };

    // 3) Collections.
    for (const [lsKey, cfg] of Object.entries(SYNC)) {
      if (cfg.kind !== 'collection') continue;
      const rows = fetched[lsKey];
      if (rows == null) { ok = false; continue; }        // fetch FAILED: keep cache, mark not-ok
      const ov = overlay[cfg.table];
      let base;
      if (rows === r.TABLE_MISSING) {
        // Table not created yet: keep what this session has (nothing pulls it).
        base = this.read(lsKey) || [];
      } else {
        reachable.add(cfg.table);
        if (!rows.length) empty.add(cfg.table);
        base = rows.map(x => x.data).filter(Boolean);
        markSig(lsKey, sigOf(rows));
      }
      let mirror = base;
      if (ov && ov.size) {
        const seen = new Set();
        mirror = [];
        for (const item of base) {
          const id = String(item.id);
          seen.add(id);
          if (!ov.has(id)) mirror.push(item);
          else if (ov.get(id) !== DELETED) mirror.push(ov.get(id));
        }
        // Pending records the server doesn't have yet (new) go on top.
        const added = [];
        ov.forEach((data, id) => { if (data !== DELETED && !seen.has(id)) added.push(data); });
        mirror = added.reverse().concat(mirror);
      }
      this.put(lsKey, mirror);
      _loaded.add(lsKey);
    }

    // 4) Key/value rows (stages, ai_config) from the single app_kv fetch.
    if (kvRows == null) ok = false;
    else if (kvRows !== r.TABLE_MISSING) {
      reachable.add('app_kv');
      const kvOv = overlay.app_kv;
      for (const [lsKey, cfg] of Object.entries(SYNC)) {
        if (cfg.kind !== 'kv') continue;
        const row = kvRows.find(x => x.key === cfg.kvKey);
        markSig(lsKey, row ? String(row.updated_at || JSON.stringify(row.value)) : '-');
        if (kvOv && kvOv.has(cfg.kvKey)) this.put(lsKey, kvOv.get(cfg.kvKey));   // pending local value wins
        else this.put(lsKey, row && row.value != null ? row.value : null);       // null = use defaults
        _loaded.add(lsKey);
      }
    }
    return { ok, changed, reachable, empty };
  },
  _sigs: {},
};

/**
 * CRITERION shape (the building block of every profile):
 *   { id, label, keywords:[], weight:1-5, required:bool, kind }
 *   kind ∈ 'skill' | 'experience' | 'education' | 'certification' | 'other'
 * The engine matches `keywords` against resume text; `weight` sets
 * importance; `required` means a missing match heavily penalizes.
 */

// ── SEED: a role-agnostic Sales profile (your current need) ───────────────────
const SEED_PROFILES = [
  {
    id: 'PROF-SALES',
    role: 'Sales Representative',
    summary: 'Outbound/relationship sales. Looking for quota attainment, CRM fluency, and strong communication.',
    minYears: 2,
    workspace: 'internal',   // 'staffing' | 'internal'
    company: 'Vimenture',    // internal: Vimenture|Qualis ; staffing: client company id
    status: 'open',          // open | archived
    openedAt: today(),       // when the position was opened
    archivedAt: null,        // set when archived (e.g. role filled)
    threshold: 60,           // % score below which a candidate is flagged "below threshold"
    criteria: [
      { id: uid('CRIT'), label: 'B2B / outbound sales experience', kind: 'experience', keywords: ['b2b', 'outbound', 'account executive', 'business development', 'sales rep'], weight: 5, required: true },
      { id: uid('CRIT'), label: 'Quota / revenue attainment', kind: 'experience', keywords: ['quota', 'exceeded', 'revenue', 'closed', 'pipeline', '%'], weight: 5, required: false },
      { id: uid('CRIT'), label: 'CRM tools (Salesforce/HubSpot)', kind: 'skill', keywords: ['salesforce', 'hubspot', 'crm', 'pipedrive'], weight: 3, required: false },
      { id: uid('CRIT'), label: 'Communication / negotiation', kind: 'skill', keywords: ['negotiation', 'presentation', 'communication', 'relationship'], weight: 3, required: false },
      { id: uid('CRIT'), label: 'Prospecting / lead generation', kind: 'skill', keywords: ['prospecting', 'cold calling', 'lead generation', 'demand generation'], weight: 2, required: false },
    ],
    createdAt: today(),
  },
];

// Example profiles the user can "clone" later — kept out of the active set but
// documented here so the future-proofing is concrete. (Not seeded.)
export const EXAMPLE_ROLE_TEMPLATES = {
  Accountant: ['gaap', 'reconciliation', 'accounts payable', 'accounts receivable', 'quickbooks', 'cpa', 'ledger', 'audit'],
  'Telecom Analyst': ['telecom', 'voip', 'sip', 'network', 'bandwidth', 'carrier', 'provisioning', 'ocn'],
};

const DEFAULT_SETTINGS = {
  companyName: 'Vimenture',
  workspace: 'internal',   // which mode the app is currently showing
  phpPerUsd: 56,           // PHP→USD conversion for staffing margin math
  // AI integration config — populated during IDE handoff. Nothing is sent anywhere yet.
  ai: { enabled: false, provider: '', model: '', note: 'AI not wired yet — rule-based baseline in use.' },
};

/**
 * HIRING PIPELINE STAGES — configurable, ordered list (DATA, not code).
 * ------------------------------------------------------------------
 * Each stage: { id, label, kind, terminal }
 *   kind ∈ 'screen' | 'reject' | 'interview' | 'offer' | 'hired'
 *   terminal: true for end states (hired/rejected) — no further movement expected.
 * Add an interviewer stage or rename one in the Stages settings UI; no code
 * changes needed. Candidates reference a stage by its stable `id`.
 */
const DEFAULT_STAGES = [
  { id: 'screened',   label: 'Screened',                 kind: 'screen',    terminal: false },
  { id: 'future_fit', label: 'Future Fit',               kind: 'parked',    terminal: false },
  { id: 'hr',         label: 'HR Interview',             kind: 'interview', terminal: false },
  { id: 'mark_sharp', label: 'Mark Sharp Interview',     kind: 'interview', terminal: false },
  { id: 'hiring_mgr', label: 'Hiring Manager Interview', kind: 'interview', terminal: false },
  { id: 'offer',      label: 'Offer',                    kind: 'offer',     terminal: false },
  { id: 'hired',      label: 'Hired',                    kind: 'hired',     terminal: true  },
  { id: 'out',        label: 'Out (Blackballed)',        kind: 'reject',    terminal: true  },
  { id: 'rejected',   label: 'Rejected',                 kind: 'reject',    terminal: true  },
];

// Does this candidate name look like it's just the uploaded file's name
// (rather than a person's name)? Used by the one-time name backfill.
function nameLooksLikeFile(name, fileName) {
  const n = String(name || '').trim();
  if (!n) return true;
  if (/\.(pdf|txt|docx?|rtf)$/i.test(n)) return true;        // ends in a file extension
  if (fileName && n === String(fileName).trim()) return true; // equals the stored filename
  if (/[_/\\]/.test(n)) return true;                          // path/underscore separators
  if (/\d{3,}/.test(n)) return true;                          // long digit runs (e.g. "resume2026v2")
  return false;
}

const NAME_BACKFILL_FLAG = 'qrs_namebackfill_v1';

// ONE-TIME BACKFILL: older candidates were named after their uploaded file
// (e.g. "jane_doe_resume.pdf"). Re-derive the real name from the resume text,
// falling back to a cleaned-up filename, for any name that still looks like a
// file. Idempotent and guarded by a localStorage flag so it runs exactly once
// per device — but only AFTER real candidate data is present (important in
// cloud mode, where the server pull happens after initDB). Good names are
// never touched. Returns true once it has actually run against real data.
function maybeBackfillNames() {
  if (localStorage.getItem(NAME_BACKFILL_FLAG) != null) return false;
  const list = backend.read(KEYS.candidates) || [];
  if (!list.length) return false;   // no data yet — try again after the pull

  let changed = false;
  const people = backend.read(KEYS.people) || [];
  const peopleById = {}; people.forEach(p => { peopleById[String(p.id)] = p; });
  let peopleChanged = false;

  for (const c of list) {
    if (!nameLooksLikeFile(c.name, c.fileName)) continue;
    const fromText = (lightStructure(c.rawText || '').name || '').trim();
    const better = fromText || nameFromFileName(c.fileName || c.name) || '';
    if (!better || better === c.name) continue;
    c.name = better;
    changed = true;
    // Keep the linked global Person's name in sync when it was also a filename.
    const person = c.personId ? peopleById[String(c.personId)] : null;
    if (person && nameLooksLikeFile(person.name, c.fileName)) { person.name = better; peopleChanged = true; }
  }

  if (changed) backend.write(KEYS.candidates, list);
  if (peopleChanged) backend.write(KEYS.people, people);
  localStorage.setItem(NAME_BACKFILL_FLAG, String(Date.now()));
  console.log('[backfill] candidate names normalized:', changed ? 'updated' : 'nothing to change');
  return true;
}

const RESCORE_FLAG = 'qrs_rescore_rules_v1';
let _rescoring = false;

// ONE-TIME RE-SCORE: candidates screened before the improved rules matcher
// (variant/spacing-tolerant keywords) kept their old scores, so real skills
// like "QuickBooks Online" could still show as missing. Re-run the CURRENT
// rules engine on each rules-scored candidate's stored resume text and update
// ONLY `result` (score + matched/missing + explanation) where it changed.
// Stage, notes, edited details, etc. are never touched. AI-scored results are
// left alone. Pushes straight to Supabase in small batches and only sets the
// done-flag once every batch succeeds, so a failed upload retries next sync.
//   afterPull: true when called right after a server pull (cloud mode). In
//   cloud mode we refuse to run on a pre-pull cache so stale data can never be
//   written back to the server.
async function maybeRescoreRules(afterPull = false) {
  if (_rescoring || localStorage.getItem(RESCORE_FLAG) != null) return;
  _rescoring = true;
  try {
    const { isConfigured } = await import('../auth/supabaseClient.js');
    const cloud = isConfigured();
    if (cloud && !afterPull) return;

    const cands = backend.read(KEYS.candidates) || [];
    const profiles = backend.read(KEYS.profiles) || [];
    if (!cands.length || !profiles.length) return;  // no data yet — try after the pull

    // Don't race an in-flight local edit to a candidate; try again next sync.
    if (cloud) {
      const { pendingRecordIds } = await wq();
      const pend = pendingRecordIds().candidates;
      if (pend && (pend.upsert.size || pend.del.size)) return;
    }

    const { screenRuleBased } = await import('./screener.js');
    const profById = {}; profiles.forEach(p => { profById[String(p.id)] = p; });
    const sig = r => JSON.stringify([r?.score, (r?.matched || []).map(m => m.label).sort()]);

    const updates = new Map(); // candidate id -> new result
    for (const c of cands) {
      if (!c.result || c.result.engine !== 'rules') continue;
      if (!c.rawText || !c.rawText.trim()) continue;
      const prof = profById[String(c.profileId)];
      if (!prof || !Array.isArray(prof.criteria) || !prof.criteria.length) continue;
      const next = screenRuleBased(c.rawText, prof);
      if (sig(next) !== sig(c.result)) updates.set(String(c.id), next);
    }

    if (!updates.size) {
      localStorage.setItem(RESCORE_FLAG, String(Date.now()));
      console.log('[rescore] nothing to change');
      return;
    }

    // Local-only mode: the cache IS the data — just write it.
    if (!cloud) {
      const list = backend.read(KEYS.candidates) || [];
      list.forEach(c => { const r = updates.get(String(c.id)); if (r) c.result = r; });
      backend.write(KEYS.candidates, list);
      localStorage.setItem(RESCORE_FLAG, String(Date.now()));
      console.log('[rescore] updated', updates.size, 'candidates (local)');
      return;
    }

    // Cloud mode: upload in batches (resume text makes rows large), merging the
    // new result into the LATEST cached copy of each record right before send.
    const { sbUpsert } = await rest();
    const ids = [...updates.keys()];
    const BATCH = 20;
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const latest = backend.read(KEYS.candidates) || [];
      const byId = {}; latest.forEach(c => { byId[String(c.id)] = c; });
      const stamp = new Date().toISOString();
      const rows = chunk
        .filter(id => byId[id])
        .map(id => ({ id, data: { ...byId[id], result: updates.get(id) }, updated_at: stamp }));
      const res = await sbUpsert('candidates', rows);
      if (!res.ok) {
        console.warn('[rescore] batch failed — will retry next sync:', res.error);
        return; // flag NOT set → the whole pass reruns (already-updated rows are no-ops)
      }
      // Mirror the confirmed server write into the local cache (no re-queue).
      const fresh = backend.read(KEYS.candidates) || [];
      fresh.forEach(c => { const r = rows.find(x => x.id === String(c.id)); if (r) c.result = r.data.result; });
      backend.put(KEYS.candidates, fresh);
      done += rows.length;
    }
    localStorage.setItem(RESCORE_FLAG, String(Date.now()));
    console.log('[rescore] updated', done, 'candidates');
  } catch (e) {
    console.warn('[rescore] failed — will retry next sync', e);
  } finally {
    _rescoring = false;
  }
}

// ── INIT ───────────────────────────────────────────────────────────────────
// Data migrations. Each one writes ONLY if it actually changed something. Local
// mode runs them at boot; cloud mode runs them once per session after the first
// successful server pull, so they only ever see (and upload) real server data.
// Returns a list of what changed, for the console log.
function runDataMigrations() {
  const did = [];
  // Migrate legacy candidates (old `status` field) to the stage pipeline.
  const cands = backend.read(KEYS.candidates) || [];
  const legacyIds = [];
  const legacyMap = { screened: 'screened', shortlisted: 'hr', rejected: 'rejected' };
  for (const c of cands) {
    let hit = false;
    if (!c.stage) {
      c.stage = legacyMap[c.status] || 'screened';
      c.stageHistory = c.stageHistory || [{ stage: c.stage, at: new Date().toISOString(), note: 'Imported from earlier version.' }];
      hit = true;
    }
    // Retire the removed "Will Not Interview" stage → fold into Rejected.
    if (c.stage === 'no_interview') { c.stage = 'rejected'; hit = true; }
    if (hit) legacyIds.push(c.id);
  }
  if (legacyIds.length) { backend.write(KEYS.candidates, cands); did.push(`legacy stage: ${legacyIds.join(', ')}`); }

  // Drop the retired stage from any saved stages list.
  const savedStages = backend.read(KEYS.stages);
  if (Array.isArray(savedStages) && savedStages.some(s => s.id === 'no_interview')) {
    backend.write(KEYS.stages, savedStages.filter(s => s.id !== 'no_interview'));
    did.push('stages: removed no_interview');
  }

  // Backfill threshold + workspace/company on older profiles that predate them.
  const profs = backend.read(KEYS.profiles) || [];
  const profIds = [];
  for (const p of profs) {
    let hit = false;
    if (p.threshold == null) { p.threshold = 60; hit = true; }
    if (p.workspace == null) { p.workspace = 'internal'; hit = true; }
    if (p.company == null) { p.company = p.workspace === 'internal' ? 'Vimenture' : ''; hit = true; }
    if (hit) profIds.push(p.id);
  }
  if (profIds.length) { backend.write(KEYS.profiles, profs); did.push(`profile backfill: ${profIds.join(', ')}`); }

  // Migrate: ensure every candidate (application) is linked to a global Person.
  // Match existing people by email, else by name, else create a new Person.
  const allCands = backend.read(KEYS.candidates) || [];
  let people = backend.read(KEYS.people) || [];
  let peopleChanged = false;
  const linked = [];
  const findPerson = (name, email) => {
    const e = normEmail(email), n = normName(name);
    if (e) return people.find(p => normEmail(p.email) === e) || null;
    return people.find(p => !p.email && n && normName(p.name) === n) || null;
  };
  for (const c of allCands) {
    if (c.personId) continue;
    const email = c.parsed?.email || '';
    let person = findPerson(c.name, email);
    if (!person) {
      person = {
        id: uid('PERSON'),
        name: c.name || 'Unknown',
        email,
        phone: c.parsed?.phone || '',
        createdAt: c.createdAt || today(),
      };
      people.unshift(person);
      peopleChanged = true;
    }
    c.personId = person.id;
    linked.push(c.id);
  }
  if (peopleChanged) backend.write(KEYS.people, people);
  if (linked.length) { backend.write(KEYS.candidates, allCands); did.push(`person link: ${linked.join(', ')}`); }
  return did;
}

export function initDB() {
  // Settings are per-device UI state (never synced) and live in localStorage in both modes.
  if (backend.read(KEYS.settings) == null) backend.write(KEYS.settings, DEFAULT_SETTINGS);

  if (isCloud()) {
    // Cloud mode: write NOTHING shared before the first successful pull (no
    // seed position, no default stages, no migrations). Free the quota held by
    // the old localStorage cache: only these synced cache keys are removed —
    // the write queue, dead-letter, settings, session and one-time flags stay.
    for (const k of Object.keys(SYNC)) { try { localStorage.removeItem(k); } catch {} }
    return;
  }

  // Local-only mode: localStorage is the data, so seed + migrate right here.
  withoutAudit(() => {
    if (backend.read(KEYS.profiles) == null) backend.write(KEYS.profiles, SEED_PROFILES);
    if (backend.read(KEYS.candidates) == null) backend.write(KEYS.candidates, []);
    if (backend.read(KEYS.stages) == null) backend.write(KEYS.stages, DEFAULT_STAGES);
    if (backend.read(KEYS.blacklist) == null) backend.write(KEYS.blacklist, []);
    if (backend.read(KEYS.companies) == null) backend.write(KEYS.companies, []);
    if (backend.read(KEYS.placements) == null) backend.write(KEYS.placements, []);
    if (backend.read(KEYS.people) == null) backend.write(KEYS.people, []);
    runDataMigrations();
  });
  // The one-time name backfill and rules re-score have already run against
  // production. They are no longer called: their done-flags are per-device,
  // so every new browser would otherwise re-run them and silently rewrite
  // shared data.
}

// Cloud: one-time work after the first successful pull of this session.
let _postPullDone = false;
function afterFirstPull(res) {
  if (_postPullDone) return;
  _postPullDone = true;
  const did = withoutAudit(runDataMigrations);
  if (did.length) console.log('[migrate] uploaded changes:', did);
  // Seed the sample position only if the server genuinely has no positions
  // (and nothing is pending for that table).
  if (res.empty.has('positions') && !Profiles.all().length) {
    withoutAudit(() => backend.write(KEYS.profiles, JSON.parse(JSON.stringify(SEED_PROFILES))));
    console.log('[seed] server had no positions — seeded', SEED_PROFILES[0].id);
  }
}

// ── PROFILES REPOSITORY (role definitions — data, not code) ───────────────────
export const Profiles = {
  all() { return backend.read(KEYS.profiles) || []; },
  get(id) { return this.all().find(p => p.id === id) || null; },
  // Workspace-scoped list (staffing vs internal).
  byWorkspace(ws) { return this.all().filter(p => (p.workspace || 'internal') === ws); },
  // Convenience filters for open vs. archived positions, optionally by workspace.
  open(ws) { return this.all().filter(p => (p.status || 'open') !== 'archived' && (!ws || (p.workspace || 'internal') === ws)); },
  archived(ws) { return this.all().filter(p => p.status === 'archived' && (!ws || (p.workspace || 'internal') === ws)); },
  create(data) {
    const list = this.all();
    const workspace = data.workspace || 'internal';
    const prof = {
      id: uid('PROF'),
      role: data.role || 'Untitled Role',
      summary: data.summary || '',
      minYears: parseFloat(data.minYears) || 0,
      workspace,
      company: data.company || (workspace === 'internal' ? 'Vimenture' : ''),
      // Staffing-only commercial fields (Kruew): which client + the money.
      companyId: data.companyId || '',
      billRate: parseFloat(data.billRate) || 0,       // USD/mo client pays Kruew
      payBudget: parseFloat(data.payBudget) || 0,     // worker pay budget
      payCurrency: data.payCurrency || 'USD',         // 'USD' | 'PHP'
      priority: data.priority || 'normal',            // 'normal' | 'urgent'
      ownerId: data.ownerId || '',          // user who owns this position
      status: 'open',
      openedAt: today(),
      archivedAt: null,
      threshold: data.threshold != null ? Math.max(0, Math.min(100, parseInt(data.threshold, 10) || 0)) : 60,
      criteria: data.criteria || [],
      createdAt: today(),
    };
    list.unshift(prof);
    backend.write(KEYS.profiles, list);
    return prof;
  },
  update(id, patch) {
    const list = this.all();
    const i = list.findIndex(p => p.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    backend.write(KEYS.profiles, list);
    return list[i];
  },
  // Archive = position filled/closed; keeps all data, just hides from "open".
  archive(id) { return this.update(id, { status: 'archived', archivedAt: today() }); },
  reopen(id) { return this.update(id, { status: 'open', archivedAt: null }); },
  remove(id) { backend.write(KEYS.profiles, this.all().filter(p => p.id !== id)); },
  // Staffing margin math: pay converted to USD, then bill − pay.
  payBudgetUsd(p) {
    const rate = Settings.get().phpPerUsd || 56;
    const pay = parseFloat(p.payBudget) || 0;
    return (p.payCurrency === 'PHP') ? pay / rate : pay;
  },
  margin(p) { return (parseFloat(p.billRate) || 0) - this.payBudgetUsd(p); },
};

// ── PEOPLE REPOSITORY (global person records — the recycle anchor) ────────────
/**
 * A Person is ONE permanent record per human, shared across every workspace and
 * company. Each job they're considered for is a separate Candidate (application)
 * linked by personId. This is what makes recycling + full history work.
 *   Person: { id, name, email, phone, createdAt }
 */
export const People = {
  all() { return backend.read(KEYS.people) || []; },
  get(id) { return this.all().find(p => p.id === id) || null; },
  match({ name, email, phone }) {
    const target = { email, phone };
    // Identity = email OR phone (people can share a name). Match on either.
    const byContact = this.all().find(p => sameContact(p, target));
    if (byContact) return byContact;
    // Last resort: name only when the incoming person has NO email/phone at all.
    if (!normEmail(email) && !normPhone(phone)) {
      const n = normName(name);
      return this.all().find(p => !p.email && !p.phone && n && normName(p.name) === n) || null;
    }
    return null;
  },
  findOrCreate({ name, email, phone }) {
    const existing = this.match({ name, email, phone });
    if (existing) {
      // Backfill missing contact info if this sighting has more.
      const patch = {};
      if (!existing.email && email) patch.email = email;
      if (!existing.phone && phone) patch.phone = phone;
      if (Object.keys(patch).length) this.update(existing.id, patch);
      return this.get(existing.id);
    }
    const list = this.all();
    const person = { id: uid('PERSON'), name: name || 'Unknown', email: email || '', phone: phone || '', createdAt: today() };
    list.unshift(person);
    backend.write(KEYS.people, list);
    return person;
  },
  update(id, patch) {
    const list = this.all();
    const i = list.findIndex(p => p.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    backend.write(KEYS.people, list);
    return list[i];
  },
  // Every application (candidate record) for this person, newest first — the
  // cross-job history log.
  history(personId) {
    return (backend.read(KEYS.candidates) || [])
      .filter(c => c.personId === personId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },
};

// ── CANDIDATES REPOSITORY ─────────────────────────────────────────────────────
/**
 * Candidate = one APPLICATION (a person considered for one job).
 *   { id, personId, name, fileName, profileId, rawText, parsed, result,
 *     stage, stageHistory[], createdAt }
 */
export const Candidates = {
  all() { return backend.read(KEYS.candidates) || []; },
  get(id) { return this.all().find(c => c.id === id) || null; },
  byProfile(profileId) { return this.all().filter(c => c.profileId === profileId); },
  byStage(profileId, stageId) { return this.byProfile(profileId).filter(c => c.stage === stageId); },
  byPerson(personId) { return this.all().filter(c => c.personId === personId); },
  // Find an existing application for the SAME person on the SAME position — a
  // duplicate (same person applying to the same role from different sources).
  findDuplicate(personId, profileId) {
    if (!personId || !profileId) return null;
    return this.all().find(c => c.personId === personId && c.profileId === profileId) || null;
  },
  create(data) {
    const list = this.all();
    const stamp = new Date().toISOString();
    const startStage = data.stage || 'screened';
    // Link (or create) the global Person this application belongs to.
    const person = data.personId
      ? People.get(data.personId)
      : People.findOrCreate({ name: data.name || data.fileName, email: data.parsed?.email, phone: data.parsed?.phone });
    const cand = {
      id: uid('CAND'),
      personId: person ? person.id : null,
      name: data.name || data.fileName || 'Unknown Candidate',
      fileName: data.fileName || '',
      profileId: data.profileId || null,
      rawText: data.rawText || '',
      pdfUrl: data.pdfUrl || '',
      fileUrl: data.fileUrl || '',
      fileType: data.fileType || '',
      parsed: data.parsed || {},
      result: data.result || null,
      stage: startStage,                 // current pipeline stage id
      stageHistory: [                    // audit trail of every move
        { stage: startStage, at: stamp, note: 'Screened and added to pipeline.' },
      ],
      createdAt: today(),
    };
    list.unshift(cand);
    backend.write(KEYS.candidates, list);
    return cand;
  },
  update(id, patch) {
    const list = this.all();
    const i = list.findIndex(c => c.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    backend.write(KEYS.candidates, list);
    return list[i];
  },
  /**
   * Move a candidate to a stage, appending to the audit trail. Supports going
   * forward, backward, or jumping anywhere — no restrictions, since real hiring
   * is non-linear (second interviews, re-reviews, etc.). An optional note
   * records WHY (e.g. "HR wants a second look").
   */
  setStage(id, stageId, note = '') {
    const c = this.get(id);
    if (!c) return null;
    const entry = { stage: stageId, at: new Date().toISOString(), note: note || '' };
    const history = Array.isArray(c.stageHistory) ? [...c.stageHistory, entry] : [entry];
    return this.update(id, { stage: stageId, stageHistory: history });
  },
  // Team notes — a running comment thread per candidate (separate from stage history).
  addNote(id, text, author = '') {
    const c = this.get(id);
    if (!c) return null;
    const note = { text: String(text || '').trim(), author: author || '', at: new Date().toISOString() };
    if (!note.text) return c;
    const notes = Array.isArray(c.notes) ? [...c.notes, note] : [note];
    return this.update(id, { notes });
  },
  // Reject with a structured reason (optionally parking in Future Fit).
  reject(id, reason, note = '') {
    const toFutureFit = reason === 'Better fit for another role';
    const stage = toFutureFit ? 'future_fit' : 'rejected';
    const msg = `${toFutureFit ? 'Parked in Future Fit' : 'Rejected'} — ${reason}${note ? ': ' + note : ''}.`;
    this.update(id, { rejectReason: reason });
    return this.setStage(id, stage, msg);
  },
  remove(id) { backend.write(KEYS.candidates, this.all().filter(c => c.id !== id)); },
  clearForProfile(profileId) {
    backend.write(KEYS.candidates, this.all().filter(c => c.profileId !== profileId));
  },
  clearAll() { backend.write(KEYS.candidates, []); },

  // GLOBAL Future Fit pool — everyone parked, across ALL workspaces/companies.
  // De-duped by person (a person shows once even if parked from multiple jobs).
  futureFitPool() {
    const parked = this.all().filter(c => c.stage === 'future_fit');
    const byPerson = {};
    for (const c of parked) {
      const key = c.personId || c.id;
      if (!byPerson[key] || String(c.createdAt) > String(byPerson[key].createdAt)) byPerson[key] = c;
    }
    return Object.values(byPerson).sort((a, b) => (b.result?.score || 0) - (a.result?.score || 0));
  },
};

// Structured reject reasons (not free text) — searchable + feed Future Fit.
// "Better fit for another role" is the signal to park in Future Fit.
export const REJECT_REASONS = [
  'Missing required skill',
  'Not enough experience',
  'Overqualified',
  'Location / timezone',
  'Compensation mismatch',
  'Culture fit',
  'Better fit for another role',
  'Failed interview',
  'Withdrew / unresponsive',
  'Other',
];

// ── STAGES REPOSITORY (hiring pipeline — configurable, ordered) ───────────────
export const Stages = {
  all() {
    const s = backend.read(KEYS.stages);
    return (s && s.length) ? s : DEFAULT_STAGES;
  },
  get(id) { return this.all().find(s => s.id === id) || null; },
  label(id) { const s = this.get(id); return s ? s.label : (id || '—'); },
  // Stages a candidate can actively progress through (excludes reject buckets).
  active() { return this.all().filter(s => s.kind !== 'reject'); },
  save(list) { backend.write(KEYS.stages, list); return list; },
  add(label, kind = 'interview') {
    const list = this.all();
    const id = uid('STG').toLowerCase();
    const stage = { id, label: label || 'New Stage', kind, terminal: kind === 'hired' || kind === 'reject' };
    // Insert before terminal end-states so new interviews land mid-pipeline.
    const firstTerminal = list.findIndex(s => s.terminal);
    if (firstTerminal === -1) list.push(stage); else list.splice(firstTerminal, 0, stage);
    this.save(list);
    return stage;
  },
  rename(id, label) {
    const list = this.all().map(s => s.id === id ? { ...s, label } : s);
    return this.save(list);
  },
  move(id, dir) {
    const list = this.all();
    const i = list.findIndex(s => s.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return list;
    [list[i], list[j]] = [list[j], list[i]];
    return this.save(list);
  },
  remove(id) {
    // Keep built-in essentials; allow removing custom/interview stages.
    const protectedIds = new Set(['screened', 'rejected', 'hired']);
    if (protectedIds.has(id)) return this.all();
    return this.save(this.all().filter(s => s.id !== id));
  },
  reset() { return this.save(JSON.parse(JSON.stringify(DEFAULT_STAGES))); },
};

// ── SYNC STATUS (observable) ──────────────────────────────────────────────────
// status: 'synced' | 'syncing' | 'pending' | 'failed' | 'offline' | 'error' | 'local'
const _syncState = { status: 'local', pending: 0, failing: 0, deadLetter: 0, failingOps: [], deadLetterOps: [], writeError: null, error: null, lastSync: null };
const _syncListeners = new Set();
export function onSyncStatus(fn) { _syncListeners.add(fn); fn(_syncState); return () => _syncListeners.delete(fn); }
export function getSyncStatus() { return { ..._syncState }; }
function setSyncStatus(patch) { Object.assign(_syncState, patch); _syncListeners.forEach(fn => { try { fn(_syncState); } catch {} }); }

let _cycleP = null;        // in-flight sync cycle (push + pull)
let _lastPullOk = null;    // result of the last finished pull
let _onPulledCb = null;
let _cloudStarted = false;

// Publish queue counts (and, when `pullOk` is given, the overall status) into
// the sync signal. 'failed' = writes the server rejected (dead-letter) or that
// keep failing (3+ attempts); 'error' = pull failed or a write couldn't be queued.
// Activity rows parked because public.audit_log doesn't exist yet (HTTP 404).
// They go up on their own once it does, so they're not shown as failed saves.
const isAuditWaiting = op => op.table === AUDIT_TABLE && op.status === 404;

function publishStatus(pullOk) {
  if (!_wq) return;
  const s = { ..._wq.queueStatus() };
  s.deadLetterOps = s.deadLetterOps.filter(op => !isAuditWaiting(op));
  s.deadLetter = s.deadLetterOps.length;
  const brief = ops => ops.map(o => ({ table: o.table, label: o.label, status: o.status, lastError: String(o.lastError || '').slice(0, 300) }));
  const patch = {
    pending: s.pending, failing: s.failing, deadLetter: s.deadLetter,
    failingOps: brief(s.failingOps), deadLetterOps: brief(s.deadLetterOps),
    writeError: _writeError ? _writeError.message : null,
  };
  if (pullOk === false) Object.assign(patch, { status: 'error', error: 'Could not load the latest data from the server.' });
  else if (pullOk === true) {
    if (_writeError) Object.assign(patch, { status: 'error', error: _writeError.message });
    else if (s.deadLetter || s.failing) Object.assign(patch, { status: 'failed', error: null });
    else if (s.pending) Object.assign(patch, { status: 'pending', error: null });
    else Object.assign(patch, { status: 'synced', error: null });
  }
  setSyncStatus(patch);
}

export function isNulRejected(op) { return op.status === 400 && String(op.lastError || '').includes('22P05'); }

async function runCycle() {
  const W = await wq();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    publishStatus();
    setSyncStatus({ status: 'offline' });
    return;
  }
  setSyncStatus({ status: 'syncing' });
  let ok = false, res = null;
  try {
    try { await W.drainQueue(); } catch (e) { console.warn('[sync] upload failed', e); }  // push local changes up first
    res = await backend.pullAll();                                                         // then mirror server down
    ok = res.ok;
    // The activity log is never pulled, so check it separately (one tiny read,
    // only while activity rows are waiting for the table to be created).
    if (W.queueStatus().deadLetterOps.some(isAuditWaiting)) {
      const probe = await (await rest()).sbQuery(AUDIT_TABLE, 'select=id&limit=1');
      if (Array.isArray(probe)) res.reachable.add(AUDIT_TABLE);
    }
    // A table that now answers was missing before: re-queue the writes that
    // dead-lettered with 404 because of it (e.g. blackball entries).
    const moved = W.retryDeadLetterWhere(op => op.status === 404 && res.reachable.has(op.table));
    if (moved) { console.log('[sync] re-queued', moved, 'write(s) for tables that now exist'); await W.drainQueue(); }
    if (ok) {
      // Writes rejected for NUL chars (22P05) now go through the send-side
      // sanitizer, so retry them. Idempotent: they leave the dead-letter on success.
      const fixed = W.retryDeadLetterWhere(isNulRejected);
      if (fixed) { console.log('[sync] re-queued', fixed, 'write(s) rejected for NUL characters'); await W.drainQueue(); }
      afterFirstPull(res);
    }
  } catch (e) {
    console.warn('[sync] cycle failed', e);
    ok = false;
  } finally {
    _lastPullOk = ok;
    publishStatus(ok);
    if (ok) setSyncStatus({ lastSync: new Date().toISOString() });
  }
  if (_onPulledCb && res) { try { _onPulledCb({ changed: !!res.changed }); } catch (e) { console.warn('[sync] refresh failed', e); } }
}

// Run one full sync cycle: push the queue, then pull from Supabase (source of
// truth). If a cycle is already running, returns (and waits on) that one.
export function syncNow() {
  if (!isCloud()) { setSyncStatus({ status: 'local' }); return Promise.resolve(); }
  if (_cycleP) return _cycleP;
  _cycleP = runCycle().finally(() => { _cycleP = null; });
  return _cycleP;
}

// Full re-sync on demand (boot, login, chip double-click). The cloud cache is
// memory-only and pending writes are overlaid by the pull, so this no longer
// wipes anything: it waits for any running cycle, then uploads + pulls fresh.
// Returns the candidate count.
export async function forceResync() {
  if (!isCloud()) return null;
  if (_cycleP) { try { await _cycleP; } catch {} }
  await syncNow();
  const n = (backend.read(KEYS.candidates) || []).length;
  console.log('[sync] forceResync complete — candidates now:', n);
  return n;
}

// Chip action when writes failed: move dead-letter ops back into the queue,
// clear the "couldn't queue" flag, and sync.
export async function retryFailedWrites() {
  _writeError = null;
  const W = await wq();
  W.retryDeadLetter();
  return syncNow();
}

// Call once after initDB(). Starts the durable write-queue worker and polls
// periodically so other devices' changes appear. `onPulled({changed})` runs
// after every pull. Extra calls only update the callback.
export async function initCloudSync(onPulled) {
  if (!isCloud()) { setSyncStatus({ status: 'local' }); return; }
  if (onPulled) _onPulledCb = onPulled;
  if (_cloudStarted) return;
  _cloudStarted = true;
  const W = await wq();
  // Keep the chip's counts live between cycles (dead-letter, pending, failing).
  W.onQueueChange(() => publishStatus(_cycleP || _lastPullOk == null ? undefined : _lastPullOk));
  W.startQueueWorker(5000);
  await syncNow();                            // initial sync
  setInterval(syncNow, 15000);                // periodic source-of-truth refresh
  if (typeof window !== 'undefined') window.addEventListener('online', syncNow);
}

// ── SHARED AI CONFIG (admin-controlled) ───────────────────────────────────────
// One setting for the whole team: when an admin turns AI on, EVERY user's
// screening runs through Claude; when off, everyone uses the rules engine.
// Stored in Supabase (app_kv 'ai_config') so it's identical on all devices.
// Defaults to OFF until an admin turns it on.
const AI_DEFAULT = { enabled: false, model: '' };
export const AIConfig = {
  get() { return { ...AI_DEFAULT, ...(backend.read(KEYS.aiConfig) || {}) }; },
  // Admin-only in the UI. Records who changed it and when.
  set(patch, byName = '') {
    const next = { ...this.get(), ...patch, updatedAt: new Date().toISOString(), updatedBy: byName };
    backend.write(KEYS.aiConfig, next);
    return next;
  },
  // Pull the latest value straight from Supabase (call right before screening
  // so an admin's change applies immediately, not on the next 15s sync).
  // Never clobbers a local change that hasn't finished uploading.
  async refresh() {
    try {
      const { isConfigured } = await import('../auth/supabaseClient.js');
      if (!isConfigured()) return this.get();
      const { pendingRecordIds } = await wq();
      const pend = pendingRecordIds().app_kv;
      if (pend && pend.upsert.has('ai_config')) return this.get();
      const r = await rest();
      const rows = await r.sbSelect('app_kv');
      if (!Array.isArray(rows)) return this.get();      // fetch failed — keep cache
      const row = rows.find(x => x.key === 'ai_config');
      backend.put(KEYS.aiConfig, row && row.value != null ? row.value : null);   // never set → default (off)
    } catch (e) { console.warn('[ai] refresh failed, using cached setting', e); }
    return this.get();
  },
};

// ── SETTINGS REPOSITORY ───────────────────────────────────────────────────────
export const Settings = {
  get() { return { ...DEFAULT_SETTINGS, ...(backend.read(KEYS.settings) || {}) }; },
  update(patch) { const next = { ...this.get(), ...patch }; backend.write(KEYS.settings, next); return next; },
  // Current workspace (mode) the app is showing.
  workspace() { return this.get().workspace || 'internal'; },
  setWorkspace(ws) { return this.update({ workspace: ws }); },
};

// ── BLACKLIST REPOSITORY (shared "blackball" across both workspaces) ──────────
/**
 * A blacklisted person auto-drops to the "out" stage the moment their resume is
 * screened. Matching is by normalized email (strongest) or normalized full name.
 * Entry: { id, name, email, reason, addedAt }
 */
function normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
// Phone: keep digits only, and compare the last 10 (ignores country code / formatting).
function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
// Two contacts are the same person if EMAIL matches OR PHONE matches.
function sameContact(a, b) {
  const ae = normEmail(a.email), be = normEmail(b.email);
  if (ae && be && ae === be) return true;
  const ap = normPhone(a.phone), bp = normPhone(b.phone);
  if (ap && bp && ap === bp && ap.length >= 7) return true;
  return false;
}

export const Blacklist = {
  all() { return backend.read(KEYS.blacklist) || []; },
  add(data) {
    const list = this.all();
    const entry = {
      id: uid('BAN'),
      name: data.name || '',
      email: data.email || '',
      phone: data.phone || '',
      reason: data.reason || '',
      addedAt: new Date().toISOString(),
    };
    list.unshift(entry);
    backend.write(KEYS.blacklist, list);
    return entry;
  },
  remove(id) { backend.write(KEYS.blacklist, this.all().filter(e => e.id !== id)); },
  // Match a candidate against the blacklist by EMAIL or PHONE (people can share
  // a name). Name is only a fallback when neither side has contact info.
  match({ name, email, phone }) {
    const target = { email, phone };
    const byContact = this.all().find(b => sameContact(b, target));
    if (byContact) return byContact;
    if (!normEmail(email) && !normPhone(phone)) {
      const n = normName(name);
      return this.all().find(b => !b.email && !b.phone && n && normName(b.name) === n) || null;
    }
    return null;
  },
};

// ── COMPANIES REPOSITORY (staffing clients) ───────────────────────────────────
export const Companies = {
  all() { return (backend.read(KEYS.companies) || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')); },
  get(id) { return (backend.read(KEYS.companies) || []).find(c => c.id === id) || null; },
  name(id) { const c = this.get(id); return c ? c.name : ''; },
  create(data) {
    const list = backend.read(KEYS.companies) || [];
    const c = {
      id: uid('CO'),
      name: data.name || 'Untitled Company',
      industry: data.industry || '',
      contacts: data.contacts || [],
      notes: data.notes || '',
      createdAt: today(),
    };
    list.unshift(c);
    backend.write(KEYS.companies, list);
    return c;
  },
  update(id, patch) {
    const list = backend.read(KEYS.companies) || [];
    const i = list.findIndex(c => c.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    backend.write(KEYS.companies, list);
    return list[i];
  },
  remove(id) { backend.write(KEYS.companies, (backend.read(KEYS.companies) || []).filter(c => c.id !== id)); },
};

// ── PLACEMENTS REPOSITORY (staffing: active hires + money) ────────────────────
export const Placements = {
  all() { return backend.read(KEYS.placements) || []; },
  get(id) { return this.all().find(p => p.id === id) || null; },
  active() { return this.all().filter(p => p.status !== 'archived'); },
  create(data) {
    const list = this.all();
    const p = {
      id: uid('PL'),
      workerName: data.workerName || '',
      workerRole: data.workerRole || '',
      companyId: data.companyId || '',
      candidateId: data.candidateId || '',
      billRate: parseFloat(data.billRate) || 0,
      payRate: parseFloat(data.payRate) || 0,
      startDate: data.startDate || today(),
      status: 'active',
      createdAt: today(),
    };
    list.unshift(p);
    backend.write(KEYS.placements, list);
    return p;
  },
  update(id, patch) {
    const list = this.all();
    const i = list.findIndex(p => p.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    backend.write(KEYS.placements, list);
    return list[i];
  },
  archive(id) { return this.update(id, { status: 'archived', endDate: today() }); },
  remove(id) { backend.write(KEYS.placements, this.all().filter(p => p.id !== id)); },
  margin(p) { return (parseFloat(p.billRate) || 0) - (parseFloat(p.payRate) || 0); },
};
