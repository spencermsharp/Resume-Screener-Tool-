// ── RESULTS (RANKED) + PIPELINE + CANDIDATE DETAIL VIEW ───────────────────────
import { Profiles, Candidates, Companies, People, Stages, Settings, REJECT_REASONS } from '../data/db.js';
import { el, esc, fmtDate, scoreClass, scoreLabel } from '../utils.js';
import { confirm as confirmDialog, open as openModal } from '../ui/modal.js';
import { currentUser } from '../auth/auth.js';
import { renderPipeline } from './pipeline.js';

// Remember the last-used sub-view (ranked list vs pipeline board) per session.
let resultsView = 'ranked';
// Stage filter for the ranked list: '' = all stages, or a specific stage id to
// see everyone currently in that stage.
let resultsStage = '';
// Candidate detail: toggles the inline edit form for name/email/phone/years.
let editingDetails = false;
// Compare selection (candidate ids) — session-scoped.
let compareSel = new Set();
// Company filter for the position picker ('' = all).
let resultsCompany = '';
// Candidate name search — shared across the Ranked list and Pipeline sub-views.
let resultsSearch = '';
// Tracks whether the search box had focus, so we can restore it after the
// app's full re-render (navigate recreates the input element).
let searchHadFocus = false;

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

  const ws = Settings.workspace();
  const companyName = p => ws === 'staffing' ? (Companies.name(p.companyId) || 'Unassigned') : (p.company || '—');

  const bar = el('div', { class: 'card' });
  bar.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Candidates')));

  if (!profiles.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🧩</div><p>No positions yet. Create one under Job Positions.</p>`;
    bar.appendChild(e);
    wrap.appendChild(bar);
    return wrap;
  }

  // Company filter + position picker (shows company, title, candidate count).
  const companies = [...new Set(profiles.map(companyName))].sort();
  if (resultsCompany && !companies.includes(resultsCompany)) resultsCompany = '';
  const inCompany = resultsCompany ? profiles.filter(p => companyName(p) === resultsCompany) : profiles;

  const activeId = (profileId && inCompany.some(p => p.id === profileId))
    ? profileId
    : (inCompany[0] && inCompany[0].id) || null;

  const pickRow = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px' });

  // Company filter
  const coSel = el('select', { style: 'max-width:220px' });
  coSel.appendChild(el('option', { value: '' }, `All companies (${profiles.length})`));
  companies.forEach(cn => {
    const n = profiles.filter(p => companyName(p) === cn).length;
    const o = el('option', { value: cn }, `${cn} (${n})`);
    if (cn === resultsCompany) o.setAttribute('selected', 'selected');
    coSel.appendChild(o);
  });
  coSel.addEventListener('change', () => { resultsCompany = coSel.value; navigate('results'); });
  pickRow.appendChild(labeled('Company', coSel));

  // Position picker — label shows company · role · candidate count.
  const sel = el('select', { style: 'min-width:320px;flex:1' });
  inCompany
    .slice()
    .sort((a, b) => companyName(a).localeCompare(companyName(b)) || a.role.localeCompare(b.role))
    .forEach(p => {
      const n = Candidates.byProfile(p.id).filter(c => c.result).length;
      const arch = p.status === 'archived' ? ' · archived' : '';
      const o = el('option', { value: p.id }, `${companyName(p)} — ${p.role} · ${n} candidate${n === 1 ? '' : 's'}${arch}`);
      if (p.id === activeId) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
  sel.addEventListener('change', () => navigate('results', sel.value));
  pickRow.appendChild(labeled('Position', sel));
  bar.appendChild(pickRow);

  if (!activeId) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🧩</div><p>No positions for this company.</p>`;
    bar.appendChild(e);
    wrap.appendChild(bar);
    return wrap;
  }

  // Clear "what you're looking at" header line.
  const selProf = Profiles.get(activeId);
  if (selProf) {
    const ctx = el('div', { class: 'results-context' });
    ctx.innerHTML = `
      <span class="badge badge-gray">${esc(companyName(selProf))}</span>
      <strong style="font-size:15px">${esc(selProf.role)}</strong>
      ${selProf.priority === 'urgent' ? '<span class="badge badge-red">Urgent</span>' : ''}
      ${selProf.status === 'archived' ? '<span class="badge badge-gray">Archived</span>' : ''}`;
    bar.appendChild(ctx);
  }

  // Ranked / Pipeline toggle
  const toggle = el('div', { class: 'tabs', style: 'margin:0' });
  toggle.appendChild(el('button', { class: `tab-btn${resultsView === 'ranked' ? ' active' : ''}`, onclick: () => { resultsView = 'ranked'; navigate('results', activeId); } }, 'Ranked list'));
  toggle.appendChild(el('button', { class: `tab-btn${resultsView === 'pipeline' ? ' active' : ''}`, onclick: () => { resultsView = 'pipeline'; navigate('results', activeId); } }, 'Pipeline'));
  bar.appendChild(toggle);
  wrap.appendChild(bar);

  const profile = Profiles.get(activeId);

  if (resultsView === 'pipeline') {
    // Pipeline keeps its search up top (it drives which stages expand).
    wrap.appendChild(renderSearchBox(navigate, activeId));
    wrap.appendChild(renderPipeline(navigate, profile, resultsSearch));
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

  // "Out of the running" = anyone who won't be getting THIS job: Future Fit
  // (parked), Rejected, and Out/Blackballed. Everyone else is active and sorts
  // to the top; the out group drops below a divider, ordered Future Fit →
  // Rejected → Out.
  const isOut = c => { const s = Stages.get(c.stage); return s && (s.kind === 'reject' || s.kind === 'parked'); };
  // Rank within the out group: Future Fit first, then Rejected, then Out.
  const outRank = c => (c.stage === 'future_fit' ? 0 : c.stage === 'rejected' ? 1 : c.stage === 'out' ? 2 : 1.5);
  const q = resultsSearch.trim().toLowerCase();
  const matchesSearch = c => !q || String(c.name || '').toLowerCase().includes(q);

  // Validate the saved stage filter against stages that actually have people.
  const stages = Stages.all();
  if (resultsStage && !all.some(c => c.stage === resultsStage)) resultsStage = '';

  // Base set: a specific stage shows just that stage; otherwise everyone.
  const base = (resultsStage ? all.filter(c => c.stage === resultsStage) : all)
    .filter(matchesSearch);

  const byScore = (a, b) => (b.result.score || 0) - (a.result.score || 0);
  const activeShown = base.filter(c => !isOut(c)).sort(byScore);
  // Out group: Future Fit → Rejected → Out, best-first within each.
  const outShown = base.filter(isOut).sort((a, b) => (outRank(a) - outRank(b)) || byScore(a, b));

  // Stage filter + search live on ONE row to save vertical space.
  wrap.appendChild(renderFilterBar(stages, all, navigate, activeId, true));

  wrap.appendChild(renderRankedList(activeShown, outShown, profile, navigate));
  return wrap;
}

