// ── FUTURE FIT (GLOBAL shared pool) ───────────────────────────────────────────
// One recyclable pool across ALL companies (Vimenture, Qualis, every Kruew
// client). De-duped by person. Re-open anyone into ANY open position — the app
// creates a NEW application for that person on the chosen job, keeping history.
import { Profiles, Candidates, People, Stages } from '../data/db.js';
import { el, esc, scoreClass, fmtDate } from '../utils.js';
import { open as openModal, confirm as confirmDialog } from '../ui/modal.js';

export function renderFutureFit(navigate) {
  const wrap = el('div');
  const pool = Candidates.futureFitPool(); // global, de-duped by person

  const banner = el('div', { class: 'banner banner-info' });
  banner.innerHTML = `♻️ <strong>Future Fit</strong> is one shared pool across all companies. Re-open anyone into any open position — a fresh application is created and their full history is kept.`;
  wrap.appendChild(banner);

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, `Future Fit pool (${pool.length})`)));

  if (!pool.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🌱</div><p>No one parked yet. On a candidate, choose "Future Fit" to keep them for later.</p>`;
    card.appendChild(e);
    wrap.appendChild(card);
    return wrap;
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th style="width:64px">Score</th><th>Candidate</th><th>Originally for</th>
    <th style="width:110px">Parked</th><th style="width:230px"></th>
  </tr></thead>`;
  const tb = el('tbody');

  pool.forEach(c => {
    const prof = Profiles.get(c.profileId);
    const score = c.result?.score ?? 0;
    const months = monthsSince(c.createdAt);
    const expiring = months >= 6;
    const tr = el('tr', { class: expiring ? 'ff-expiring' : '' });
    tr.innerHTML = `
      <td><span class="score-chip ${scoreClass(score)}">${score}</span></td>
      <td><strong class="ff-name" data-person="${esc(c.personId || '')}">${esc(c.name)}</strong>
          <div class="muted" style="font-size:12px">${esc(c.parsed?.email || '')}</div></td>
      <td>${esc(prof?.role || '—')}${prof ? ` <span class="muted">· ${esc(prof.company || prof.workspace || '')}</span>` : ''}</td>
      <td class="muted">${fmtDate(c.createdAt)}${expiring ? '<div class="badge badge-yellow" style="margin-top:3px">expiring</div>' : ''}</td>`;
    const td = el('td', { style: 'white-space:nowrap' });
    td.appendChild(el('button', { class: 'btn btn-sm', onclick: () => navigate('candidate', c.id) }, 'Open'));
    td.appendChild(el('button', { class: 'btn btn-sm btn-primary', style: 'margin-left:6px', onclick: () => reopen(c, navigate) }, 'Pull into a role'));
    td.appendChild(el('button', { class: 'btn btn-sm btn-danger', style: 'margin-left:6px', onclick: async () => {
      const ok = await confirmDialog({
        title: `Remove ${c.name} from Future Fit?`,
        message: 'They’ll be dropped from the recyclable pool. This removes this parked application.',
        confirmText: 'Remove', cancelText: 'Cancel', danger: true,
      });
      if (ok) { Candidates.remove(c.id); navigate('futurefit'); }
    } }, 'Remove'));
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  card.appendChild(table);
  wrap.appendChild(card);

  // Make names open the person's full history (candidate detail).
  setTimeout(() => {
    wrap.querySelectorAll('.ff-name').forEach(n => n.addEventListener('click', () => {
      const pid = n.dataset.person;
      const first = Candidates.all().find(c => c.personId === pid);
      if (first) navigate('candidate', first.id);
    }));
  }, 0);
  return wrap;
}

function monthsSince(dateStr) {
  if (!dateStr) return 0;
  const then = new Date(dateStr);
  if (isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24 * 30)));
}

// Re-open a pooled person into any open position via a clean dropdown modal.
function reopen(c, navigate) {
  const openPositions = Profiles.open(); // ALL open positions, any company
  const body = el('div');
  if (!openPositions.length) {
    body.innerHTML = `<p class="muted">No open positions. Create one first, then pull this person into it.</p>`;
    openModal({ title: `Re-open ${c.name}`, body, actions: [{ label: 'OK', value: true, variant: 'primary', isDefault: true, isCancel: true }] });
    return;
  }
  body.innerHTML = `<p class="muted" style="margin-bottom:10px">Pick an open position to move <strong>${esc(c.name)}</strong> into. A new application is created at the Screened stage; their history is kept.</p>`;
  const sel = el('select', { style: 'width:100%' });
  openPositions.forEach(p => {
    const ws = p.workspace === 'staffing' ? 'Kruew' : (p.company || 'Internal');
    sel.appendChild(el('option', { value: p.id }, `${p.role} — ${ws}`));
  });
  body.appendChild(sel);

  openModal({
    title: `Re-open ${c.name}`,
    body,
    actions: [
      { label: 'Cancel', value: null, variant: 'ghost', isCancel: true },
      { label: 'Pull into role', value: 'go', variant: 'primary', isDefault: true },
    ],
  }).then(res => {
    if (res !== 'go') return;
    const target = Profiles.get(sel.value);
    if (!target) return;
    // Guard: if this person already has an application on the target job, don't
    // create a duplicate — just jump to that job's results.
    const dupe = Candidates.byProfile(target.id).find(x => x.personId && x.personId === c.personId);
    if (dupe) { navigate('results', target.id); return; }
    // Create a NEW application for the same person on the chosen job.
    Candidates.create({
      personId: c.personId,
      name: c.name,
      fileName: c.fileName,
      profileId: target.id,
      rawText: c.rawText,
      pdfUrl: c.pdfUrl,
      parsed: c.parsed,
      result: c.result,                 // carry the prior score as a starting point
      stage: 'screened',
    });
    navigate('results', target.id);
  });
}
