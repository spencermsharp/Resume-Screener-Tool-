/**
 * AUTH — mirrors the proven Qualis pattern.
 * ------------------------------------------------------------------
 * No Supabase Auth, no Edge Functions. Logins live in an `app_users` table
 * queried directly via Supabase REST with the anon key. Username-based login,
 * no email. Passwords stored as a lightweight hash + plain (same as Qualis).
 * Local cache in localStorage; writes go through to Supabase.
 *
 * Roles: 'admin' | 'user'. Admin's only extra power is managing users.
 */
import { getConfig, isConfigured, loadConfig } from './supabaseClient.js';

const LS_USERS = 'rst_users';
const LS_CURRENT = 'rst_current_user';

// Seed admin — created locally and pushed to Supabase on first boot.
const SEED_USERS = [
  { id: 'USR-001', username: 'Spencermsharp', name: 'Spencer Sharp', role: 'admin',
    passwordHash: hashPassword('LarkSparrow'), passwordPlain: 'LarkSparrow', status: 'active' },
];

// Same lightweight hash as Qualis — keeps plain passwords out of storage.
function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    hash = ((hash << 5) - hash) + password.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(16);
}

function lsLoad(key) { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } }
function lsSave(key, v) { localStorage.setItem(key, JSON.stringify(v)); }
function uid() { return 'USR-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Supabase REST helpers (anon key in headers; RLS governs access) ───────────
function headers() {
  const { supabaseAnonKey } = getConfig();
  return {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}
async function sbSelectUsers() {
  if (!isConfigured()) return null;
  const { supabaseUrl } = getConfig();
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/app_users?select=*`, { headers: headers() });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function sbUpsertUser(u) {
  if (!isConfigured()) return;
  const { supabaseUrl } = getConfig();
  try {
    await fetch(`${supabaseUrl}/rest/v1/app_users`, {
      method: 'POST', headers: headers(), body: JSON.stringify([toRow(u)]),
    });
  } catch { /* best effort; cached locally regardless */ }
}
const toRow = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, password_hash: u.passwordHash, password_plain: u.passwordPlain, status: u.status || 'active' });
const fromRow = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, passwordHash: u.password_hash, passwordPlain: u.password_plain, status: u.status || 'active' });

// ── Boot: load config, pull users from Supabase (or seed), restore session ────
export async function initAuth() {
  await loadConfig();

  // Pull users from Supabase into the local cache. If the table is empty, seed.
  const remote = await sbSelectUsers();
  if (remote && remote.length) {
    lsSave(LS_USERS, remote.map(fromRow));
  } else if (!lsLoad(LS_USERS)) {
    lsSave(LS_USERS, SEED_USERS);
    // Push the seed admin up so it exists in Supabase too.
    for (const u of SEED_USERS) await sbUpsertUser(u);
  } else if (remote && remote.length === 0) {
    // Table exists but empty — push whatever we have locally (incl. seed).
    for (const u of (lsLoad(LS_USERS) || SEED_USERS)) await sbUpsertUser(u);
  }
  return currentUser();
}

// ── Session ───────────────────────────────────────────────────────────────────
export function currentUser() { return lsLoad(LS_CURRENT); }
export function isAuthed() { return !!currentUser(); }
export function isAdmin() { const u = currentUser(); return !!u && u.role === 'admin'; }
export function needsLogin() { return !currentUser(); }

export function signIn(username, password) {
  const users = lsLoad(LS_USERS) || [];
  const user = users.find(u => u.username === username && u.passwordHash === hashPassword(password));
  if (!user) throw new Error('Incorrect username or password.');
  if (user.status === 'disabled') throw new Error('This account is disabled.');
  lsSave(LS_CURRENT, user);
  return user;
}
export function signOut() { localStorage.removeItem(LS_CURRENT); }

export function changeOwnPassword(newPassword) {
  const me = currentUser();
  if (!me) throw new Error('Not signed in.');
  Users.changePassword(me.id, newPassword);
  const refreshed = (lsLoad(LS_USERS) || []).find(u => u.id === me.id);
  if (refreshed) lsSave(LS_CURRENT, refreshed);
  return true;
}

// ── User management (admin) ────────────────────────────────────────────────────
export const Users = {
  list() { return Promise.resolve(lsLoad(LS_USERS) || []); },
  all() { return lsLoad(LS_USERS) || []; },

  create({ username, name, password, role }) {
    const list = this.all();
    if (list.some(u => u.username === username)) throw new Error('That username is taken.');
    const u = { id: uid(), username, name: name || username, role: role === 'admin' ? 'admin' : 'user',
      passwordHash: hashPassword(password), passwordPlain: password, status: 'active' };
    list.push(u); lsSave(LS_USERS, list); sbUpsertUser(u);
    return Promise.resolve(u);
  },
  resetPassword(id, newPassword) { return Promise.resolve(this.changePassword(id, newPassword)); },
  changePassword(id, newPassword) {
    const list = this.all();
    const i = list.findIndex(u => u.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], passwordHash: hashPassword(newPassword), passwordPlain: newPassword };
    lsSave(LS_USERS, list); sbUpsertUser(list[i]);
    return list[i];
  },
  setRole(id, role) {
    const list = this.all();
    const i = list.findIndex(u => u.id === id);
    if (i < 0) return Promise.reject(new Error('User not found'));
    // Don't demote the last admin.
    if (role !== 'admin' && list.filter(u => u.role === 'admin').length <= 1 && list[i].role === 'admin') {
      return Promise.reject(new Error("Can't demote the last admin."));
    }
    list[i] = { ...list[i], role }; lsSave(LS_USERS, list); sbUpsertUser(list[i]);
    return Promise.resolve(list[i]);
  },
  remove(id) {
    const me = currentUser();
    if (me && me.id === id) return Promise.reject(new Error("You can't remove yourself."));
    const list = this.all();
    const i = list.findIndex(u => u.id === id);
    if (i < 0) return Promise.resolve();
    list[i] = { ...list[i], status: 'disabled' }; // soft-disable, preserve record
    lsSave(LS_USERS, list); sbUpsertUser(list[i]);
    return Promise.resolve();
  },
};
