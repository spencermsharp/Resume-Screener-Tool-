// ── COMPANIES (Kruew staffing clients) ────────────────────────────────────────
// Client companies you place talent with. Each has basic info + contacts.
import { Companies, Placements, Profiles } from '../data/db.js';
import { el, esc } from '../utils.js';
import { confirm as confirmDialog, prompt as promptDialog, alert as alertDialog } from '../ui/modal.js';

export function renderCompanies(navigate, selectedId) {
  if (selectedId === 'new') return renderEditor(navigate, null);
  if (selectedId) {
    const c = Companies.get(selectedId);
    if (c) return renderEditor(navigate, c);
  }
  return renderList(navigate);
}

function renderList(navigate) {
  const wrap = el('div');
  const companies = Companies.all();

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Client Companies'),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => navigate('companies', 'new') }, '+ New Company'),
  ));

  if (!companies.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🏢</div><p>No client companies yet. Add the companies Kruew places talent with.</p>`;
    card.appendChild(e);
  } else {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Company</th><th>Industry</th><th>Contacts</th><th>Active placements</th><th style="width:90px"></th></tr></thead>`;
    const tb = el('tbody');
    companies.forEach(c => {
      const active = Placements.active().filter(p => p.companyId === c.id).length;
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${esc(c.name)}</strong></td>
        <td>${esc(c.industry || '—')}</td>
        <td>${(c.contacts || []).length}</td>
        <td>${active}</td>`;
      const td = el('td');
      td.appendChild(el('button', { class: 'btn btn-sm', onclick: () => navigate('companies', c.id) }, 'Edit'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
  }
  wrap.appendChild(card);
  return wrap;
}

function renderEditor(navigate, company) {
  const isNew = !company;
  const contacts = company ? JSON.parse(JSON.stringify(company.contacts || [])) : [];
  const wrap = el('div');
  wrap.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-bottom:14px', onclick: () => navigate('companies') }, '← Back to companies'));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, isNew ? 'New Company' : `Edit: ${esc(company.name)}`)));
  const form = el('div');
  form.innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>Company Name</label><input id="c-name" placeholder="e.g. Acme Logistics" value="${esc(company?.name || '')}" /></div>
      <div class="form-group"><label>Industry</label><input id="c-industry" placeholder="e.g. SaaS" value="${esc(company?.industry || '')}" /></div>
    </div>
    <div class="form-group"><label>Notes</label><textarea id="c-notes" placeholder="Anything worth remembering">${esc(company?.notes || '')}</textarea></div>
  `;
  card.appendChild(form);

  // Contacts
  const contactsCard = el('div', { class: 'card' });
  contactsCard.appendChild(el('div', { class: 'card-header' },
    el('h3', {}, 'Contacts'),
    el('button', { class: 'btn btn-sm', onclick: async () => {
      const name = await promptDialog({ title: 'Add contact', message: 'Contact name', confirmText: 'Add' });
      if (name && name.trim()) { contacts.push({ id: 'ct_' + Date.now().toString(36), name: name.trim(), title: '', email: '', phone: '' }); renderContacts(); }
    } }, '+ Add contact'),
  ));
  const contactsMount = el('div');
  contactsCard.appendChild(contactsMount);

  function renderContacts() {
    contactsMount.innerHTML = '';
    if (!contacts.length) { contactsMount.appendChild(el('div', { class: 'muted', style: 'padding:6px 0' }, 'No contacts yet.')); return; }
    contacts.forEach((ct, i) => {
      const box = el('div', { class: 'card', style: 'margin:0 0 8px;padding:12px' });
      box.innerHTML = `
        <div class="form-row">
          <div class="form-group" style="margin:0"><label>Name</label><input data-f="name" value="${esc(ct.name)}" /></div>
          <div class="form-group" style="margin:0"><label>Title</label><input data-f="title" value="${esc(ct.title || '')}" /></div>
        </div>
        <div class="form-row" style="margin-top:8px">
          <div class="form-group" style="margin:0"><label>Email</label><input data-f="email" value="${esc(ct.email || '')}" /></div>
          <div class="form-group" style="margin:0"><label>Phone</label><input data-f="phone" value="${esc(ct.phone || '')}" /></div>
        </div>`;
      box.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('input', () => { ct[inp.getAttribute('data-f')] = inp.value; }));
      box.appendChild(el('button', { class: 'btn btn-sm btn-danger', style: 'margin-top:8px', onclick: () => { contacts.splice(i, 1); renderContacts(); } }, 'Remove'));
      contactsMount.appendChild(box);
    });
  }
  renderContacts();

  const bar = el('div', { class: 'row-between', style: 'margin-top:4px' });
  const right = el('div', { style: 'display:flex;gap:8px' });
  if (!isNew) {
    right.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
      const hasPlacements = Placements.all().some(p => p.companyId === company.id);
      if (hasPlacements) { await alertDialog({ title: 'Cannot delete', message: 'This company has placements. Archive those first.' }); return; }
      const ok = await confirmDialog({ title: 'Delete company?', message: `${company.name} will be removed.`, confirmText: 'Delete', danger: true });
      if (ok) { Companies.remove(company.id); navigate('companies'); }
    } }, 'Delete'));
  }
  right.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
    const name = form.querySelector('#c-name').value.trim();
    if (!name) { await alertDialog({ title: 'Missing name', message: 'Please enter a company name.' }); return; }
    const payload = { name, industry: form.querySelector('#c-industry').value.trim(), notes: form.querySelector('#c-notes').value.trim(), contacts };
    if (isNew) Companies.create(payload); else Companies.update(company.id, payload);
    navigate('companies');
  } }, isNew ? 'Create Company' : 'Save Changes'));
  bar.appendChild(el('div'));
  bar.appendChild(right);

  wrap.appendChild(card);
  wrap.appendChild(contactsCard);
  wrap.appendChild(bar);
  return wrap;
}
