// ── APP SHELL — Kruew + Vimenture/Qualis Hiring Platform ─────────────────────
import { initDB, Settings, WORKSPACES } from './data/db.js';
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
  return ws === 'staffing'
    ? [...CORE_TABS, ...STAFFING_TABS, ...END_TABS]
    : [...CORE_TABS, ...END_TABS];
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

  const ws = Settings.workspace();

  // Topbar with workspace (mode) switcher.
  const topbar = el('div', { class: 'topbar' });
  const brand = el('div', { class: 'topbar-brand' });
  brand.innerHTML = `
    <img src="public/logo.png" alt="logo" style="height:30px" onerror="this.style.display='none'" />
    <div><span>Hiring Platform</span></div>
  `;
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
  right.appendChild(el('span', { class: 'pill' }, 'Localhost · v0.2'));
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

render();
