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

const KEYS = {
  profiles: 'qrs_profiles',
  candidates: 'qrs_candidates',   // each candidate = one APPLICATION (person ↔ job)
  people: 'qrs_people',           // global PERSON records (the recycle anchor)
  settings: 'qrs_settings',
  stages: 'qrs_stages',
  blacklist: 'qrs_blacklist',     // global blackball list (all companies)
  companies: 'qrs_companies',     // staffing: client companies
  placements: 'qrs_placements',   // staffing: active hires
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
  // NOTE: settings (current workspace, AI toggle) are deliberately NOT synced —
  // they're per-device UI state, not shared data.
};

// Lazily-loaded sync deps (avoids a hard import cycle at module load).
let _wq = null, _rest = null;
async function wq() { if (!_wq) _wq = await import('./writeQueue.js'); return _wq; }
async function rest() { if (!_rest) _rest = await import('./sbRest.js'); return _rest; }

// ── STORAGE BACKEND (localStorage cache + write-through to Supabase) ──────────
const backend = {
  read(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },

  write(key, value) {
    const prev = this.read(key);
    localStorage.setItem(key, JSON.stringify(value));
    // Fire-and-forget sync so the UI stays instant (durable queue handles retries).
    this._sync(key, value, prev);
  },

  // Diff the new value against the previous and enqueue minimal Supabase writes.
  async _sync(key, value, prev) {
    const cfg = SYNC[key];
    if (!cfg) return;
    try {
      const { enqueueUpsert, enqueueDelete } = await wq();
      if (cfg.kind === 'kv') {
        enqueueUpsert('app_kv', [{ key: cfg.kvKey, value, updated_at: new Date().toISOString() }], `kv:${cfg.kvKey}`);
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
      const stamp = new Date().toISOString();
      for (const item of list) {
        const before = prevById[String(item.id)];
        if (!before || JSON.stringify(before) !== JSON.stringify(item)) {
          // Record a local revision time so the pull can do per-record
          // last-write-wins and never overwrite a fresher local edit.
          item._rev = stamp;
          changed.push({ id: String(item.id), data: item, updated_at: stamp });
        }
      }
      let touched = false;
      if (changed.length) {
        // Persist the _rev stamps we just set back into the local cache.
        localStorage.setItem(key, JSON.stringify(list));
        enqueueUpsert(cfg.table, changed, cfg.table);
        touched = true;
      }
      for (const old of prevList) {
        if (!nextIds.has(String(old.id))) { enqueueDelete(cfg.table, String(old.id), 'id', cfg.table); touched = true; }
      }
      if (touched) setSyncStatus({ status: 'syncing' });
    } catch (e) { console.warn('[sync] enqueue failed', e); }
  },

  // Pull all tables from Supabase into the local cache on boot. Protects any
  // records that still have pending (un-synced) local writes.
  async pullAll() {
    const r = await rest();
    const { pendingRecordIds } = await wq();
    const pend = pendingRecordIds();
    let ok = true;   // false if any table failed to fetch (so status shows a problem)
    for (const [lsKey, cfg] of Object.entries(SYNC)) {
      if (cfg.kind === 'kv') {
        const rows = await r.sbSelect('app_kv');
        if (rows === r.TABLE_MISSING) continue;            // table not created yet — skip quietly
        if (rows == null) { ok = false; continue; }
        const row = rows.find(x => x.key === cfg.kvKey);
        if (row && row.value != null) {
          localStorage.setItem(lsKey, JSON.stringify(row.value));
        } else {
          // No server row yet — push local up so it exists for other devices.
          const localVal = this.read(lsKey);
          if (localVal != null) {
            const { enqueueUpsert } = await wq();
            enqueueUpsert('app_kv', [{ key: cfg.kvKey, value: localVal, updated_at: new Date().toISOString() }], `kv:${cfg.kvKey}`);
          }
        }
        continue;
      }
      const rows = await r.sbSelect(cfg.table);
      if (rows === r.TABLE_MISSING) continue;            // table not created yet — skip quietly
      if (rows == null) { ok = false; continue; }        // fetch FAILED — keep cache, mark not-ok

      // SUPABASE IS THE ONLY SOURCE OF TRUTH. The cache is an exact mirror of the
      // server — no merge, no "local wins". The ONLY exception: a record with an
      // in-flight pending write (not yet uploaded) is preserved so you don't lose
      // the change you just made before it syncs. Everything else = server.
      const p = pend[cfg.table] || { upsert: new Set(), del: new Set() };
      const serverItems = rows.map(x => x.data).filter(Boolean);
      const serverIds = new Set(serverItems.map(x => String(x.id)));

      // First-run migration: server empty + we have un-synced local rows → push up.
      const localList = this.read(lsKey) || [];
      if (rows.length === 0 && localList.length && p.upsert.size === 0 && this._migrated !== lsKey) {
        // Only migrate once per key to avoid loops; mark it.
        const { enqueueUpsert } = await wq();
        enqueueUpsert(cfg.table, localList.map(x => ({ id: String(x.id), data: x, updated_at: new Date().toISOString() })), cfg.table);
      }

      // Mirror = server rows, plus any pending-upsert local rows not yet on server.
      const mirror = serverItems.slice();
      if (p.upsert.size) {
        const localById = {}; localList.forEach(x => { localById[String(x.id)] = x; });
        p.upsert.forEach(id => { if (localById[id] && !serverIds.has(id)) mirror.push(localById[id]); });
      }
      localStorage.setItem(lsKey, JSON.stringify(mirror));
    }
    return ok;
  },
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

// ── INIT ───────────────────────────────────────────────────────────────────
export function initDB() {
  if (backend.read(KEYS.profiles) == null) backend.write(KEYS.profiles, SEED_PROFILES);
  if (backend.read(KEYS.candidates) == null) backend.write(KEYS.candidates, []);
  if (backend.read(KEYS.settings) == null) backend.write(KEYS.settings, DEFAULT_SETTINGS);
  if (backend.read(KEYS.stages) == null) backend.write(KEYS.stages, DEFAULT_STAGES);

  // Migrate legacy candidates (old `status` field) to the stage pipeline.
  const cands = backend.read(KEYS.candidates) || [];
  let migrated = false;
  const legacyMap = { screened: 'screened', shortlisted: 'hr', rejected: 'rejected' };
  for (const c of cands) {
    if (!c.stage) {
      c.stage = legacyMap[c.status] || 'screened';
      c.stageHistory = c.stageHistory || [{ stage: c.stage, at: new Date().toISOString(), note: 'Imported from earlier version.' }];
      migrated = true;
    }
    // Retire the removed "Will Not Interview" stage → fold into Rejected.
    if (c.stage === 'no_interview') { c.stage = 'rejected'; migrated = true; }
  }
  if (migrated) backend.write(KEYS.candidates, cands);

  // Drop the retired stage from any saved stages list.
  const savedStages = backend.read(KEYS.stages);
  if (Array.isArray(savedStages) && savedStages.some(s => s.id === 'no_interview')) {
    backend.write(KEYS.stages, savedStages.filter(s => s.id !== 'no_interview'));
  }

  // Backfill threshold + workspace/company on older profiles that predate them.
  const profs = backend.read(KEYS.profiles) || [];
  let pMigrated = false;
  for (const p of profs) {
    if (p.threshold == null) { p.threshold = 60; pMigrated = true; }
    if (p.workspace == null) { p.workspace = 'internal'; pMigrated = true; }
    if (p.company == null) { p.company = p.workspace === 'internal' ? 'Vimenture' : ''; pMigrated = true; }
  }
  if (pMigrated) backend.write(KEYS.profiles, profs);

  if (backend.read(KEYS.blacklist) == null) backend.write(KEYS.blacklist, []);
  if (backend.read(KEYS.companies) == null) backend.write(KEYS.companies, []);
  if (backend.read(KEYS.placements) == null) backend.write(KEYS.placements, []);
  if (backend.read(KEYS.people) == null) backend.write(KEYS.people, []);

  // Migrate: ensure every candidate (application) is linked to a global Person.
  // Match existing people by email, else by name, else create a new Person.
  const allCands = backend.read(KEYS.candidates) || [];
  let people = backend.read(KEYS.people) || [];
  let peopleChanged = false, candsChanged = false;
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
    candsChanged = true;
  }
  if (peopleChanged) backend.write(KEYS.people, people);
  if (candsChanged) backend.write(KEYS.candidates, allCands);
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

// ── CLOUD SYNC BOOTSTRAP ──────────────────────────────────────────────────────
// Call once after initDB(). Pulls shared data from Supabase into the local cache,
// starts the durable write-queue worker, and polls periodically so other devices'
// changes appear. Safe no-op when Supabase isn't configured.
// ── SYNC STATUS (observable) ──────────────────────────────────────────────────
// status: 'synced' | 'syncing' | 'pending' | 'offline' | 'error' | 'local'
const _syncState = { status: 'local', pending: 0, lastSync: null };
const _syncListeners = new Set();
export function onSyncStatus(fn) { _syncListeners.add(fn); fn(_syncState); return () => _syncListeners.delete(fn); }
export function getSyncStatus() { return { ..._syncState }; }
function setSyncStatus(patch) { Object.assign(_syncState, patch); _syncListeners.forEach(fn => { try { fn(_syncState); } catch {} }); }

let _syncing = false;
let _onPulledCb = null;

// Hard reset: wipe the local cache for all synced tables and re-pull from
// Supabase (source of truth). Also clears any stale write-queue. Use this when a
// device is out of sync. Returns the fresh candidate count.
export async function forceResync() {
  const { isConfigured } = await import('../auth/supabaseClient.js');
  if (!isConfigured()) return null;
  const { drainQueue, hasPendingWrites } = await import('./writeQueue.js');
  setSyncStatus({ status: 'syncing' });
  // Push any pending local writes first so we don't lose them, THEN wipe the
  // cache and mirror the server. (We do NOT delete the queue — pending writes
  // are preserved and reconciled by pullAll.)
  try { await drainQueue(); } catch {}
  try { for (const lsKey of Object.keys(SYNC)) localStorage.removeItem(lsKey); } catch {}
  const ok = await backend.pullAll();
  const pending = hasPendingWrites();
  setSyncStatus({ status: !ok ? 'error' : (pending ? 'pending' : 'synced'), lastSync: new Date().toISOString() });
  if (_onPulledCb) _onPulledCb();
  const n = (backend.read(KEYS.candidates) || []).length;
  console.log('[sync] forceResync complete — candidates now:', n);
  return n;
}

// Run one full sync cycle: push the queue, then pull from Supabase (source of
// truth). Updates the status signal throughout. Safe to call manually.
export async function syncNow() {
  const { isConfigured } = await import('../auth/supabaseClient.js');
  if (!isConfigured()) { setSyncStatus({ status: 'local' }); return; }
  if (_syncing) return;
  _syncing = true;
  const { drainQueue, hasPendingWrites, queueStatus } = await import('./writeQueue.js');
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setSyncStatus({ status: 'offline', pending: queueStatus().pending });
      return;
    }
    setSyncStatus({ status: 'syncing' });
    await drainQueue();                       // push local changes up first
    const ok = await backend.pullAll();       // then mirror server down
    const pending = queueStatus().pending;
    if (!ok) setSyncStatus({ status: 'error', pending });
    else if (pending > 0 || hasPendingWrites()) setSyncStatus({ status: 'pending', pending });
    else setSyncStatus({ status: 'synced', pending: 0, lastSync: new Date().toISOString() });
    if (_onPulledCb) _onPulledCb();
  } catch (e) {
    console.warn('[sync] cycle failed', e);
    setSyncStatus({ status: 'error' });
  } finally {
    _syncing = false;
  }
}

export async function initCloudSync(onPulled) {
  const { isConfigured } = await import('../auth/supabaseClient.js');
  if (!isConfigured()) { setSyncStatus({ status: 'local' }); return; }
  _onPulledCb = onPulled;
  const { startQueueWorker } = await import('./writeQueue.js');
  startQueueWorker(5000);
  await syncNow();                            // initial sync
  setInterval(syncNow, 15000);                // periodic source-of-truth refresh
  if (typeof window !== 'undefined') window.addEventListener('online', syncNow);
}

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
