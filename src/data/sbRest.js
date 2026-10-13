/**
 * SUPABASE REST — low-level helpers (mirrors the proven Qualis pattern).
 * Direct PostgREST calls with the anon key. Our data tables use a simple
 * { id/key, data/value jsonb } shape, so one set of helpers serves them all.
 */
import { getConfig, isConfigured } from '../auth/supabaseClient.js';

function headers() {
  const { supabaseAnonKey } = getConfig();
  return {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}

// 4xx (except 408/429) = permanent (bad request / RLS) — don't blind-retry.
function isPermanentStatus(s) { return s >= 400 && s < 500 && s !== 408 && s !== 429; }

// Sentinel returned when a table doesn't exist yet (404) — callers skip it
// quietly instead of treating it as a sync failure.
export const TABLE_MISSING = Symbol('table_missing');

// Select all rows from a table. Returns an array on success, TABLE_MISSING if
// the table doesn't exist (404), or null on any other failure (so callers never
// overwrite local data with a partial/failed read).
export async function sbSelect(table) {
  if (!isConfigured()) return null;
  const { supabaseUrl } = getConfig();
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*`, { headers: headers() });
    if (r.status === 404) { console.warn(`[sb] table '${table}' not found (run the schema)`); return TABLE_MISSING; }
    if (!r.ok) { console.error(`[sb] select ${table} failed ${r.status}`); return null; }
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch (e) { console.error(`[sb] select ${table} error`, e); return null; }
}

export async function sbUpsert(table, rows) {
  if (!isConfigured()) return { ok: false, permanent: false, error: 'not configured' };
  if (!rows || !rows.length) return { ok: true };
  const { supabaseUrl } = getConfig();
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const err = await r.text();
      return { ok: false, status: r.status, permanent: isPermanentStatus(r.status), error: err };
    }
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, permanent: false, error: e.message }; }
}

export async function sbDelete(table, id, col = 'id') {
  if (!isConfigured()) return { ok: false, permanent: false, error: 'not configured' };
  const { supabaseUrl } = getConfig();
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}?${col}=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: headers(),
    });
    if (!r.ok) {
      const err = await r.text();
      return { ok: false, status: r.status, permanent: isPermanentStatus(r.status), error: err };
    }
    return { ok: true, status: r.status };
  } catch (e) { return { ok: false, permanent: false, error: e.message }; }
}
