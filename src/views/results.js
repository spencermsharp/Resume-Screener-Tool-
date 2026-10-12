// ── RESULTS (RANKED) + PIPELINE + CANDIDATE DETAIL VIEW ───────────────────────
import { Profiles, Candidates, Stages, Settings } from '../data/db.js';
import { el, esc, fmtDate, scoreClass, scoreLabel } from '../utils.js';
import { confirm as confirmDialog } from '../ui/modal.js';
import { renderPipeline } from './pipeline.js';

// Remember the last-used sub-view (ranked list vs pipeline board) per session.
let resultsView = 'ranked';

// Maps a stage kind to a badge color class.
function stageBadgeClass(stageId) {
  const s = Stages.get(stageId);
  if (!s) return 'badge-gray';
  return { screen: 'badge-blue', parked: 'badge-parked', interview: 'badge-orange', offer: 'badge-yellow', hired: 'badge-green', reject: 'badge-red' }[s.kind] || 'badge-gray';
}

// results view: navigate('results', profileId?) ; candidate detail: navigate('candidate', candId)
export function renderResults(navigate, profileId) {
  const profiles = Profiles.byWorkspace(Settings.workspace());
  const wrap = el('div');

  const activeId = profileId || (profiles[0] && profiles[0].id) || null;
  const bar = el('div', { class: 'card' });
  const head = el('div', { class: 'card-header' }, el('h2', {}, 'Candidates'));
  const sel = el('select', { style: 'max-width:280px' });
  profiles.forEach(p => {
    const o = el('option', { value: p.id }, p.role + (p.status === 'archived' ? ' (archived)' : ''));
    if (p.id === activeId) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => navigate('results', sel.value));
  head.appendChild(sel);
  bar.appendChild(head);

  if (!activeId) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🧩</div><p>No positions yet.</p>`;
    bar.appendChild(e);
    wrap.appendChild(bar);
    return wrap;
  }

  // Ranked / Pipeline toggle
  const toggle = el('div', { class: 'tabs', style: 'margin:0' });
  toggle.appendChild(el('button', { class: `tab-btn${resultsView === 'ranked' ? ' active' : ''}`, onclick: () => { resultsView = 'ranked'; navigate('results', activeId); } }, 'Ranked list'));
  toggle.appendChild(el('button', { class: `tab-btn${resultsView === 'pipeline' ? ' active' : ''}`, onclick: () => { resultsView = 'pipeline'; navigate('results', activeId); } }, 'Pipeline'));
  bar.appendChild(toggle);
  wrap.appendChild(bar);

  const profile = Profiles.get(activeId);

  if (resultsView === 'pipeline') {
    wrap.appendChild(renderPipeline(navigate, profile));
    return wrap;
  }

  const cands = Candidates.byProfile(activeId)
    .filter(c => c.result)
    .sort((a, b) => (b.result.score || 0) - (a.result.score || 0));

  if (!cands.length) {
    const card = el('div', { class: 'card' });
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">📄</div><p>No candidates screened for this position yet.</p>`;
    e.appendChild(el('button', { class: 'btn btn-primary', style: 'margin-top:12px', onclick: () => navigate('upload') }, 'Upload resumes'));
    card.appendChild(e);
    wrap.appendChild(card);
    return wrap;
  }

  wrap.appendChild(renderRankedList(cands, profile, navigate));
  return wrap;
}

// Clean, scannable ranked list — one row per candidate, click to drill in.
function renderRankedList(cands, profile, navigate) {
  const threshold = profile.threshold != null ? profile.threshold : 60;
  const card = el('div', { class: 'card' });

  const sub = el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:12px' },
    `${cands.length} screened · ranked best-first · threshold ${threshold}%. First-level screen — a human makes the final call.`);
  card.appendChild(sub);

  const table = el('table', { class: 'rank-table' });
  table.innerHTML = `<thead><tr>
    <th style="width:48px">#</th>
    <th style="width:150px">Score</th>
    <th>Candidate</th>
    <th style="width:170px">Stage</th>
    <th style="width:70px">Years</th>
    <th style="width:70px"></th>
  </tr></thead>`;
  const tb = el('tbody');

  cands.forEach((c, i) => {
    const r = c.result;
    const below = (r.score || 0) < threshold;
    const matchedN = (r.matched || []).length;
    const totalN = matchedN + (r.missing || []).length;
    const missReq = (r.missing || []).filter(m => m.required).length;

    const tr = el('tr', { style: 'cursor:pointer', onclick: () => navigate('candidate', c.id) });

    const fitBits = [`${matchedN}/${totalN} criteria`];
    if (missReq) fitBits.push(`${missReq} required missing`);

    tr.innerHTML = `
      <td class="rank-num">#${i + 1}</td>
      <td>
        <div class="score-row">
          <span class="score-chip ${scoreClass(r.score)}">${r.score}</span>
          <div class="score-track"><div class="score-fill ${scoreClass(r.score)}" style="width:${Math.max(0, Math.min(100, r.score))}%"></div></div>
        </div>
      </td>
      <td>
        <strong>${esc(c.name)}</strong>
        ${below ? '<span class="badge badge-red" style="margin-left:6px">Below threshold</span>' : ''}
        <div class="muted" style="font-size:12px">${esc(fitBits.join(' · '))}</div>
      </td>
      <td><span class="badge ${stageBadgeClass(c.stage)}">${esc(Stages.label(c.stage))}</span></td>
      <td>${c.parsed && c.parsed.years != null ? c.parsed.years : '—'}</td>`;
    const td = el('td');
    td.appendChild(el('button', { class: 'btn btn-sm', onclick: (e) => { e.stopPropagation(); navigate('candidate', c.id); } }, 'Open'));
    tr.appendChild(td);
    tb.appendChild(tr);
  });

  table.appendChild(tb);
  card.appendChild(table);
  return card;
}

