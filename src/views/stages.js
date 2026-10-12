// ── HIRING STAGES SETTINGS ────────────────────────────────────────────────────
// Edit the pipeline stages (DATA, not code): add an interviewer, rename, reorder,
// or remove a custom stage. Candidates reference stages by stable id, so renaming
// is safe and reordering just changes the pipeline flow. Built-in essentials
// (Screened, Hired, Rejected) can't be removed.
import { Stages, Candidates } from '../data/db.js';
import { el, esc } from '../utils.js';
import { confirm as confirmDialog, prompt as promptDialog } from '../ui/modal.js';

const KIND_LABEL = { screen: 'Screening', parked: 'Parked', reject: 'Rejection', interview: 'Interview', offer: 'Offer', hired: 'Hired' };
const PROTECTED = new Set(['screened', 'hired', 'rejected']);

export function renderStages(navigate) {
  const wrap = el('div');
  const stages = Stages.all();

  const banner = el('div', { class: 'banner banner-info' });
  banner.innerHTML = `🪜 These are the stages every candidate moves through. Add interviewers, rename, or reorder to match your process. Changes apply across all positions.`;
  wrap.appendChild(banner);

  const card = el('div', { class: 'card' });
  const head = el('div', { class: 'card-header' }, el('h2', {}, 'Hiring Stages'));
  const addBtn = el('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
    const name = await promptDialog({ title: 'Add interview stage', message: 'Name this stage (e.g. "Technical Interview").', placeholder: 'Stage name', confirmText: 'Add' });
    if (name && name.trim()) { Stages.add(name.trim(), 'interview'); navigate('stages'); }
  } }, '+ Add stage');
  head.appendChild(addBtn);
  card.appendChild(head);

  const table = el('table');
  table.innerHTML = `<thead><tr>
    <th style="width:60px">Order</th><th>Stage</th><th style="width:120px">Type</th>
    <th style="width:110px">In use</th><th style="width:200px"></th>
  </tr></thead>`;
  const tb = el('tbody');

  stages.forEach((s, i) => {
    const inUse = Candidates.all().filter(c => c.stage === s.id).length;
    const tr = el('tr');
    tr.innerHTML = `
      <td class="muted">${i + 1}</td>
      <td><strong>${esc(s.label)}</strong></td>
      <td><span class="badge badge-gray">${esc(KIND_LABEL[s.kind] || s.kind)}</span></td>
      <td>${inUse}</td>`;
    const actions = el('td', { style: 'white-space:nowrap' });

    // Reorder
    const up = el('button', { class: 'btn btn-sm btn-ghost', title: 'Move up', onclick: () => { Stages.move(s.id, -1); navigate('stages'); } }, '↑');
    const down = el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:4px', title: 'Move down', onclick: () => { Stages.move(s.id, 1); navigate('stages'); } }, '↓');
    if (i === 0) up.disabled = true;
    if (i === stages.length - 1) down.disabled = true;
    actions.append(up, down);

    // Rename
    actions.appendChild(el('button', { class: 'btn btn-sm', style: 'margin-left:6px', onclick: async () => {
      const name = await promptDialog({ title: 'Rename stage', value: s.label, confirmText: 'Save' });
      if (name && name.trim()) { Stages.rename(s.id, name.trim()); navigate('stages'); }
    } }, 'Rename'));

    // Remove (not for protected built-ins)
    if (!PROTECTED.has(s.id)) {
      actions.appendChild(el('button', { class: 'btn btn-sm btn-danger', style: 'margin-left:6px', onclick: async () => {
        if (inUse > 0) {
          await confirmDialog({ title: 'Stage in use', message: `${inUse} candidate(s) are in "${s.label}". Move them to another stage before removing it.`, confirmText: 'OK', cancelText: '' });
          return;
        }
        const ok = await confirmDialog({ title: `Remove "${s.label}"?`, message: 'This removes the stage from the pipeline.', confirmText: 'Remove', danger: true });
        if (ok) { Stages.remove(s.id); navigate('stages'); }
      } }, 'Remove'));
    }

    tr.appendChild(actions);
    tb.appendChild(tr);
  });

  table.appendChild(tb);
  card.appendChild(table);

  const resetRow = el('div', { style: 'margin-top:14px' });
  resetRow.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
    const ok = await confirmDialog({ title: 'Reset stages?', message: 'Restore the default pipeline. Candidates keep their current stage where ids still match.', confirmText: 'Reset', danger: true });
    if (ok) { Stages.reset(); navigate('stages'); }
  } }, 'Reset to defaults'));
  card.appendChild(resetRow);

  wrap.appendChild(card);
  return wrap;
}
