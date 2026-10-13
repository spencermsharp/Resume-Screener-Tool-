// ── DASHBOARD VIEW ────────────────────────────────────────────────────────────
import { Profiles, Candidates, Settings, Stages } from '../data/db.js';
import { el, esc } from '../utils.js';

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

  // ── ROI metrics (proves the tool is working) ──────────────────────────────
  const hired = candidates.filter(c => { const s = Stages.get(c.stage); return s && s.kind === 'hired'; });
  // Hires that came from a Future Fit recycle (their history shows a prior future_fit stage).
  const hiredFromPool = hired.filter(c => (c.stageHistory || []).some(h => h.stage === 'future_fit')).length;
  const parked = candidates.filter(c => c.stage === 'future_fit').length;
  const interviewed = candidates.filter(c => (c.stageHistory || []).some(h => { const s = Stages.get(h.stage); return s && s.kind === 'interview'; })).length;
  const convRate = candidates.length ? Math.round(interviewed / candidates.length * 100) : 0;
  const roi = el('div', { class: 'grid grid-4' },
    kpi('Hired / Placed', hired.length, 'all roles'),
    kpi('Hires from Future Fit', hiredFromPool, 'recycle ROI', hiredFromPool > 0),
    kpi('In Future Fit', parked, 'recyclable pool'),
    kpi('Screen → Interview', convRate + '%', 'conversion rate'),
  );
  wrap.appendChild(roi);

  // ── Efficiency metrics (the insightful stuff) ─────────────────────────────
  wrap.appendChild(el('div', { class: 'section-label', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text2);margin:26px 0 10px;font-weight:600' }, 'Hiring efficiency'));

  const avgTimeToHire = avgDaysToHire(hired);
  const avgInterviewedPerHire = hired.length ? Math.round(interviewed / hired.length * 10) / 10 : null;
  const avgTimeToFill = avgDaysToFill(profiles);
  const offerAccept = offerAcceptRate(candidates);

  const eff = el('div', { class: 'grid grid-4' },
    kpi('Avg Time to Hire', avgTimeToHire != null ? `${avgTimeToHire}d` : '—', 'screened → hired'),
    kpi('Interviewed / Hire', avgInterviewedPerHire != null ? avgInterviewedPerHire : '—', 'candidates per hire'),
    kpi('Avg Time to Fill', avgTimeToFill != null ? `${avgTimeToFill}d` : '—', 'position opened → filled'),
    kpi('Offer Accept Rate', offerAccept != null ? `${offerAccept}%` : '—', 'offers → hires'),
  );
  wrap.appendChild(eff);

  // ── Pipeline funnel (company-wide) ────────────────────────────────────────
  const funnelCard = el('div', { class: 'card' });
  funnelCard.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Pipeline funnel')));
  const screenedN = candidates.length;
  const interviewN = interviewed;
  const offerN = candidates.filter(c => (c.stageHistory || []).some(h => { const s = Stages.get(h.stage); return s && s.kind === 'offer'; })).length;
  const hiredN = hired.length;
  const funnel = [
    ['Screened', screenedN, 'pf-blue'],
    ['Interviewed', interviewN, 'pf-orange'],
    ['Offered', offerN, 'pf-yellow'],
    ['Hired', hiredN, 'pf-green'],
  ];
  const maxF = Math.max(1, ...funnel.map(f => f[1]));
  funnel.forEach(([label, n, cls], i) => {
    const prev = i > 0 ? funnel[i - 1][1] : null;
    const dropPct = prev && prev > 0 ? Math.round(n / prev * 100) : null;
    const rowEl = el('div', { style: 'display:flex;align-items:center;gap:14px;padding:9px 0;border-bottom:1px solid var(--border)' });
    rowEl.innerHTML = `
      <div style="width:120px;font-weight:600;font-size:13px">${label}</div>
      <div class="pf-track" style="flex:1"><div class="pf-fill ${cls}" style="width:${Math.round(n / maxF * 100)}%"></div></div>
      <div style="width:120px;text-align:right;font-size:13px"><strong>${n}</strong>${dropPct != null ? ` <span class="muted">(${dropPct}% of prev)</span>` : ''}</div>`;
    funnelCard.appendChild(rowEl);
  });
  wrap.appendChild(funnelCard);

  // ── Positions needing attention ───────────────────────────────────────────
  const openProfiles = profiles.filter(p => (p.status || 'open') !== 'archived');
  const attention = openProfiles.map(p => {
    const inRunning = Candidates.byProfile(p.id).filter(c => { const s = Stages.get(c.stage); return c.result && s && s.kind !== 'reject' && s.kind !== 'hired' && s.kind !== 'parked'; }).length;
    return { p, inRunning, days: daysOpen(p.openedAt || p.createdAt) };
  }).filter(x => x.inRunning === 0 || x.days >= 21)
    .sort((a, b) => b.days - a.days)
    .slice(0, 6);
  if (attention.length) {
    const attn = el('div', { class: 'card' });
    attn.appendChild(el('div', { class: 'card-header' }, el('h2', {}, '⚠️ Positions needing attention')));
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Position</th><th>Company</th><th>In the running</th><th>Days open</th></tr></thead>`;
    const tb = el('tbody');
    attention.forEach(({ p, inRunning, days }) => {
      const co = ws === 'staffing' ? '—' : (p.company || '—');
      const tr = el('tr', { style: 'cursor:pointer', onclick: () => navigate('results', p.id) });
      tr.innerHTML = `
        <td><strong>${esc(p.role)}</strong></td>
        <td>${esc(co)}</td>
        <td>${inRunning === 0 ? '<span class="badge badge-red">0 active</span>' : inRunning}</td>
        <td>${days}d</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    attn.appendChild(table);
    wrap.appendChild(attn);
  }

  return wrap;
}

// Renders the AI banner from the server's readiness status. The key lives in
// the server environment (.env in dev, host secrets in prod) — the browser only
// learns whether AI is READY, never the key itself.
async function renderAIBanner(banner, navigate) {
  const model = 'claude-sonnet-4-5';
  // AI runs through the Supabase 'screen' Edge Function, so it's available
  // whenever Supabase is configured.
  const { isConfigured } = await import('../auth/supabaseClient.js');
  const aiReady = isConfigured();

  banner.innerHTML = '';

  if (!aiReady) {
    banner.className = 'banner banner-warn';
    const msg = el('span');
    msg.innerHTML = `🧪 Running the <strong>rule-based baseline</strong>. Connect Supabase (config.js) and deploy the <code>screen</code> function to enable Claude screening.`;
    banner.append(msg);
    return;
  }

  // AI is available — let the user toggle it for screening runs.
  const ai = Settings.get().ai || {};
  banner.className = `banner ${ai.enabled ? 'banner-info' : 'banner-warn'}`;
  const msg = el('span');
  msg.innerHTML = ai.enabled
    ? `🤖 AI screening is <strong>ON</strong> (Claude ${esc(ai.model || model)}). Falls back to rules on any error.`
    : `🔑 Claude is available. AI is <strong>off</strong> — turn it on to screen with Claude.`;
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

function kpi(label, value, sub, highlight) {
  const d = el('div', { class: `kpi${highlight ? ' kpi-highlight' : ''}` });
  d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return d;
}
function avgScore(cands) {
  const scored = cands.filter(c => c.result);
  if (!scored.length) return '—';
  return Math.round(scored.reduce((s, c) => s + (c.result.score || 0), 0) / scored.length);
}

// ── Metric helpers ────────────────────────────────────────────────────────
function daysOpen(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(dateStr); if (isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}
function daysBetweenIso(a, b) {
  const d1 = new Date(a), d2 = new Date(b);
  if (isNaN(d1) || isNaN(d2)) return null;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}
// Avg days from first stage entry (screened) to the hired entry.
function avgDaysToHire(hired) {
  const spans = [];
  hired.forEach(c => {
    const hist = c.stageHistory || [];
    if (!hist.length) return;
    const start = hist[0].at;
    const hireEntry = [...hist].reverse().find(h => { const s = Stages.get(h.stage); return s && s.kind === 'hired'; });
    if (start && hireEntry) { const d = daysBetweenIso(start, hireEntry.at); if (d != null) spans.push(d); }
  });
  if (!spans.length) return null;
  return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
}
// Avg days a filled position was open (openedAt → first hire among its candidates).
function avgDaysToFill(profiles) {
  const spans = [];
  profiles.forEach(p => {
    const hires = Candidates.byProfile(p.id).filter(c => { const s = Stages.get(c.stage); return s && s.kind === 'hired'; });
    if (!hires.length) return;
    const hireEntry = hires.map(c => [...(c.stageHistory || [])].reverse().find(h => { const s = Stages.get(h.stage); return s && s.kind === 'hired'; })).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    const opened = p.openedAt || p.createdAt;
    if (opened && hireEntry) { const d = daysBetweenIso(opened, hireEntry.at); if (d != null) spans.push(d); }
  });
  if (!spans.length) return null;
  return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
}
// % of candidates who reached an offer stage that ended up hired.
function offerAcceptRate(cands) {
  const reachedOffer = cands.filter(c => (c.stageHistory || []).some(h => { const s = Stages.get(h.stage); return s && s.kind === 'offer'; }));
  if (!reachedOffer.length) return null;
  const hiredOfThose = reachedOffer.filter(c => { const s = Stages.get(c.stage); return s && s.kind === 'hired'; }).length;
  return Math.round(hiredOfThose / reachedOffer.length * 100);
}