// ── CANDIDATE DETAIL ──────────────────────────────────────────────────────────
export function renderCandidate(navigate, candId) {
  const c = Candidates.get(candId);
  const wrap = el('div');
  if (!c) { wrap.appendChild(el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Candidate not found.'))); return wrap; }
  const profile = Profiles.get(c.profileId);
  const r = c.result || {};

  wrap.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-bottom:14px', onclick: () => navigate('results', c.profileId) }, '← Back to results'));

  const card = el('div', { class: 'card' });
  const header = el('div', { style: 'display:flex;align-items:center;gap:16px' });
  const headerInfo = el('div', { style: 'display:flex;align-items:center;gap:16px;flex:1' });
  headerInfo.innerHTML = `
    <div class="score-pill ${scoreClass(r.score || 0)}">${r.score ?? 0}</div>
    <div>
      <h2>${esc(c.name)}</h2>
      <div class="muted">${esc(profile?.role || '—')} · ${scoreLabel(r.score || 0)}</div>
    </div>
  `;
  header.appendChild(headerInfo);
  // Delete lives top-right of the candidate card.
  header.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
    const ok = await confirmDialog({
      title: 'Delete this candidate?',
      message: `${c.name} will be removed from this position entirely. This can't be undone.`,
      confirmText: 'Delete', cancelText: 'Cancel', danger: true,
    });
    if (ok) { Candidates.remove(c.id); navigate('results', c.profileId); }
  } }, 'Delete'));
  card.appendChild(header);

  // Contact (best-effort from baseline parser)
  const p = c.parsed || {};
  const contact = el('div', { class: 'grid grid-3', style: 'margin:16px 0' },
    miniField('Email', p.email), miniField('Phone', p.phone), miniField('Years (detected)', p.years != null ? String(p.years) : ''));
  card.appendChild(contact);

  // ── Stage controls (the hiring pipeline) ──────────────────────────────────
  card.appendChild(renderStageControls(c, profile, navigate));

  // explanation
  const ex = el('div', { class: 'explain' });
  ex.innerHTML = `<strong>Why this ranking:</strong> ${esc(r.explanation || 'No explanation available.')}`;
  card.appendChild(ex);

  // chips
  const chips = el('div', { class: 'chips', style: 'margin:14px 0' });
  (r.matched || []).forEach(m => chips.appendChild(html(`<span class="chip chip-match">✓ ${esc(m.label)}<span class="chip-weight">w${m.weight}</span></span>`)));
  (r.missing || []).forEach(m => chips.appendChild(html(`<span class="chip ${m.required ? 'chip-miss' : ''}">${m.required ? '✗ ' : '· '}${esc(m.label)}<span class="chip-weight">w${m.weight}</span></span>`)));
  card.appendChild(chips);
  wrap.appendChild(card);

  // Original resume — preview the actual PDF (served from the server, so it
  // survives reloads). Falls back to extracted text when no PDF is stored.
  const raw = el('div', { class: 'card' });
  const rawHead = el('div', { class: 'card-header' });

  if (c.pdfUrl) {
    rawHead.appendChild(el('h3', {}, 'Resume Preview (PDF)'));
    rawHead.appendChild(el('a', {
      href: c.pdfUrl, target: '_blank', rel: 'noopener',
      class: 'btn btn-sm btn-ghost', style: 'margin-left:auto',
    }, 'Open in new tab ↗'));
    raw.appendChild(rawHead);

    const frame = el('iframe', {
      src: c.pdfUrl,
      style: 'width:100%;height:640px;border:1px solid var(--border,#e5e7eb);border-radius:8px',
      title: `Resume for ${esc(c.name)}`,
    });
    raw.appendChild(frame);

    // Collapsible extracted text, for reference / copy.
    const details = el('details', { style: 'margin-top:12px' });
    details.appendChild(el('summary', { class: 'muted', style: 'cursor:pointer;font-size:13px' }, 'Show extracted text (as screened)'));
    const pre = el('div', { class: 'explain', style: 'white-space:pre-wrap;max-height:360px;overflow:auto;border-left-color:var(--border);margin-top:8px' });
    pre.textContent = c.rawText || '(no text captured)';
    details.appendChild(pre);
    raw.appendChild(details);
  } else {
    rawHead.appendChild(el('h3', {}, 'Resume Text (as screened)'));
    raw.appendChild(rawHead);
    const pre = el('div', { class: 'explain', style: 'white-space:pre-wrap;max-height:360px;overflow:auto;border-left-color:var(--border)' });
    pre.textContent = c.rawText || '(no text captured)';
    raw.appendChild(pre);
  }
  wrap.appendChild(raw);

  return wrap;
}

