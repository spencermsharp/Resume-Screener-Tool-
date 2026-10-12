// ── RESULTS (RANKED) + PIPELINE + CANDIDATE DETAIL VIEW ───────────────────────
import { Profiles, Candidates, People, Stages, Settings, REJECT_REASONS } from '../data/db.js';
import { el, esc, fmtDate, scoreClass, scoreLabel } from '../utils.js';
import { confirm as confirmDialog, open as openModal } from '../ui/modal.js';
import { currentUser } from '../auth/auth.js';
import { renderPipeline } from './pipeline.js';

// Remember the last-used sub-view (ranked list vs pipeline board) per session.
let resultsView = 'ranked';
// Active filter: 'active' = still in the running; 'all' = everyone screened.
let resultsFilter = 'active';
// Compare selection (candidate ids) — session-scoped.
let compareSel = new Set();

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

  const all = Candidates.byProfile(activeId).filter(c => c.result);

  if (!all.length) {
    const card = el('div', { class: 'card' });
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">📄</div><p>No candidates screened for this position yet.</p>`;
    e.appendChild(el('button', { class: 'btn btn-primary', style: 'margin-top:12px', onclick: () => navigate('upload') }, 'Upload resumes'));
    card.appendChild(e);
    wrap.appendChild(card);
    return wrap;
  }

  // Active = still in the running (not rejected, out, future-fit, or hired).
  const isActive = c => { const s = Stages.get(c.stage); return s && s.kind !== 'reject' && s.kind !== 'hired' && s.kind !== 'parked'; };
  const activeCands = all.filter(isActive);
  const shown = (resultsFilter === 'active' ? activeCands : all)
    .sort((a, b) => (b.result.score || 0) - (a.result.score || 0));

  // Active / All filter toggle.
  const filterRow = el('div', { class: 'tabs', style: 'margin:0 0 14px' });
  filterRow.appendChild(el('button', { class: `tab-btn${resultsFilter === 'active' ? ' active' : ''}`, onclick: () => { resultsFilter = 'active'; navigate('results', activeId); } }, `In the running (${activeCands.length})`));
  filterRow.appendChild(el('button', { class: `tab-btn${resultsFilter === 'all' ? ' active' : ''}`, onclick: () => { resultsFilter = 'all'; navigate('results', activeId); } }, `All screened (${all.length})`));
  wrap.appendChild(filterRow);

  wrap.appendChild(renderRankedList(shown, profile, navigate));
  return wrap;
}

