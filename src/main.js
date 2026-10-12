// ── APP SHELL — Kruew + Vimenture/Qualis Hiring Platform ─────────────────────
import { initDB, initCloudSync, Settings, WORKSPACES } from './data/db.js';
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
import { renderLogin } from './views/login.js';
import { initAuth, needsLogin, isAdmin, isAuthed, currentUser, signOut } from './auth/auth.js';
import { isConfigured } from './auth/supabaseClient.js';

initDB();

const app = document.getElementById('app');

// Tabs shared by both workspaces (the screening core).
const CORE_TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'profiles',  label: 'Job Positions' },
  { id: 'upload',    label: 'Upload & Screen' },
  { id: 'results',   label: 'Results' },
  { id: 'futurefit', label: 'Future Fit' },
];
// Tabs only Kruew Staffing shows (the revenue/CRM layer).
const STAFFING_TABS = [
  { id: 'companies',  label: 'Companies' },
  { id: 'placements', label: 'Placements' },
];
// Settings-ish tabs at the end.
const END_TABS = [
  { id: 'blacklist', label: 'Blackball' },
  { id: 'stages',    label: 'Hiring Stages' },
];

function tabsForWorkspace(ws) {
  const base = ws === 'staffing'
    ? [...CORE_TABS, ...STAFFING_TABS, ...END_TABS]
    : [...CORE_TABS, ...END_TABS];
  // Team tab: admins manage users; everyone else gets an Account tab (own password).
  if (isAdmin()) base.push({ id: 'team', label: 'Team' });
  else base.push({ id: 'team', label: 'Account' });
  return base;
}

let current = 'dashboard';

// navigate(route, arg?) — the routing contract every view uses.
function navigate(route, arg) {
  current = route;
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
    default:           return renderDashboard(navigate);
  }
}

// Which top tab should appear active (candidate detail lives under Results).
function activeTabFor(route) {
  if (route === 'candidate') return 'results';
  return route;
}

function render(arg) {
  app.innerHTML = '';

  // Login wall (cloud mode only). Local dev skips this.
  if (needsLogin()) {
    app.appendChild(renderLogin(() => { current = 'dashboard'; render(); }));
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

  // Nav tabs (workspace-aware)
  const activeTab = activeTabFor(current);
  const tabList = tabsForWorkspace(ws);
  // If the current route isn't valid for this workspace, fall back to dashboard.
  if (!tabList.some(t => t.id === activeTab) && current !== 'candidate') {
    current = 'dashboard';
  }
  const tabs = el('div', { class: 'tabs' });
  tabsForWorkspace(ws).forEach(t => {
    const btn = el('button', { class: `tab-btn${t.id === activeTabFor(current) ? ' active' : ''}`, onclick: () => navigate(t.id) }, t.label);
    tabs.appendChild(btn);
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

// Bootstrap: initialize auth (loads runtime config + session) before first paint.
(async function boot() {
  app.innerHTML = '<div class="main-content"><div class="card"><p class="muted">Loading…</p></div></div>';
  try { await initAuth(); } catch (e) { console.error('Auth init failed:', e); }
  render();
  // Cloud sync: pull shared data, start write queue + periodic refresh. Re-render
  // when fresh data arrives so other devices' changes appear. Only re-render when
  // the user is idle on a list view (not mid-edit) to avoid disrupting input.
  initCloudSync(() => {
    const safeViews = ['dashboard', 'profiles', 'results', 'futurefit', 'companies', 'placements'];
    const noActiveInput = !document.activeElement || !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (safeViews.includes(current) && noActiveInput) render();
  }).catch(e => console.warn('Cloud sync init failed:', e));
})();
