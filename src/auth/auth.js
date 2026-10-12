/**
 * AUTH — session, role, and in-app user management.
 * ------------------------------------------------------------------
 * Two modes:
 *   - Supabase configured  → real email/password auth + roles from `profiles`.
 *   - Not configured (local dev) → a single local "admin" so the app runs
 *     with no login wall. This keeps localhost development frictionless.
 *
 * Roles: 'admin' | 'user'. Admin's only extra power is managing users.
 */
import { loadConfig, isConfigured, getClient } from './supabaseClient.js';

const state = {
  ready: false,
  user: null,     // { id, email, name, role }
};

export async function initAuth() {
  await loadConfig();
  if (!isConfigured()) {
    // Local dev — no login wall; treat the local operator as admin.
    state.user = { id: 'local', email: 'local@localhost', name: 'Local Admin', role: 'admin' };
    state.ready = true;
    return state.user;
  }
  const sb = await getClient();
  const { data } = await sb.auth.getSession();
  if (data && data.session) {
    await loadProfile(sb, data.session.user);
  }
  state.ready = true;
  return state.user;
}

async function loadProfile(sb, authUser) {
  let role = 'user', name = authUser.email;
  try {
    const { data: prof } = await sb.from('profiles').select('name, role').eq('id', authUser.id).single();
    if (prof) { role = prof.role || 'user'; name = prof.name || name; }
  } catch { /* profile may not exist yet */ }
  state.user = { id: authUser.id, email: authUser.email, name, role };
  return state.user;
}

export function currentUser() { return state.user; }
export function isAuthed() { return !!state.user; }
export function isAdmin() { return !!state.user && state.user.role === 'admin'; }
export function needsLogin() { return isConfigured() && !state.user; }

export async function signIn(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  await loadProfile(sb, data.user);
  return state.user;
}

export async function signOut() {
  if (isConfigured()) {
    const sb = await getClient();
    await sb.auth.signOut();
  }
  state.user = null;
}

export async function changeOwnPassword(newPassword) {
  if (!isConfigured()) throw new Error('Not available in local mode.');
  const sb = await getClient();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
  return true;
}

// ── Admin: call the admin-users Edge Function (service role lives server-side) ─
async function adminCall(action, payload = {}) {
  if (!isConfigured()) throw new Error('User management requires the cloud (Supabase) setup.');
  const sb = await getClient();
  const { data: sess } = await sb.auth.getSession();
  const token = sess?.session?.access_token;
  const { data, error } = await sb.functions.invoke('admin-users', {
    body: { action, ...payload },
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (error) throw new Error(error.message || 'Request failed');
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const Users = {
  list()                               { return adminCall('list').then(r => r.users || []); },
  create({ email, password, name, role }) { return adminCall('create', { email, password, name, role }); },
  resetPassword(userId, newPassword)   { return adminCall('resetPassword', { userId, newPassword }); },
  setRole(userId, role)                { return adminCall('setRole', { userId, role }); },
  remove(userId)                       { return adminCall('delete', { userId }); },
};