// Stage management: current stage, move anywhere (with optional note), quick
// actions, below-threshold flag, delete, and the full stage-history timeline.
function renderStageControls(c, profile, navigate) {
  const box = el('div', { class: 'stage-panel', style: 'margin:16px 0' });
  const stages = Stages.all();
  const threshold = profile && profile.threshold != null ? profile.threshold : 60;
  const below = (c.result?.score || 0) < threshold;

  // Header: current stage + below-threshold hint.
  const header = el('div', { class: 'row-between', style: 'margin-bottom:12px' });
  const left = el('div');
  left.appendChild(el('span', { class: 'muted', style: 'font-size:12px;text-transform:uppercase;letter-spacing:.05em' }, 'Current stage'));
  const cur = el('div', { style: 'margin-top:4px' });
  cur.appendChild(el('span', { class: `badge ${stageBadgeClass(c.stage)}`, style: 'font-size:13px' }, Stages.label(c.stage)));
  if (below) cur.appendChild(el('span', { class: 'badge badge-red', style: 'margin-left:8px' }, `Below ${threshold}% threshold`));
  left.appendChild(cur);
  header.appendChild(left);
  box.appendChild(header);

  // Move to any stage (handles going back, or to a different interviewer).
  const moveRow = el('div', { style: 'display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap' });

  const selWrap = el('div', { class: 'form-group', style: 'margin:0;min-width:200px' });
  selWrap.innerHTML = `<label>Move to stage</label>`;
  const sel = el('select');
  stages.forEach(s => {
    const o = el('option', { value: s.id }, s.label);
    if (s.id === c.stage) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  });
  selWrap.appendChild(sel);
  moveRow.appendChild(selWrap);

  const noteWrap = el('div', { class: 'form-group', style: 'margin:0;flex:1;min-width:200px' });
  noteWrap.innerHTML = `<label>Note (optional)</label>`;
  const note = el('input', { type: 'text', placeholder: 'e.g. HR wants a second look' });
  noteWrap.appendChild(note);
  moveRow.appendChild(noteWrap);

  const moveBtn = el('button', { class: 'btn btn-primary', onclick: () => {
    const target = sel.value;
    if (target === c.stage && !note.value.trim()) { navigate('candidate', c.id); return; }
    const label = Stages.label(target);
    const msg = note.value.trim() || `Moved to ${label}.`;
    Candidates.setStage(c.id, target, msg);
    navigate('candidate', c.id);
  } }, 'Update stage');
  moveRow.appendChild(moveBtn);
  box.appendChild(moveRow);

  // Stage history timeline.
  const hist = Array.isArray(c.stageHistory) ? [...c.stageHistory].reverse() : [];
  if (hist.length) {
    const histWrap = el('div', { class: 'timeline', style: 'margin-top:16px' });
    histWrap.appendChild(el('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px' }, 'Stage history'));
    hist.forEach(h => {
      const row = el('div', { class: 'timeline-item' });
      const when = fmtDateTime(h.at);
      row.innerHTML = `
        <div class="tl-stage">${esc(Stages.label(h.stage))}</div>
        <div class="tl-meta">${esc(when)}</div>
        ${h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}`;
      histWrap.appendChild(row);
    });
    box.appendChild(histWrap);
  }

  return box;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return iso; }
}

function miniField(label, val) {
  const d = el('div');
  d.innerHTML = `<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em">${label}</div><div>${esc(val || '—')}</div>`;
  return d;
}

// local html() to avoid circular import churn
function html(str) {
  const d = document.createElement('div');
  d.innerHTML = String(str).trim();
  return d.firstElementChild;
}
