/**
 * SUPABASE CLIENT (lazy, config-driven)
 * ------------------------------------------------------------------
 * Config comes from /api/config (served by Flask from env vars), so the
 * anon key is injected at runtime — never hardcoded in source.
 *
 * If Supabase isn't configured (local dev with no env), `isConfigured()`
 * returns false and the app runs in local no-auth mode. Once env vars are
 * set (Railway/production), the same code path uses real auth.
 */
let _client = null;
let _config = null;
let _configPromise = null;

// Load config. Static-site friendly: reads window.APP_CONFIG injected by
// public/config.js (the Supabase URL + anon key — both safe to expose).
// Falls back to the Flask /api/config if present (local dev with the server).
export function loadConfig() {
  if (_configPromise) return _configPromise;
  const fromWindow = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : null;
  if (fromWindow && fromWindow.supabaseUrl) {
    _config = fromWindow;
    _configPromise = Promise.resolve(_config);
    return _configPromise;
  }
  _configPromise = fetch('/api/config')
    .then(r => r.ok ? r.json() : {})
    .then(cfg => { _config = cfg || fromWindow || {}; return _config; })
    .catch(() => { _config = fromWindow || {}; return _config; });
  return _configPromise;
}

export function getConfig() { return _config || {}; }
export function isConfigured() { return !!(_config && _config.supabaseUrl && _config.supabaseAnonKey); }

// Lazily import the Supabase SDK from CDN only when actually configured.
export async function getClient() {
  if (!isConfigured()) return null;
  if (_client) return _client;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  _client = createClient(_config.supabaseUrl, _config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'rst_auth' },
  });
  return _client;
}
