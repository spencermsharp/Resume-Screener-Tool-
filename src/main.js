// ── APP SHELL — Kruew + Vimenture/Qualis Hiring Platform ─────────────────────
import { initDB, initCloudSync, syncNow, forceResync, retryFailedWrites, onSyncStatus, getSyncStatus, Settings, WORKSPACES } from './data/db.js';
import { el } from './utils.js';
import { renderDashboard } from './views/dashboard.js';
import { renderProfiles } from './views/profiles.js';
import { renderUpload } from './views/upload.js';
import { renderResults, renderCandidate } from './views/results.js';
import { renderStages } from './views/stages.js';
import { renderBlacklist } from './views/blacklist.js';
import { renderCompanies } from './views/companies.js';
import { renderPlacements } from './views/placements.js';
import { renderFutureFit } from './views/futurefit.js';
import { renderTeam } from './views/team.js';
import { renderActivity } from './views/activity.js';
import { renderLogin } from './views/login.js';
import { initAuth, needsLogin, isAdmin, isAuthed, currentUser, signOut } from './auth/auth.js';
import { isConfigured } from './auth/supabaseClient.js';

initDB();

const app = document.getElementById('app');

// Workspace tabs — scoped to the current company (Internal or Kruew).
const CORE_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'profiles',  label: 'Job Positions' },
  { id: 'upload',    label: 'Upload & Screen' },
  { id: 'results',   label: 'Results' },
];
// Tabs only Kruew Staffing shows (the revenue/CRM layer).
const STAFFING_TABS = [
  { id: 'companies',  label: 'Companies' },
  { id: 'placements', label: 'Placements' },
];
// GLOBAL tabs — shared across ALL companies (not scoped to a workspace).
const GLOBAL_TABS = [
  { id: 'futurefit', label: '♻️ Future Fit' },
  { id: 'blacklist', label: '⛔ Blackball' },
  { id: 'stages',    label: 'Hiring Stages' },
];

function tabsForWorkspace(ws) {
  const base = ws === 'staffing' ? [...CORE_TABS, ...STAFFING_TABS] : [...CORE_TABS];
  return base;
}
function globalTabs() {
  const t = [...GLOBAL_TABS];
  t.push(isAdmin() ? { id: 'team', label: 'Team' } : { id: 'team', label: 'Account' });
  if (isAdmin()) t.push({ id: 'activity', label: 'Activity' });
  return t;
}
// All valid tab ids for the current workspace (for route validation).
function allTabIds(ws) { return [...tabsForWorkspace(ws), ...globalTabs()].map(t => t.id); }

let current = 'dashboard';
let currentArg = undefined;

// navigate(route, arg?) — the routing contract every view uses.
function navigate(route, arg) {
  current = route;
  currentArg = arg;
  render(arg);
}

function viewFor(route, arg) {
  switch (route) {
    case 'dashboard':  return renderDashboard(navigate);
    case 'profiles':   return renderProfiles(navigate, arg);     // arg = profileId | 'new'
    case 'upload':     return renderUpload(navigate);
    case 'results':    return renderResults(navigate, arg);      // arg = profileId
    case 'candidate':  return renderCandidate(navigate, arg);    // arg = candidateId
    case 'futurefit':  return renderFutureFit(navigate);
    case 'companies':  return renderCompanies(navigate, arg);
    case 'placements': return renderPlacements(navigate, arg);
    case 'blacklist':  return renderBlacklist(navigate);
    case 'stages':     return renderStages(navigate);
    case 'team':       return renderTeam(navigate);
    case 'activity':   return renderActivity(navigate);
    default:           return renderDashboard(navigate);
  }
}

// Which top tab should appear active (candidate detail lives under Results).
function activeTabFor(route) {
  if (route === 'candidate') return 'results';
  return route;
}