// Filter bar for the ranked list: a stage dropdown + the name search, on one
// row. (Active vs rejected is shown inline via a divider in the list itself.)
function renderFilterBar(stages, all, navigate, activeId, withSearch) {
  const bar = el('div', { class: 'results-filterbar' });

  // Stage filter dropdown — "see everyone in that stage".
  const stageWrap = el('div', { class: 'filter-field' });
  stageWrap.appendChild(el('label', {}, 'Stage'));
  const sel = el('select');
  sel.appendChild(el('option', { value: '' }, `All stages (${all.length})`));
  stages.forEach(s => {
    const n = all.filter(c => c.stage === s.id).length;
    const o = el('option', { value: s.id }, `${s.label} (${n})`);
    if (s.id === resultsStage) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => { resultsStage = sel.value; navigate('results', activeId); });
  stageWrap.appendChild(sel);
  bar.appendChild(stageWrap);

  // Search box shares the row (grows to fill remaining width).
  if (withSearch) bar.appendChild(renderSearchBox(navigate, activeId));

  return bar;
}

// Candidate name search box. Filters the ranked list / pipeline below, and
// surfaces the matching candidates' current hiring stage for a quick lookup.
function renderSearchBox(navigate, activeId) {
  const row = el('div', { class: 'search-row filter-field' });
  row.appendChild(el('label', {}, 'Search'));

  const input = el('input', {
    type: 'search',
    placeholder: 'Search candidate by name…',
    value: resultsSearch,
    'aria-label': 'Search candidate by name',
  });
  // The app re-renders the whole view on navigate(), which recreates this
  // input. Re-focus and restore the caret so typing is never interrupted.
  if (searchHadFocus) {
    requestAnimationFrame(() => {
      input.focus();
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch { /* search inputs may reject */ }
    });
  }
  input.addEventListener('focus', () => { searchHadFocus = true; });
  input.addEventListener('blur', () => { searchHadFocus = false; });
  // Debounced re-render so we're not rebuilding the view on every keystroke.
  let t;
  input.addEventListener('input', () => {
    resultsSearch = input.value;
    clearTimeout(t);
    t = setTimeout(() => navigate('results', activeId), 160);
  });

  // Input + Clear sit on one line; chips (if any) flow below.
  const inputRow = el('div', { class: 'search-input-row' });
  inputRow.appendChild(input);
  if (resultsSearch.trim()) {
    inputRow.appendChild(el('button', {
      class: 'btn btn-sm btn-ghost',
      onclick: () => { resultsSearch = ''; navigate('results', activeId); },
    }, 'Clear'));
  }
  row.appendChild(inputRow);

  const box = row;

  // Quick stage lookup: list every match (across all stages) with its stage
  // badge, so you can tell where someone sits without scanning the table.
  const q = resultsSearch.trim().toLowerCase();
  if (q) {
    const matches = Candidates.byProfile(activeId)
      .filter(c => c.result && String(c.name || '').toLowerCase().includes(q))
      .sort((a, b) => (b.result.score || 0) - (a.result.score || 0));

    const hits = el('div', { class: 'search-hits' });
    if (!matches.length) {
      hits.appendChild(el('div', { class: 'muted', style: 'font-size:12px' }, `No candidates match “${esc(resultsSearch.trim())}”.`));
    } else {
      matches.forEach(c => {
        const chip = el('button', {
          class: 'search-hit',
          onclick: () => navigate('candidate', c.id),
          title: 'Open candidate',
        });
        chip.innerHTML = `<strong>${esc(c.name)}</strong><span class="badge ${stageBadgeClass(c.stage)}">${esc(Stages.label(c.stage))}</span>`;
        hits.appendChild(chip);
      });
    }
    box.appendChild(hits);
  }

  return box;
}

// Clean, scannable ranked list — one row per candidate, click to drill in.
// Everyone shows in a single list: active (still in the running) at the top,
// then a divider, then anyone rejected/out at the bottom.
function renderRankedList(activeCands, outCands, profile, navigate) {
  const threshold = profile.threshold != null ? profile.threshold : 60;
  const card = el('div', { class: 'card' });
  const allCands = [...activeCands, ...outCands];
  const total = allCands.length;

  const subRow = el('div', { class: 'row-between', style: 'margin-bottom:12px;align-items:center' });
  const bits = [`${total} candidate${total === 1 ? '' : 's'}`];
  if (outCands.length) bits.push(`${activeCands.length} in the running · ${outCands.length} out`);
  subRow.appendChild(el('div', { class: 'muted', style: 'font-size:12px' },
    `${bits.join(' · ')} · ranked best-first · threshold ${threshold}%. First-level screen — a human makes the final call.`));
  const exportBtn = el('button', { class: 'btn btn-sm', onclick: () => exportShortlist(allCands, profile) }, '⬇ Export / share shortlist');
  subRow.appendChild(exportBtn);
  card.appendChild(subRow);

  // Drop any stale selections (ids no longer in the list).
  compareSel = new Set([...compareSel].filter(id => allCands.some(c => c.id === id)));

  // Compare bar lives in a stable slot so we can refresh it in place when a
  // checkbox toggles — WITHOUT a full re-render (which would reset scroll).
  const compareSlot = el('div');
  card.appendChild(compareSlot);

  const renderCompareBar = () => {
    compareSlot.innerHTML = '';
    if (!compareSel.size) return;
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
    // Compare only makes sense for 2–4; hide it above 4 (bulk actions stay).
    if (compareSel.size >= 2 && compareSel.size <= 4) {
      right.appendChild(el('button', { class: 'btn btn-sm btn-primary', onclick: () => openCompare(ids, profile) }, 'Compare →'));
    } else if (compareSel.size > 4) {
      right.appendChild(el('span', { class: 'muted', style: 'font-size:12px;align-self:center' }, 'Compare fits up to 4'));
    }
    right.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { compareSel.clear(); renderCompareBar(); syncRowStates(); } }, 'Clear'));
    bar.appendChild(right);
    compareSlot.appendChild(bar);
  };

  // Empty state (e.g. a stage with nobody, or a search with no match).
  if (!total) {
    card.appendChild(el('div', { class: 'empty', style: 'padding:28px 16px' },
      html('<div class="big">🔍</div>'),
      el('p', { class: 'muted' }, 'No candidates match the current filters.')));
    return card;
  }

  const scroller = el('div', { class: 'rank-scroll' });
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

  // Track checkboxes so "Clear" can untick them without a full re-render.
  const checkboxes = new Map(); // id -> input
  const syncRowStates = () => {
    checkboxes.forEach((cb, id) => { cb.checked = compareSel.has(id); });
  };

  // Build a candidate row. `n` is the running rank number across both groups.
  const addRow = (c, n, dimmed) => {
    const r = c.result;
    const below = (r.score || 0) < threshold;
    const matchedN = (r.matched || []).length;
    const totalN = matchedN + (r.missing || []).length;
    const missReq = (r.missing || []).filter(m => m.required).length;

    const tr = el('tr', dimmed ? { class: 'is-out' } : {});
    const fitBits = [`${matchedN}/${totalN} criteria`];
    if (missReq) fitBits.push(`${missReq} required missing`);

    // Compare checkbox. Toggles selection and refreshes the compare bar in
    // place — no full re-render, so your scroll position stays put.
    const cbTd = el('td');
    const cb = el('input', { type: 'checkbox' });
    cb.checked = compareSel.has(c.id);
    checkboxes.set(c.id, cb);
    cb.onclick = (e) => {
      e.stopPropagation();
      if (cb.checked) compareSel.add(c.id);
      else compareSel.delete(c.id);
      renderCompareBar();
    };
    cbTd.appendChild(cb);
    tr.appendChild(cbTd);

    tr.insertAdjacentHTML('beforeend', `
      <td class="rank-num">#${n}</td>
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
    tr.querySelector('.c-name').addEventListener('click', () => navigate('candidate', c.id));
    tb.appendChild(tr);
  };

  let rank = 1;
  activeCands.forEach(c => addRow(c, rank++, false));

  // "Out of the running" section — people who won't get THIS job. Grouped and
  // ordered Future Fit → Rejected → Out, each with its own sub-label.
  if (outCands.length) {
    const divTr = el('tr', { class: 'rank-divider' });
    divTr.innerHTML = `<td colspan="7"><span>Out of the running (${outCands.length})</span></td>`;
    tb.appendChild(divTr);

    const groupLabel = c => c.stage === 'future_fit' ? 'Future Fit'
      : c.stage === 'rejected' ? 'Rejected'
      : c.stage === 'out' ? 'Out (Blackballed)'
      : Stages.label(c.stage);

    let lastGroup = null;
    outCands.forEach(c => {
      const g = groupLabel(c);
      if (g !== lastGroup) {
        const n = outCands.filter(x => groupLabel(x) === g).length;
        const subTr = el('tr', { class: 'rank-subdivider' });
        subTr.innerHTML = `<td colspan="7"><span>${esc(g)} (${n})</span></td>`;
        tb.appendChild(subTr);
        lastGroup = g;
      }
      addRow(c, rank++, true);
    });
  }

  table.appendChild(tb);
  scroller.appendChild(table);
  card.appendChild(scroller);

  renderCompareBar();  // show the bar if a selection carried over
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
  const p = c.parsed || {};

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
  // Edit + Delete live top-right of the candidate card.
  if (!editingDetails) {
    header.appendChild(el('button', { class: 'btn btn-sm', onclick: () => { editingDetails = true; navigate('candidate', c.id); } }, '✎ Edit details'));
  }
  header.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
    const ok = await confirmDialog({
      title: 'Delete this candidate?',
      message: `${c.name} will be removed from this position entirely. This can't be undone.`,
      confirmText: 'Delete', cancelText: 'Cancel', danger: true,
    });
    if (ok) { Candidates.remove(c.id); navigate('results', c.profileId); }
  } }, 'Delete'));
  card.appendChild(header);

  // Details — read-only cards, or an inline edit form. Name/email/phone/years
  // are auto-filled from the resume but fully editable here.
  if (editingDetails) {
    card.appendChild(renderDetailsEditor(c, navigate));
  } else {
    const contact = el('div', { class: 'grid grid-3', style: 'margin:16px 0' },
      miniField('Email', p.email), miniField('Phone', p.phone), miniField('Years', p.years != null ? String(p.years) : ''));
    card.appendChild(contact);
  }

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

