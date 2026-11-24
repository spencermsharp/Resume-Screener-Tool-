/**
 * ACTIVITY LOG rows (public.audit_log) — pure helpers, no I/O.
 * db.js builds one row per created/updated/deleted record when it syncs, and
 * auth.js one per sign-in/out and user change. Both send them through the
 * durable write queue as plain INSERTs.
 */

export const AUDIT_TABLE = 'audit_log';

// Keys that never count as a change on their own.
const NOISE = new Set(['_rev']);

// Top-level keys whose value differs between two records (ignoring _rev).
export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter(k => !NOISE.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}

// Candidates carry the full resume text: never store it. On updates keep only
// the changed fields (plus id/name/stage) so rows stay small.
function slimCandidate(rec, keys) {
  if (!rec) return null;
  const out = {};
  const pick = keys ? new Set([...keys, 'id', 'name', 'stage']) : null;
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'rawText' || NOISE.has(k)) continue;
    if (pick && !pick.has(k)) continue;
    out[k] = v;
  }
  return out;
}
function copyOf(rec) {
  if (!rec) return null;
  const { _rev, ...rest } = rec;
  return JSON.parse(JSON.stringify(rest));
}

const labelOf = r => r && (r.name || r.role || r.workerName || r.email || r.id) || '';
const NOUN = { candidates: 'candidate', positions: 'position', people: 'person', companies: 'company', placements: 'placement', blacklist: 'blackball entry' };
const clip = (s, n = 60) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Short human text for an update, e.g. "moved stage Screened → HR Interview".
function updateSummary(table, b, a, keys, stageLabel) {
  const bits = [];
  const has = k => keys.includes(k);
  if (has('stage')) bits.push(`moved stage ${stageLabel(b.stage)} → ${stageLabel(a.stage)}`);
  if (has('notes')) {
    const bn = Array.isArray(b.notes) ? b.notes.length : 0, an = Array.isArray(a.notes) ? a.notes.length : 0;
    bits.push(an > bn ? `added note: "${clip(a.notes[an - 1]?.text)}"` : 'edited notes');
  }
  if (has('rejectReason') && a.rejectReason) bits.push(`reason: ${a.rejectReason}`);
  if (has('name')) bits.push(`edited name "${clip(b.name, 40)}" → "${clip(a.name, 40)}"`);
  if (has('parsed') || has('email') || has('phone')) bits.push('edited details');
  if (has('result')) bits.push(`re-screened${a.result?.score != null ? ` (score ${Math.round(a.result.score)}%)` : ''}`);
  if (has('status') && table === 'positions') bits.push(a.status === 'archived' ? 'archived position' : a.status === 'open' ? 'reopened position' : `status ${a.status}`);
  else if (has('status')) bits.push(`status ${b.status || '—'} → ${a.status || '—'}`);
  const covered = new Set(['stage', 'stageHistory', 'notes', 'rejectReason', 'name', 'parsed', 'email', 'phone', 'result', 'status', 'archivedAt', 'endDate']);
  const rest = keys.filter(k => !covered.has(k));
  if (rest.length) bits.push(`updated ${rest.join(', ')}`);
  return bits.join('; ') || 'updated';
}

/**
 * Audit rows for one synced collection write.
 *   table      Supabase table (= entity)
 *   prevById   { id: previous record }
 *   list       the new records
 *   removed    previous records that are gone
 *   stageLabel id → label
 */
export function collectionAuditRows(table, prevById, list, removed, user, stageLabel = s => s || '—') {
  const rows = [];
  const cand = table === 'candidates';
  const noun = NOUN[table] || table;
  for (const item of list) {
    const id = String(item.id);
    const before = prevById[id];
    if (!before) {
      const summary = table === 'blacklist' ? `blackballed ${labelOf(item)}` : `added ${noun} ${labelOf(item)}`;
      rows.push(auditRow(user, { action: 'create', entity: table, entityId: id, summary, before: null, after: cand ? slimCandidate(item) : copyOf(item) }));
      continue;
    }
    const keys = changedKeys(before, item);
    if (!keys.length) continue;
    rows.push(auditRow(user, {
      action: 'update', entity: table, entityId: id,
      summary: `${labelOf(item)}: ${updateSummary(table, before, item, keys, stageLabel)}`,
      before: cand ? slimCandidate(before, keys) : copyOf(before),
      after: cand ? slimCandidate(item, keys) : copyOf(item),
    }));
  }
  for (const old of removed) {
    const summary = table === 'blacklist' ? `removed ${labelOf(old)} from blackball` : `deleted ${noun} ${labelOf(old)}`;
    rows.push(auditRow(user, { action: 'delete', entity: table, entityId: String(old.id), summary, before: cand ? slimCandidate(old) : copyOf(old), after: null }));
  }
  return rows;
}

// Audit row for a key/value setting (hiring stages, AI on/off).
export function kvAuditRow(kvKey, prev, value, user) {
  if (JSON.stringify(prev ?? null) === JSON.stringify(value ?? null)) return null;
  let summary = `changed ${kvKey}`;
  if (kvKey === 'stages') summary = 'edited hiring stages';
  if (kvKey === 'ai_config') {
    const strip = v => { const { updatedAt, updatedBy, ...r } = v || {}; return JSON.stringify(r); };
    if (strip(prev) === strip(value)) return null;    // only the stamp moved
    summary = !!prev?.enabled !== !!value?.enabled ? `AI screening turned ${value?.enabled ? 'on' : 'off'}` : 'changed AI settings';
  }
  return auditRow(user, { action: prev == null ? 'create' : 'update', entity: 'app_kv', entityId: kvKey, summary, before: prev ?? null, after: value ?? null });
}

export function auditRow(user, { action, entity, entityId = null, summary = '', before = null, after = null }) {
  return {
    at: new Date().toISOString(),
    user_id: user ? String(user.id || '') || null : 'system',
    user_name: user ? (user.name || user.username || '') : 'system',
    action, entity, entity_id: entityId, summary, before, after,
  };
}

// The app_users fields safe to log (never passwords).
export function safeUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, name: u.name, role: u.role, status: u.status || 'active' };
}