// Paint the sync status chip in place (no full re-render — never disruptive).
// Failures win over everything else: writes the server rejected (dead-letter),
// writes that keep failing, and writes that couldn't even be queued.
const CHIP_HELP = 'Click: sync now · Double-click: force full re-sync';
function paintSyncChip(chip, st) {
  const map = {
    synced:  ['✓ Synced', 'sc-ok'],
    syncing: ['⟳ Syncing…', 'sc-busy'],
    pending: [`↑ ${st.pending || ''} pending`, 'sc-pending'],
    offline: ['⚠ Offline', 'sc-off'],
    error:   ['⚠ Sync error', 'sc-err'],
    local:   ['Local only', 'sc-off'],
  };
  let [label, cls] = map[st.status] || map.local;
  const lines = [];
  const opLine = o => `• ${o.label || o.table}${o.status ? ` (HTTP ${o.status})` : ''}${o.lastError ? `: ${o.lastError.slice(0, 160)}` : ''}`;
  if (st.writeError) lines.push(st.writeError);
  else if (st.status === 'error' && st.error) lines.push(st.error);
  if (st.deadLetter > 0) {
    label = `⚠ ${st.deadLetter} failed to save`; cls = 'sc-err';
    lines.push(`${st.deadLetter} change(s) were rejected by the server and are NOT saved:`, ...(st.deadLetterOps || []).slice(0, 8).map(opLine));
  } else if (st.failing > 0) {
    label = `⚠ ${st.failing} not saving`; cls = 'sc-err';
    lines.push(`${st.failing} change(s) keep failing to upload (still retrying):`, ...(st.failingOps || []).slice(0, 8).map(opLine));
  }
  if (st.writeError && st.deadLetter === 0 && !st.failing) { label = '⚠ Changes not saved'; cls = 'sc-err'; }
  const failed = st.deadLetter > 0 || !!st.writeError;
  lines.push(failed ? 'Click: retry failed changes · Double-click: force full re-sync' : CHIP_HELP);
  chip.className = `sync-chip ${cls}`;
  chip.textContent = label;
  chip.title = lines.join('\n');
}

// Re-render the current view after a background pull brought in new data —
// but never while the user is typing, has a modal open, or is mid-upload.
// A skipped refresh is retried after the next pull.
let refreshPending = false;
function userIsBusy() {
  if (current === 'upload') return true;
  if (document.querySelector('.modal-overlay.is-open')) return true;
  const a = document.activeElement;
  if (a && a.matches && a.matches('input, textarea, select, [contenteditable="true"]')) return true;
  // Typed text that hasn't been saved yet (field no longer focused).
  for (const f of app.querySelectorAll('input, textarea')) {
    if (f.type === 'checkbox' || f.type === 'radio' || f.type === 'file') continue;
    if (f.value !== f.defaultValue) return true;
  }
  return false;
}
function onBackgroundPull({ changed } = {}) {
  if (changed) refreshPending = true;
  if (!refreshPending || needsLogin() || userIsBusy()) return;
  refreshPending = false;
  const y = window.scrollY;
  render(currentArg);
  window.scrollTo(0, y);
}

