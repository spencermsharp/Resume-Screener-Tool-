// ── FUTURE FIT ────────────────────────────────────────────────────────────────
// People who are good but not right for the role right now — parked for later.
// Scoped to the current workspace. From here you can re-open them against any
// open position (moves them back into that position's pipeline at Screened).
import { Profiles, Candidates, Settings, Stages } from '../data/db.js';
import { el, esc, scoreClass, fmtDate } from '../utils.js';
import { prompt as promptDialog, confirm as confirmDialog } from '../ui/modal.js';

export function renderFutureFit(navigate) {
  const ws = Settings.workspace();
  const wrap = el('div');

  // Positions in this workspace, to resolve which candidates belong here.
  const wsProfileIds = new Set(Profiles.byWorkspace(ws).map(p => p.id));
  const parked = Candidates.all()
    .filter(c => c.stage === 'future_fit' && wsProfileIds.has(c.profileId))
    .sort((a, b) => (b.result?.score || 0) - (a.result?.score || 0));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Future Fit')));
  card.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:12px' },
    'Strong people kept warm for later. Re-open one against any open position when the timing is right.'));

  if (!parked.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🌱</div><p>No one parked in Future Fit yet. Move a candidate here from their detail page.</p>`;
    card.appendChild(e);
    wrap.appendChild(card);
    return wrap;
  }

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th style="width:70px">Score</th><th>Candidate</th><th>Originally for</th>
    <th style="width:120px">Parked</th><th style="width:220px"></th>
  </tr></thead>`;
  const tb = el('tbody');

  parked.forEach(c => {
    const prof = Profiles.get(c.profileId);
    const score = c.result?.score ?? 0;
    const tr = el('tr');
    tr.innerHTML = `
      <td><span class="score-chip ${scoreClass(score)}">${score}</span></td>
      <td><strong>${esc(c.name)}</strong><div class="muted" style="font-size:12px">${esc(c.parsed?.email || '')}</div></td>
      <td>${esc(prof?.role || '—')}</td>
      <td class="muted">${fmtDate(c.createdAt)}</td>`;
    const td = el('td', { style: 'white-space:nowrap' });
    td.appendChild(el('button', { class: 'btn btn-sm', onclick: () => navigate('candidate', c.id) }, 'Open'));
    td.appendChild(el('button', { class: 'btn btn-sm btn-primary', style: 'margin-left:6px', onclick: () => reopen(c, ws, navigate) }, 'Re-open for role'));
    tr.appendChild(td);
    tb.appendChild(tr);
  });

  table.appendChild(tb);
  card.appendChild(table);
  wrap.appendChild(card);
  return wrap;
}

// Move a parked candidate back into an open position's pipeline (at Screened).
async function reopen(c, ws, navigate) {
  const openPositions = Profiles.open(ws);
  if (!openPositions.length) {
    await confirmDialog({ title: 'No open positions', message: 'Create an open position first, then re-open this person into it.', confirmText: 'OK', cancelText: '' });
    return;
  }
  // Simple picker via prompt listing options (kept lightweight).
  const choices = openPositions.map((p, i) => `${i + 1}. ${p.role}`).join('\n');
  const pick = await promptDialog({
    title: `Re-open ${c.name}`,
    message: `Type the number of the position to move them into:\n${choices}`,
    placeholder: '1',
    confirmText: 'Move',
  });
  if (pick == null) return;
  const idx = parseInt(pick, 10) - 1;
  const target = openPositions[idx];
  if (!target) return;
  Candidates.update(c.id, { profileId: target.id });
  Candidates.setStage(c.id, 'screened', `Re-opened from Future Fit into ${target.role}.`);
  navigate('results', target.id);
}