// Clean, scannable ranked list — one row per candidate, click to drill in.
function renderRankedList(cands, profile, navigate) {
  const threshold = profile.threshold != null ? profile.threshold : 60;
  const card = el('div', { class: 'card' });

  const subRow = el('div', { class: 'row-between', style: 'margin-bottom:12px;align-items:center' });
  subRow.appendChild(el('div', { class: 'muted', style: 'font-size:12px' },
    `${cands.length} shown · ranked best-first · threshold ${threshold}%. First-level screen — a human makes the final call.`));
  const exportBtn = el('button', { class: 'btn btn-sm', onclick: () => exportShortlist(cands, profile) }, '⬇ Export / share shortlist');
  subRow.appendChild(exportBtn);
  card.appendChild(subRow);

  // Compare bar — appears when candidates are selected.
  const selValid = [...compareSel].filter(id => cands.some(c => c.id === id));
  compareSel = new Set(selValid);
  if (compareSel.size) {
    const ids = [...compareSel];
    const bar = el('div', { class: 'compare-bar' });
    bar.appendChild(el('span', {}, `${compareSel.size} selected`));
    const right = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
    // Bulk stage actions.
    const bulk = (label, stageId, note, cls = '') => el('button', { class: `btn btn-sm ${cls}`, onclick: () => {
      ids.forEach(id => Candidates.setStage(id, stageId, note));
      compareSel.clear(); navigate('results', profile.id);
    } }, label);
    right.appendChild(bulk('→ Advance to HR', 'hr', 'Bulk-advanced to HR.'));
    right.appendChild(bulk('→ Future Fit', 'future_fit', 'Bulk-parked in Future Fit.'));
    right.appendChild(bulk('Reject', 'rejected', 'Bulk-rejected.', 'btn-danger'));
    const cmpBtn = el('button', { class: 'btn btn-sm btn-primary', onclick: () => openCompare(ids, profile) }, 'Compare →');
    if (compareSel.size < 2) cmpBtn.disabled = true;
    right.appendChild(cmpBtn);
    right.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { compareSel.clear(); navigate('results', profile.id); } }, 'Clear'));
    bar.appendChild(right);
    card.appendChild(bar);
  }

  const table = el('table', { class: 'rank-table' });
  table.innerHTML = `<thead><tr>
    <th style="width:34px"></th>
    <th style="width:40px">#</th>
    <th style="width:150px">Score</th>
    <th>Candidate</th>
    <th style="width:170px">Stage</th>
    <th style="width:60px">Years</th>
    <th style="width:64px"></th>
  </tr></thead>`;
  const tb = el('tbody');

  cands.forEach((c, i) => {
    const r = c.result;
    const below = (r.score || 0) < threshold;
    const matchedN = (r.matched || []).length;
    const totalN = matchedN + (r.missing || []).length;
    const missReq = (r.missing || []).filter(m => m.required).length;

    const tr = el('tr');
    const fitBits = [`${matchedN}/${totalN} criteria`];
    if (missReq) fitBits.push(`${missReq} required missing`);

    // Compare checkbox (max 4).
    const cbTd = el('td');
    const cb = el('input', { type: 'checkbox' });
    cb.checked = compareSel.has(c.id);
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) { if (compareSel.size >= 4) { cb.checked = false; return; } compareSel.add(c.id); }
      else compareSel.delete(c.id);
      navigate('results', profile.id);
    };
    cbTd.appendChild(cb);
    tr.appendChild(cbTd);

    const rest = el('td', { style: 'display:none' }); // placeholder to keep innerHTML approach simple
    tr.insertAdjacentHTML('beforeend', `
      <td class="rank-num">#${i + 1}</td>
      <td>
        <div class="score-row">
          <span class="score-chip ${scoreClass(r.score)}">${r.score}</span>
          <div class="score-track"><div class="score-fill ${scoreClass(r.score)}" style="width:${Math.max(0, Math.min(100, r.score))}%"></div></div>
        </div>
      </td>
      <td class="c-name" style="cursor:pointer">
        <strong>${esc(c.name)}</strong>
        ${below ? '<span class="badge badge-red" style="margin-left:6px">Below threshold</span>' : ''}
        <div class="muted" style="font-size:12px">${esc(fitBits.join(' · '))}</div>
      </td>
      <td><span class="badge ${stageBadgeClass(c.stage)}">${esc(Stages.label(c.stage))}</span></td>
      <td>${c.parsed && c.parsed.years != null ? c.parsed.years : '—'}</td>`);
    const td = el('td');
    td.appendChild(el('button', { class: 'btn btn-sm', onclick: (e) => { e.stopPropagation(); navigate('candidate', c.id); } }, 'Open'));
    tr.appendChild(td);
    // Clicking the name/row opens the candidate.
    tr.querySelector('.c-name').addEventListener('click', () => navigate('candidate', c.id));
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

  // ── Candidate history across ALL jobs (the Person profile) ────────────────
  const otherApps = c.personId ? People.history(c.personId).filter(a => a.id !== c.id) : [];
  if (otherApps.length) {
    const histCard = el('div', { class: 'card' });
    histCard.appendChild(el('div', { class: 'card-header' }, el('h3', {}, `This person's other applications (${otherApps.length})`)));
    histCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:10px' },
      'Same person, other jobs — across all companies. Full history follows them.'));
    otherApps.forEach(a => {
      const ap = Profiles.get(a.profileId);
      const row = el('div', { class: 'row-between', style: 'padding:8px 0;border-top:1px solid var(--border);cursor:pointer' });
      row.onclick = () => navigate('candidate', a.id);
      const where = ap ? `${ap.role} · ${ap.company || (ap.workspace === 'staffing' ? 'Kruew' : 'Internal')}` : '—';
      row.innerHTML = `
        <div><strong>${esc(where)}</strong>
          <div class="muted" style="font-size:12px">${esc(Stages.label(a.stage))} · screened ${fmtDate(a.createdAt)}</div></div>
        <span class="badge ${stageBadgeClass(a.stage)}">${esc(Stages.label(a.stage))}</span>`;
      histCard.appendChild(row);
    });
    // Append after the main card is in the wrap (deferred below).
    c._historyCard = histCard;
  }

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

  // Cross-job history card (if this person has other applications).
  if (c._historyCard) wrap.appendChild(c._historyCard);

  // Team notes.
  wrap.appendChild(renderNotes(c, navigate));

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

  // Reject with a structured reason.
  moveRow.appendChild(el('button', { class: 'btn btn-danger', onclick: () => rejectWithReason(c, navigate) }, 'Reject with reason'));
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