function render(arg) {
  app.innerHTML = '';

  // Login wall (cloud mode only). Local dev skips this. On successful login,
  // pull server data BEFORE showing the app so the first screen is server-truth.
  if (needsLogin()) {
    app.appendChild(renderLogin(async () => {
      current = 'dashboard';
      app.innerHTML = '<div class="main-content"><div class="card"><p class="muted">Loading latest data…</p></div></div>';
      try { await forceResync(); } catch (e) { console.warn('Post-login sync failed:', e); }
      render();
      // Background sync was already started once at boot.
    }));
    return;
  }

  const ws = Settings.workspace();

  // Topbar with workspace (mode) switcher. Branding is workspace-aware:
  //  - Internal Hiring → Vimenture + Qualis logos
  //  - Kruew Staffing   → Kruew logo
  const topbar = el('div', { class: 'topbar' });
  const brand = el('div', { class: 'topbar-brand' });
  if (ws === 'staffing') {
    brand.innerHTML = `
      <img class="brand-logo brand-logo-kruew" src="public/logo-kruew.png" alt="Kruew"
           onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'brand-text',textContent:'Kruew'}))" />
    `;
  } else {
    brand.innerHTML = `
      <span class="brand-combo">
        <img class="brand-logo" src="public/logo.png" alt="Vimenture"
             onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'brand-text',textContent:'Vimenture'}))" />
        <span class="brand-plus">+</span>
        <img class="brand-logo" src="public/logo-qualis-backup.png" alt="Qualis"
             onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'brand-text',textContent:'Qualis'}))" />
      </span>
    `;
  }
  topbar.appendChild(brand);

  const right = el('div', { class: 'topbar-right' });
  const switcher = el('div', { class: 'ws-switch' });
  Object.values(WORKSPACES).forEach(w => {
    const b = el('button', {
      class: `ws-btn${w.id === ws ? ' active' : ''}`,
      onclick: () => {
        if (w.id === Settings.workspace()) return;
        Settings.setWorkspace(w.id);
        current = 'dashboard';
        render();
      },
    }, w.label);
    switcher.appendChild(b);
  });
  right.appendChild(switcher);
  // Sync status chip. Click = sync now. Double-click = force full re-sync from
  // Supabase (wipes local cache + re-pulls) — fixes an out-of-sync device.
  if (isConfigured()) {
    const chip = el('button', {
      class: 'sync-chip', id: 'sync-chip', title: CHIP_HELP,
      onclick: () => { const st = getSyncStatus(); (st.deadLetter > 0 || st.writeError) ? retryFailedWrites() : syncNow(); },
    });
    chip.addEventListener('dblclick', async () => { await forceResync(); render(); });
    paintSyncChip(chip, getSyncStatus());
    right.appendChild(chip);
  }
  // Signed-in user chip + sign out (cloud mode).
  if (isConfigured() && isAuthed()) {
    const u = currentUser();
    right.appendChild(el('span', { class: 'pill' }, `${u.name} · ${u.role}`));
    right.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { await signOut(); current = 'dashboard'; render(); } }, 'Sign out'));
  } else {
    right.appendChild(el('span', { class: 'pill' }, 'Local · v0.2'));
  }
  topbar.appendChild(right);
  app.appendChild(topbar);

  const main = el('div', { class: 'main-content' });

  // Nav: workspace tabs (scoped) + a separate GLOBAL tabs row (shared).
  const activeTab = activeTabFor(current);
  if (!allTabIds(ws).includes(activeTab) && current !== 'candidate') {
    current = 'dashboard';
  }
  // Global shared tabs FIRST — visually distinct, not tied to the workspace.
  const gtabs = el('div', { class: 'tabs tabs-global' });
  gtabs.appendChild(el('span', { class: 'tabs-global-label' }, 'Shared across all companies:'));
  globalTabs().forEach(t => {
    gtabs.appendChild(el('button', { class: `tab-btn${t.id === activeTabFor(current) ? ' active' : ''}`, onclick: () => navigate(t.id) }, t.label));
  });
  main.appendChild(gtabs);

  // Workspace tabs for the current company.
  const tabs = el('div', { class: 'tabs' });
  tabsForWorkspace(ws).forEach(t => {
    tabs.appendChild(el('button', { class: `tab-btn${t.id === activeTabFor(current) ? ' active' : ''}`, onclick: () => navigate(t.id) }, t.label));
  });
  main.appendChild(tabs);

  // Active view (guarded so a view error shows a message, not a blank page)
  try {
    main.appendChild(viewFor(current, arg));
  } catch (err) {
    const e = el('div', { class: 'card' });
    e.innerHTML = `<h2>Something went wrong rendering this view.</h2><pre class="muted">${String(err && err.stack || err)}</pre>`;
    main.appendChild(e);
    console.error(err);
  }

  app.appendChild(main);
}

// Expose a console escape hatch to force a full re-sync on any device:
//   run  forceResync()  in the browser console.
if (typeof window !== 'undefined') window.forceResync = async () => { const n = await forceResync(); render(); return n; };

// Bootstrap. CRITICAL: we PULL FROM SUPABASE BEFORE the first render, so every
// device always starts from the server's truth — never from stale local cache.
(async function boot() {
  app.innerHTML = '<div class="main-content"><div class="card"><p class="muted">Loading latest data…</p></div></div>';
  try { await initAuth(); } catch (e) { console.error('Auth init failed:', e); }

  // Keep the sync chip live without ever re-rendering the page body.
  onSyncStatus(st => {
    const chip = document.getElementById('sync-chip');
    if (chip) paintSyncChip(chip, st);
  });

  // Pull server data FIRST (if logged in / cloud configured), THEN render — so
  // the very first screen reflects Supabase, identical for everyone.
  try {
    if (!needsLogin()) await forceResync();   // wipe cache + mirror server before paint
  } catch (e) { console.warn('Initial sync failed, rendering from cache:', e); }
  render();

  // Then keep syncing in the background (started ONCE, here). When a pull
  // brings in other users' changes, the current view re-renders unless the
  // user is busy typing / in a modal / uploading.
  initCloudSync(onBackgroundPull)
    .catch(e => console.warn('Cloud sync init failed:', e));
})();