// Inline editor for the auto-filled details (name, email, phone, years).
// Saves name at the top level and the rest into `parsed`.
function renderDetailsEditor(c, navigate) {
  const p = c.parsed || {};
  const box = el('div', { style: 'margin:16px 0' });

  const nameIn = el('input', { type: 'text', value: c.name || '', placeholder: 'Full name' });
  const emailIn = el('input', { type: 'email', value: p.email || '', placeholder: 'name@example.com' });
  const phoneIn = el('input', { type: 'tel', value: p.phone || '', placeholder: 'Phone' });
  const yearsIn = el('input', { type: 'number', value: p.years != null ? String(p.years) : '', placeholder: 'Years', min: '0', step: '1' });

  box.appendChild(labeled('Name', nameIn));
  const grid = el('div', { class: 'grid grid-3', style: 'margin-top:12px' });
  grid.appendChild(labeled('Email', emailIn));
  grid.appendChild(labeled('Phone', phoneIn));
  grid.appendChild(labeled('Years of experience', yearsIn));
  box.appendChild(grid);

  const err = el('div', { class: 'muted', style: 'color:var(--red);font-size:12px;margin-top:8px;display:none' });
  box.appendChild(err);

  const actions = el('div', { style: 'display:flex;gap:8px;margin-top:14px' });
  const save = el('button', { class: 'btn btn-primary btn-sm', onclick: () => {
    const name = nameIn.value.trim();
    if (!name) { err.textContent = 'Name can’t be empty.'; err.style.display = 'block'; return; }
    const yearsRaw = yearsIn.value.trim();
    let years = null;
    if (yearsRaw !== '') {
      years = Number(yearsRaw);
      if (!Number.isFinite(years) || years < 0) { err.textContent = 'Years must be a number of 0 or more.'; err.style.display = 'block'; return; }
    }
    const email = emailIn.value.trim();
    const phone = phoneIn.value.trim();
    Candidates.update(c.id, {
      name,
      parsed: { ...p, email, phone, years },
    });
    // Keep the linked global Person in sync so cross-job history & matching
    // reflect the correction too.
    if (c.personId) People.update(c.personId, { name, email, phone });
    editingDetails = false;
    navigate('candidate', c.id);
  } }, 'Save');
  const cancel = el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { editingDetails = false; navigate('candidate', c.id); } }, 'Cancel');
  actions.appendChild(save);
  actions.appendChild(cancel);
  box.appendChild(actions);

  // Submit on Enter from any field.
  [nameIn, emailIn, phoneIn, yearsIn].forEach(inp => inp.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); }));

  return box;
}

// Small labeled form control wrapper.
function labeled(label, control) {
  const d = el('div', { class: 'form-group', style: 'margin:0' });
  d.appendChild(el('label', {}, label));
  d.appendChild(control);
  return d;
}

// local html() to avoid circular import churn
function html(str) {
  const d = document.createElement('div');
  d.innerHTML = String(str).trim();
  return d.firstElementChild;
}
