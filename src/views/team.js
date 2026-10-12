// ── TEAM (user management) ────────────────────────────────────────────────────
// Admin-only. Add users, reset passwords, change roles, remove. Everything
// in-app via the admin-users Edge Function — no email, no Supabase dashboard.
import { el, esc } from '../utils.js';
import { currentUser, isAdmin, Users, changeOwnPassword } from '../auth/auth.js';
import { confirm as confirmDialog, prompt as promptDialog, alert as alertDialog } from '../ui/modal.js';

export function renderTeam(navigate) {
  const wrap = el('div');

  if (!isAdmin()) {
    // Non-admins can still change their own password here.
    wrap.appendChild(ownPasswordCard());
    return wrap;
  }

  // Add-user form
  const addCard = el('div', { class: 'card' });
  addCard.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Add a user')));
  const form = el('div');
  form.innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>Name</label><input id="t-name" placeholder="Full name" /></div>
      <div class="form-group"><label>Username</label><input id="t-username" placeholder="e.g. jsmith" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Temporary password</label><input id="t-pass" placeholder="They can change it after login" /></div>
      <div class="form-group"><label>Role</label>
        <select id="t-role"><option value="user" selected>User</option><option value="admin">Admin</option></select>
      </div>
    </div>
    <div class="tag-hint">No email is sent. You hand them the username + temporary password. Only admins can add users.</div>
  `;
  addCard.appendChild(form);
  const addBtn = el('button', { class: 'btn btn-primary', style: 'margin-top:10px' }, 'Create user');
  addBtn.onclick = async () => {
    const username = form.querySelector('#t-username').value.trim();
    const password = form.querySelector('#t-pass').value;
    const name = form.querySelector('#t-name').value.trim();
    const role = form.querySelector('#t-role').value;
    if (!username || !password) { await alertDialog({ title: 'Missing info', message: 'Username and temporary password are required.' }); return; }
    addBtn.disabled = true; addBtn.textContent = 'Creating…';
    try {
      await Users.create({ username, password, name, role });
      navigate('team');
    } catch (e) {
      addBtn.disabled = false; addBtn.textContent = 'Create user';
      await alertDialog({ title: 'Could not create user', message: e.message || String(e) });
    }
  };
  addCard.appendChild(addBtn);
  wrap.appendChild(addCard);

  // User list
  const listCard = el('div', { class: 'card' });
  listCard.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Users')));
  const mount = el('div');
  mount.appendChild(el('div', { class: 'muted' }, 'Loading users…'));
  listCard.appendChild(mount);
  wrap.appendChild(listCard);

  Users.list().then(users => renderUserList(mount, users, navigate)).catch(e => {
    mount.innerHTML = '';
    const b = el('div', { class: 'banner banner-warn' }, `Could not load users: ${esc(e.message || String(e))}`);
    mount.appendChild(b);
  });

  // Own password (admins too)
  wrap.appendChild(ownPasswordCard());
  return wrap;
}

function renderUserList(mount, users, navigate) {
  mount.innerHTML = '';
  const me = currentUser();
  const table = el('table');
  table.innerHTML = `<thead><tr><th>Name</th><th>Username</th><th>Role</th><th style="width:260px"></th></tr></thead>`;
  const tb = el('tbody');
  users.forEach(u => {
    const tr = el('tr');
    tr.innerHTML = `
      <td><strong>${esc(u.name || '—')}</strong>${u.id === me.id ? ' <span class="badge badge-gray">You</span>' : ''}</td>
      <td>${esc(u.username || u.email || '')}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-orange' : 'badge-gray'}">${esc(u.role)}</span></td>`;
    const td = el('td', { style: 'white-space:nowrap' });

    td.appendChild(el('button', { class: 'btn btn-sm', onclick: async () => {
      const np = await promptDialog({ title: `Reset password`, message: `New password for ${u.username || u.email}:`, placeholder: 'New password', confirmText: 'Reset' });
      if (np && np.trim()) {
        try { await Users.resetPassword(u.id, np.trim()); await alertDialog({ title: 'Done', message: 'Password reset. Hand them the new password.' }); }
        catch (e) { await alertDialog({ title: 'Failed', message: e.message || String(e) }); }
      }
    } }, 'Reset password'));

    const toggleRole = u.role === 'admin' ? 'user' : 'admin';
    td.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:6px', onclick: async () => {
      const ok = await confirmDialog({ title: `Make ${toggleRole}?`, message: `Change ${u.name || u.email} to ${toggleRole}?`, confirmText: 'Change' });
      if (ok) {
        try { await Users.setRole(u.id, toggleRole); navigate('team'); }
        catch (e) { await alertDialog({ title: 'Failed', message: e.message || String(e) }); }
      }
    } }, `Make ${toggleRole}`));

    if (u.id !== me.id) {
      td.appendChild(el('button', { class: 'btn btn-sm btn-danger', style: 'margin-left:6px', onclick: async () => {
        const ok = await confirmDialog({ title: 'Remove user?', message: `${u.username || u.email} will lose access immediately.`, confirmText: 'Remove', danger: true });
        if (ok) {
          try { await Users.remove(u.id); navigate('team'); }
          catch (e) { await alertDialog({ title: 'Failed', message: e.message || String(e) }); }
        }
      } }, 'Remove'));
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  mount.appendChild(table);
}

function ownPasswordCard() {
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h3', {}, 'Change my password')));
  const inp = el('input', { type: 'password', placeholder: 'New password', style: 'max-width:280px' });
  const btn = el('button', { class: 'btn btn-primary btn-sm', style: 'margin-left:8px' }, 'Update');
  btn.onclick = async () => {
    if (!inp.value.trim()) return;
    try { await changeOwnPassword(inp.value.trim()); inp.value = ''; await alertDialog({ title: 'Done', message: 'Your password was updated.' }); }
    catch (e) { await alertDialog({ title: 'Failed', message: e.message || String(e) }); }
  };
  const row = el('div', { style: 'display:flex;align-items:center' }, inp, btn);
  card.appendChild(row);
  return card;
}
