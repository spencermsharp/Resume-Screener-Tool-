// ── BLACKBALL ─────────────────────────────────────────────────────────────────
// A shared do-not-hire list across BOTH workspaces. When a resume is screened,
// if the person's name or email matches an entry, they auto-drop to "Out".
import { Blacklist, Candidates, Stages } from '../data/db.js';
import { el, esc, fmtDate } from '../utils.js';
import { confirm as confirmDialog } from '../ui/modal.js';

export function renderBlacklist(navigate) {
  const wrap = el('div');
  const list = Blacklist.all();

  const banner = el('div', { class: 'banner banner-warn' });
  banner.innerHTML = `⛔ Anyone on this list is automatically moved to <strong>Out</strong> the moment their resume is screened — in either workspace. Match is by email or full name.`;
  wrap.appendChild(banner);

  // Add form
  const addCard = el('div', { class: 'card' });
  addCard.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Blackball a person')));
  const form = el('div', { class: 'form-row' });
  form.style.gridTemplateColumns = '1fr 1fr';
  form.innerHTML = `
    <div class="form-group"><label>Full name</label><input id="bl-name" placeholder="e.g. John Doe" /></div>
    <div class="form-group"><label>Email</label><input id="bl-email" type="email" placeholder="john@example.com" /></div>
    <div class="form-group"><label>Phone</label><input id="bl-phone" placeholder="e.g. +1 555 123 4567" /></div>
  `;
  addCard.appendChild(form);
  const reason = el('div', { class: 'form-group' });
  reason.innerHTML = `<label>Reason (optional, internal)</label><input id="bl-reason" placeholder="Why they're blackballed" />`;
  addCard.appendChild(reason);
  const addBtn = el('button', { class: 'btn btn-primary', onclick: () => {
    const name = addCard.querySelector('#bl-name').value.trim();
    const email = addCard.querySelector('#bl-email').value.trim();
    const phone = addCard.querySelector('#bl-phone').value.trim();
    if (!name && !email && !phone) return;
    Blacklist.add({ name, email, phone, reason: addCard.querySelector('#bl-reason').value.trim() });
    // Retro-apply: drop any already-screened candidate who matches to "Out".
    applyToExisting();
    navigate('blacklist');
  } }, 'Add to blackball');
  addCard.appendChild(addBtn);
  wrap.appendChild(addCard);

  // Existing list
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, `Blackballed (${list.length})`)));
  if (!list.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">⛔</div><p>No one blackballed yet.</p>`;
    card.appendChild(e);
  } else {
    const table = el('table');
    table.innerHTML = `<thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Reason</th><th style="width:110px">Added</th><th style="width:90px"></th></tr></thead>`;
    const tb = el('tbody');
    list.forEach(b => {
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${esc(b.name || '—')}</strong></td>
        <td>${esc(b.email || '—')}</td>
        <td>${esc(b.phone || '—')}</td>
        <td class="muted">${esc(b.reason || '')}</td>
        <td class="muted">${fmtDate(b.addedAt)}</td>`;
      const td = el('td');
      td.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        const ok = await confirmDialog({ title: 'Remove from blackball?', message: `${b.name || b.email} will no longer auto-drop to Out.`, confirmText: 'Remove', danger: true });
        if (ok) { Blacklist.remove(b.id); navigate('blacklist'); }
      } }, 'Remove'));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
  }
  wrap.appendChild(card);
  return wrap;
}

// When someone is newly blackballed, drop existing matching candidates to Out.
function applyToExisting() {
  Candidates.all().forEach(c => {
    if (c.stage === 'out') return;
    const hit = Blacklist.match({ name: c.name || c.parsed?.name, email: c.parsed?.email, phone: c.parsed?.phone });
    if (hit) Candidates.setStage(c.id, 'out', `Auto-moved to Out — blackball match (${hit.email || hit.phone || hit.name}).`);
  });
}
