/**
 * DURABLE WRITE QUEUE (ported from the battle-tested Qualis pattern).
 * Every Supabase write is recorded in a persistent localStorage queue. A worker
 * drains it and only removes an op once the DB confirms success — so data can
 * never be stuck "local only" (worst case: pending, will sync). Permanent (4xx)
 * failures go to a dead-letter instead of blocking the queue forever.
 */
import { sbUpsert, sbDelete, sbInsert } from './sbRest.js';

const QUEUE_KEY = 'rst_write_queue';
const DEAD_KEY = 'rst_write_deadletter';
const MAX_ATTEMPTS_BEFORE_ALERT = 3;

let draining = null;   // in-flight drain promise (null when idle)
const listeners = new Set();

function loadQueue() {
  const raw = localStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try { const p = JSON.parse(raw); if (!Array.isArray(p)) throw 0; return p; }
  catch (e) { try { localStorage.setItem(`${QUEUE_KEY}_corrupt_${Date.now()}`, raw); } catch {} return []; }
}
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function loadDead() { try { const p = JSON.parse(localStorage.getItem(DEAD_KEY)); return Array.isArray(p) ? p : []; } catch { return []; } }
function saveDead(d) { localStorage.setItem(DEAD_KEY, JSON.stringify(d)); }
function pushDead(op, res) {
  const d = loadDead();
  d.push({ ...op, failedAt: new Date().toISOString(), status: res.status, lastError: res.error || 'Permanent failure' });
  saveDead(d);
  console.error(`[queue] dead-letter (HTTP ${res.status}): ${op.label}`, res.error);
}
function uid() { return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function statusSnapshot() {
  const q = loadQueue();
  const failing = q.filter(op => op.attempts >= MAX_ATTEMPTS_BEFORE_ALERT);
  const dead = loadDead();
  return { pending: q.length, failing: failing.length, failingOps: failing, deadLetter: dead.length, deadLetterOps: dead };
}
function notify() { const s = statusSnapshot(); listeners.forEach(fn => { try { fn(s); } catch {} }); }
export function queueStatus() { return statusSnapshot(); }
export function retryDeadLetter() { return retryDeadLetterWhere(() => true); }
// Move only the dead-letter ops matching `pred` back into the queue (e.g. ops
// that failed with 404 because their table didn't exist yet). Returns how many
// ops were moved.
export function retryDeadLetterWhere(pred) {
  const d = loadDead(); if (!d.length) return 0;
  const move = d.filter(op => { try { return pred(op); } catch { return false; } });
  if (!move.length) return 0;
  const keep = d.filter(op => !move.includes(op));
  const q = loadQueue();
  move.forEach(op => {
    const { failedAt, status, ...rest } = op;
    q.push({ ...rest, attempts: 0, lastError: null });
  });
  saveQueue(q); saveDead(keep); notify(); drainQuietly();
  return move.length;
}

export function enqueue(op) {
  const q = loadQueue();
  q.push({ id: uid(), attempts: 0, lastError: null, queuedAt: new Date().toISOString(), ...op });
  saveQueue(q); notify(); drainQuietly();
}
export function enqueueUpsert(table, rows, label) { if (rows && rows.length) enqueue({ type: 'upsert', table, rows, label: label || table }); }
export function enqueueDelete(table, id, col = 'id', label) { enqueue({ type: 'delete', table, id, col, label: label || `${table}/${id}` }); }
// Append-only rows (audit_log): plain INSERT, never merged, never overlaid by a pull.
export function enqueueInsert(table, rows, label) { if (rows && rows.length) enqueue({ type: 'insert', table, rows, label: label || table }); }

function opKey(op) {
  if (op.type === 'delete') return `${op.table}|${op.id}`;
  if (op.type === 'insert') return `${op.table}|${op.id}`;   // independent: never blocks other ops
  const id = op.rows && op.rows[0] && (op.rows[0].id ?? op.rows[0].key);
  return `${op.table}|${id}`;
}
async function attempt(op) {
  try {
    if (op.type === 'upsert') return await sbUpsert(op.table, op.rows);
    if (op.type === 'delete') return await sbDelete(op.table, op.id, op.col);
    if (op.type === 'insert') return await sbInsert(op.table, op.rows);
    return { ok: true };
  } catch (e) { return { ok: false, permanent: false, error: e.message }; }
}

// If a drain is already running, callers get THAT promise, so
// `await drainQueue()` really waits for the in-flight upload to finish.
export function drainQueue() {
  if (draining) return draining;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve();
  draining = runDrain().finally(() => { draining = null; });
  return draining;
}

async function runDrain() {
  const order = loadQueue().map(o => o.id);
  const blocked = new Set();
  for (const opId of order) {
    let q = loadQueue();
    const op = q.find(o => o.id === opId);
    if (!op) continue;
    const key = opKey(op);
    if (blocked.has(key)) continue;           // preserve per-record order
    const res = await attempt(op);
    q = loadQueue();
    const idx = q.findIndex(o => o.id === opId);
    if (idx < 0) continue;
    if (res.ok) { q.splice(idx, 1); saveQueue(q); notify(); }
    // Dead-letter first, then drop from the queue: if storage is full the op
    // stays queued instead of being lost between the two saves.
    else if (res.permanent) { pushDead(q[idx], res); q.splice(idx, 1); saveQueue(q); notify(); }
    else { q[idx].attempts = (q[idx].attempts || 0) + 1; q[idx].lastError = res.error; saveQueue(q); notify(); blocked.add(key); }
  }
}

let worker = null;
const drainQuietly = () => drainQueue().catch(e => console.warn('[queue] drain failed', e));
export function startQueueWorker(ms = 5000) {
  if (worker) clearInterval(worker);
  worker = setInterval(drainQuietly, ms);
  if (typeof window !== 'undefined') window.addEventListener('online', drainQuietly);
  drainQuietly();
}
export function hasPendingWrites() { return loadQueue().length > 0; }

// Record ids still waiting to upload, grouped by table — so a background pull
// never overwrites local work that hasn't finished syncing.
export function pendingRecordIds() {
  const map = {};
  const add = op => {
    if (!op.table) return;
    if (!map[op.table]) map[op.table] = { upsert: new Set(), del: new Set() };
    if (op.type === 'upsert') (op.rows || []).forEach(r => { const k = r && (r.id ?? r.key); if (k != null) map[op.table].upsert.add(String(k)); });
    else if (op.type === 'delete' && op.id != null) map[op.table].del.add(String(op.id));
  };
  loadQueue().forEach(add); loadDead().forEach(add);
  return map;
}

// Every op that hasn't reached the server (dead-letter + queue), oldest first,
// so the pull can overlay the pending row data on top of the server copy.
export function pendingOps() {
  const all = [...loadDead(), ...loadQueue()];
  return all.sort((a, b) => String(a.queuedAt || '').localeCompare(String(b.queuedAt || '')));
}