// Export a client-safe shortlist (top candidates). Opens a clean printable page
// (print → PDF) with scores + AI "why" — NO internal notes or margin leaked.
function exportShortlist(cands, profile) {
  const top = cands.slice(0, 10);
  const esc2 = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = top.map((c, i) => {
    const r = c.result || {};
    const matched = (r.matched || []).map(m => esc2(m.label)).join(', ') || '—';
    const why = esc2((r.explanation || '').split('First-level')[0] || '');
    return `<div class="cand">
      <div class="ch"><span class="rk">#${i + 1}</span><span class="nm">${esc2(c.name)}</span><span class="sc">${r.score ?? 0}</span></div>
      <div class="meta">Strengths: ${matched}</div>
      <div class="why">${why}</div>
    </div>`;
  }).join('');
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shortlist — ${esc2(profile.role)}</title>
    <style>
      body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:30px auto;padding:0 20px;color:#1a2b4a}
      h1{font-size:20px;margin:0 0 2px} .subt{color:#5a6a82;font-size:13px;margin-bottom:20px}
      .cand{border:1px solid #dde3ec;border-radius:10px;padding:14px 16px;margin-bottom:12px}
      .ch{display:flex;align-items:center;gap:10px}
      .rk{color:#c8590a;font-weight:700} .nm{font-weight:700;font-size:15px;flex:1}
      .sc{background:#c8590a;color:#fff;border-radius:8px;padding:2px 10px;font-weight:700}
      .meta{font-size:12px;color:#5a6a82;margin-top:6px} .why{font-size:13px;margin-top:6px;line-height:1.5}
      .foot{color:#8a9bb5;font-size:11px;margin-top:20px}
      @media print{ .noprint{display:none} }
    </style></head><body>
    <h1>Candidate shortlist — ${esc2(profile.role)}</h1>
    <div class="subt">${top.length} candidates · generated ${new Date().toLocaleDateString()}</div>
    ${rows}
    <div class="foot">First-level AI screen. A human reviews before any hiring decision. Internal notes and commercials are not included.</div>
    <button class="noprint" onclick="window.print()" style="margin-top:16px;padding:8px 14px;border-radius:8px;border:1px solid #c8590a;background:#c8590a;color:#fff;font-weight:600;cursor:pointer">Print / Save as PDF</button>
    </body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(doc); w.document.close(); }
}

// Side-by-side comparison of selected candidates (by criterion).
function openCompare(ids, profile) {
  const cands = ids.map(id => Candidates.get(id)).filter(Boolean);
  const criteria = profile.criteria || [];
  const body = el('div', { style: 'overflow-x:auto' });

  const matchedSet = c => new Set((c.result?.matched || []).map(m => m.label));
  const missingReqSet = c => new Set((c.result?.missing || []).filter(m => m.required).map(m => m.label));

  let html = '<table class="cmp-table"><thead><tr><th>Criterion</th>';
  cands.forEach(c => { html += `<th>${esc(c.name)}<div class="muted" style="font-weight:400">score ${c.result?.score ?? 0}</div></th>`; });
  html += '</tr></thead><tbody>';

  criteria.forEach(crit => {
    html += `<tr><td>${esc(crit.label)}${crit.required ? ' <span class="muted">(req)</span>' : ''} <span class="muted">w${crit.weight || 1}</span></td>`;
    cands.forEach(c => {
      const has = matchedSet(c).has(crit.label);
      const missReq = missingReqSet(c).has(crit.label);
      html += `<td class="${has ? 'cmp-yes' : (missReq ? 'cmp-no' : 'cmp-dim')}">${has ? '✓' : (missReq ? '✗ missing' : '·')}</td>`;
    });
    html += '</tr>';
  });
  // Years row.
  html += '<tr><td>Years detected</td>';
  cands.forEach(c => { html += `<td>${c.parsed?.years != null ? c.parsed.years : '—'}</td>`; });
  html += '</tr>';
  // AI explanation row.
  html += '<tr><td>AI take</td>';
  cands.forEach(c => { html += `<td style="font-size:12px;color:var(--text2);min-width:180px">${esc((c.result?.explanation || '').split('First-level')[0] || '—')}</td>`; });
  html += '</tr></tbody></table>';
  body.innerHTML = html;

  openModal({
    title: `Compare ${cands.length} candidates`,
    body,
    actions: [{ label: 'Close', value: true, variant: 'primary', isDefault: true, isCancel: true }],
  });
}

// Reject modal with a structured reason dropdown + optional note.
function rejectWithReason(c, navigate) {
  const body = el('div');
  body.innerHTML = `<p class="muted" style="margin-bottom:10px">Pick a reason — it's searchable later and feeds Future Fit matching.</p>`;
  const sel = el('select', { style: 'width:100%;margin-bottom:10px' });
  REJECT_REASONS.forEach(r => sel.appendChild(el('option', { value: r }, r)));
  body.appendChild(sel);
  const note = el('input', { type: 'text', placeholder: 'Optional note (e.g. "strong, wrong seniority")', style: 'width:100%' });
  body.appendChild(note);
  const hint = el('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, '');
  const syncHint = () => { hint.textContent = sel.value === 'Better fit for another role' ? '→ This will park them in Future Fit (not a hard reject).' : '→ This moves them to Rejected (out of this role).'; };
  sel.addEventListener('change', syncHint); syncHint();
  body.appendChild(hint);

  openModal({
    title: `Reject ${c.name}?`,
    body,
    actions: [
      { label: 'Cancel', value: null, variant: 'ghost', isCancel: true },
      { label: 'Confirm', value: 'go', variant: 'danger', isDefault: true },
    ],
  }).then(res => {
    if (res !== 'go') return;
    Candidates.reject(c.id, sel.value, note.value.trim());
    navigate('candidate', c.id);
  });
}

// Team notes — a running comment thread, separate from stage history.
function renderNotes(c, navigate) {
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h3', {}, 'Team notes')));
  const notes = Array.isArray(c.notes) ? c.notes : [];
  if (!notes.length) {
    card.appendChild(el('div', { class: 'muted', style: 'font-size:13px;margin-bottom:10px' }, 'No notes yet.'));
  } else {
    [...notes].reverse().forEach(n => {
      const row = el('div', { class: 'note-item' });
      row.innerHTML = `${esc(n.text)}<div class="note-meta">${esc(n.author || 'someone')} · ${fmtDateTime(n.at)}</div>`;
      card.appendChild(row);
    });
  }
  const row = el('div', { style: 'display:flex;gap:8px;margin-top:10px' });
  const input = el('input', { type: 'text', placeholder: 'Add a note for the team…', style: 'flex:1' });
  const add = () => {
    if (!input.value.trim()) return;
    const u = currentUser();
    Candidates.addNote(c.id, input.value.trim(), u ? u.name : '');
    navigate('candidate', c.id);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  row.appendChild(input);
  row.appendChild(el('button', { class: 'btn btn-primary btn-sm', onclick: add }, 'Add'));
  card.appendChild(row);
  return card;
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
