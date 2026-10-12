// ── PLACEMENTS (Kruew staffing — active hires + margin) ───────────────────────
// Workers placed at client companies, with bill rate (client pays), pay rate
// (worker receives), and the margin Kruew keeps. This is the revenue layer.
import { Placements, Companies } from '../data/db.js';
import { el, esc, fmtDate } from '../utils.js';
import { confirm as confirmDialog, alert as alertDialog } from '../ui/modal.js';

function money(n) { return '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toLocaleString('en-US'); }

export function renderPlacements(navigate, selectedId) {
  if (selectedId === 'new') return renderEditor(navigate, null);
  if (selectedId) {
    const p = Placements.get(selectedId);
    if (p) return renderEditor(navigate, p);
  }
  return renderList(navigate);
}

function renderList(navigate) {
  const wrap = el('div');
  const active = Placements.active();

  // KPI strip
  const rev = active.reduce((s, p) => s + (parseFloat(p.billRate) || 0), 0);
  const pay = active.reduce((s, p) => s + (parseFloat(p.payRate) || 0), 0);
  const margin = rev - pay;
  const kpis = el('div', { class: 'grid grid-3' },
    kpi('Active Placements', active.length, 'currently billing'),
    kpi('Monthly Revenue', money(rev), 'billed to clients'),
    kpi('Monthly Margin', money(margin), rev > 0 ? Math.round(margin / rev * 100) + '% GP' : '—'),
  );
  wrap.appendChild(kpis);

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Placements'),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => navigate('placements', 'new') }, '+ New Placement'),
  ));

  if (!active.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">👥</div><p>No active placements. Add one, or convert a hired candidate from Results.</p>`;
    card.appendChild(e);
  } else {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Worker</th><th>Company</th><th>Bill/mo</th><th>Pay/mo</th><th>Margin</th><th>Started</th><th style="width:140px"></th></tr></thead>`;
    const tb = el('tbody');
    active.forEach(p => {
      const m = Placements.margin(p);
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${esc(p.workerName)}</strong><div class="muted" style="font-size:12px">${esc(p.workerRole || '')}</div></td>
        <td>${esc(Companies.name(p.companyId) || '—')}</td>
        <td class="mono">${money(p.billRate)}</td>
        <td class="mono">${money(p.payRate)}</td>
        <td class="mono ${m >= 0 ? 'text-green' : 'text-red'}">${money(m)}</td>
        <td class="muted">${fmtDate(p.startDate)}</td>`;
      const td = el('td', { style: 'white-space:nowrap' });
      td.appendChild(el('button', { class: 'btn btn-sm', onclick: () => navigate('placements', p.id) }, 'Edit'));
      td.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:6px', onclick: async () => {
        const ok = await confirmDialog({ title: 'Archive placement?', message: `${p.workerName} will be archived (history kept).`, confirmText: 'Archive' });
        if (ok) { Placements.archive(p.id); navigate('placements'); }
      } }, 'Archive'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
  }
  wrap.appendChild(card);
  return wrap;
}

function renderEditor(navigate, placement) {
  const isNew = !placement;
  const companies = Companies.all();
  const wrap = el('div');
  wrap.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-bottom:14px', onclick: () => navigate('placements') }, '← Back to placements'));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, isNew ? 'New Placement' : `Edit: ${esc(placement.workerName)}`)));
  const form = el('div');
  form.innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>Worker Name</label><input id="pl-name" value="${esc(placement?.workerName || '')}" /></div>
      <div class="form-group"><label>Role</label><input id="pl-role" value="${esc(placement?.workerRole || '')}" /></div>
    </div>
    <div class="form-group"><label>Company</label>
      <select id="pl-company">
        <option value="">— Select company —</option>
        ${companies.map(c => `<option value="${c.id}"${placement?.companyId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Bill Rate (client pays, $/mo)</label><input id="pl-bill" type="number" min="0" value="${placement?.billRate || ''}" /></div>
      <div class="form-group"><label>Pay Rate (worker receives, $/mo)</label><input id="pl-pay" type="number" min="0" value="${placement?.payRate || ''}" /></div>
    </div>
    <div class="form-group"><label>Start Date</label><input id="pl-start" type="date" value="${esc(placement?.startDate || '')}" /></div>
    <div class="explain" id="pl-margin" style="margin-bottom:12px"></div>
  `;
  card.appendChild(form);

  const marginBox = form.querySelector('#pl-margin');
  function updateMargin() {
    const bill = parseFloat(form.querySelector('#pl-bill').value) || 0;
    const pay = parseFloat(form.querySelector('#pl-pay').value) || 0;
    const m = bill - pay;
    marginBox.innerHTML = `<strong>Margin:</strong> ${money(m)}${bill > 0 ? ` (${Math.round(m / bill * 100)}%)` : ''}`;
  }
  form.querySelector('#pl-bill').addEventListener('input', updateMargin);
  form.querySelector('#pl-pay').addEventListener('input', updateMargin);
  updateMargin();

  const bar = el('div', { class: 'row-between', style: 'margin-top:4px' });
  const right = el('div', { style: 'display:flex;gap:8px' });
  if (!isNew) {
    right.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
      const ok = await confirmDialog({ title: 'Delete placement?', message: `${placement.workerName} will be removed.`, confirmText: 'Delete', danger: true });
      if (ok) { Placements.remove(placement.id); navigate('placements'); }
    } }, 'Delete'));
  }
  right.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
    const workerName = form.querySelector('#pl-name').value.trim();
    if (!workerName) { await alertDialog({ title: 'Missing name', message: 'Please enter the worker name.' }); return; }
    const payload = {
      workerName,
      workerRole: form.querySelector('#pl-role').value.trim(),
      companyId: form.querySelector('#pl-company').value,
      billRate: form.querySelector('#pl-bill').value,
      payRate: form.querySelector('#pl-pay').value,
      startDate: form.querySelector('#pl-start').value,
    };
    if (isNew) Placements.create(payload); else Placements.update(placement.id, payload);
    navigate('placements');
  } }, isNew ? 'Create Placement' : 'Save Changes'));
  bar.appendChild(el('div'));
  bar.appendChild(right);

  wrap.appendChild(card);
  wrap.appendChild(bar);
  return wrap;
}

function kpi(label, value, sub) {
  const d = el('div', { class: 'kpi' });
  d.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>`;
  return d;
}
