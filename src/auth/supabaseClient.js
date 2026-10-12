/**
 * SUPABASE CONFIG (static-site friendly)
 * ------------------------------------------------------------------
 * Reads the public Supabase URL + anon key from window.APP_CONFIG, which is
 * injected by public/config.js. Both values are safe to expose to the browser.
 *
 * We talk to Supabase over its REST API directly (same pattern as the other
 * tools) — no SDK, no bundler needed. If config is absent, isConfigured() is
 * false and the app can run in local mode.
 */
let _config = null;

export function loadConfig() {
  if (_config) return Promise.resolve(_config);
  const w = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : {};
  _config = {
    supabaseUrl: (w.supabaseUrl || '').replace(/\/+$/, ''),
    supabaseAnonKey: w.supabaseAnonKey || '',
  };
  return Promise.resolve(_config);
}

export function getConfig() { return _config || { supabaseUrl: '', supabaseAnonKey: '' }; }
export function isConfigured() { const c = getConfig(); return !!(c.supabaseUrl && c.supabaseAnonKey); }
