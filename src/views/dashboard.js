// ── DASHBOARD VIEW ────────────────────────────────────────────────────────────
import { Profiles, Candidates, Settings, Stages } from '../data/db.js';
import { el, esc, fmtDate, scoreClass } from '../utils.js';

export function renderDashboard(navigate) {
  const ws = Settings.workspace();
  const profiles = Profiles.byWorkspace(ws);
  const wsProfileIds = new Set(profiles.map(p => p.id));
  const candidates = Candidates.all().filter(c => wsProfileIds.has(c.profileId));
  const ai = Settings.get().ai;

  const wrap = el('div');

  // AI banner — rendered async once we know whether a key is set on the server.
  const banner = el('div', { class: 'banner banner-warn' });
  banner.style.display = 'flex';
  banner.style.alignItems = 'center';
  banner.style.flexWrap = 'wrap';
  banner.style.gap = '10px';
  banner.appendChild(el('span', {}, 'Checking AI status…'));
  wrap.appendChild(banner);
  renderAIBanner(banner, navigate);

  // KPIs
  const openCount = profiles.filter(p => (p.status || 'open') !== 'archived').length;
  const kpis = el('div', { class: 'grid grid-4' },
    kpi('Open Positions', openCount, 'actively screening'),
    kpi('Candidates Screened', candidates.length, 'all roles'),
    kpi('In Interviews', candidates.filter(c => { const s = Stages.get(c.stage); return s && s.kind === 'interview'; }).length, 'active in pipeline'),
    kpi('Avg Score', avgScore(candidates), 'across candidates'),
  );
  wrap.appendChild(kpis);

  // Quick actions
  const actions = el('div', { class: 'card' });
  actions.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Get Started')));
  const row = el('div', { class: 'grid grid-3' },
    actionCard('🧩', 'Define a position', 'Create or edit a job position (Sales, Accountant, Telecom Analyst…).', 'Open Positions', () => navigate('profiles')),
    actionCard('📥', 'Screen resumes', 'Upload a stack of resumes and screen them against a role.', 'Upload', () => navigate('upload')),
    actionCard('🏆', 'See the best', 'View ranked candidates with scores and the reason they fit.', 'View Results', () => navigate('results')),
  );
  actions.appendChild(row);
  wrap.appendChild(actions);

  // Recent candidates
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Recently Screened')));
  if (!candidates.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">📄</div><p>No candidates screened yet.</p>`;
    card.appendChild(e);
  } else {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Candidate</th><th>Role</th><th>Score</th><th>Status</th><th>Screened</th></tr></thead>`;
    const tb = el('tbody');
    candidates.slice(0, 8).forEach(c => {
      const prof = Profiles.get(c.profileId);
      const score = c.result?.score ?? 0;
      const tr = el('tr', { style: 'cursor:pointer', onclick: () => navigate('candidate', c.id) });
      tr.innerHTML = `
        <td><strong>${esc(c.name)}</strong></td>
        <td>${esc(prof?.role || '—')}</td>
        <td><span class="badge ${score>=75?'badge-green':score>=50?'badge-yellow':'badge-gray'}">${score}</span></td>
        <td>${esc(Stages.label(c.stage))}</td>
        <td class="muted">${fmtDate(c.createdAt)}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
  }
  wrap.appendChild(card);
  return wrap;
}

// Renders the AI banner from the server's readiness status. The key lives in
// the server environment (.env in dev, host secrets in prod) — the browser only
// learns whether AI is READY, never the key itself.
async function renderAIBanner(banner, navigate) {
  let aiReady = false;
  let model = 'claude-sonnet-4-5';
  try {
    const r = await fetch('/api/status');
    if (r.ok) { const s = await r.json(); aiReady = !!s.aiReady; model = s.model || model; }
  } catch { /* server unreachable — treat AI as not ready */ }

  banner.innerHTML = '';

  if (!aiReady) {
    banner.className = 'banner banner-warn';
    const msg = el('span');
    msg.innerHTML = `🧪 Running the <strong>rule-based baseline</strong>. `
      + `Set <code>ANTHROPIC_API_KEY</code> in your <code>.env</code> (then restart) to enable Claude screening. `
      + `<span class="ai-seam">AI seam ready</span>`;
    banner.append(msg);
    return;
  }

  // AI is ready on the server — let the user toggle it for screening runs.
  const ai = Settings.get().ai || {};
  banner.className = `banner ${ai.enabled ? 'banner-info' : 'banner-warn'}`;
  const msg = el('span');
  msg.innerHTML = ai.enabled
    ? `🤖 AI screening is <strong>ON</strong> (anthropic ${esc(ai.model || model)}). Falls back to rules on any error.`
    : `🔑 Server key detected. AI is <strong>off</strong> — turn it on to screen with Claude.`;
  const toggle = el('button', {
    class: `btn btn-sm ${ai.enabled ? '' : 'btn-primary'}`,
    style: 'margin-left:auto',
    onclick: () => {
      const cur = Settings.get().ai || {};
      Settings.update({ ai: { ...cur, enabled: !cur.enabled, provider: 'anthropic', model: cur.model || model } });
      navigate('dashboard');
    },
  }, ai.enabled ? 'Turn AI off' : 'Turn AI on');
  banner.append(msg, toggle);
}

function kpi(label, value, sub) {
  const d = el('div', { class: 'kpi' });
  d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return d;
}
function actionCard(icon, title, desc, btn, onClick) {
  const d = el('div', { class: 'card', style: 'margin:0' });
  d.innerHTML = `<div style="font-size:28px">${icon}</div><h3 style="margin:8px 0 4px">${title}</h3><p class="muted" style="font-size:13px;margin-bottom:12px">${desc}</p>`;
  d.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: onClick }, btn));
  return d;
}
function avgScore(cands) {
  const scored = cands.filter(c => c.result);
  if (!scored.length) return '—';
  return Math.round(scored.reduce((s, c) => s + (c.result.score || 0), 0) / scored.length);
}
