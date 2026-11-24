// ── ACTIVITY (admin-only, read-only) ──────────────────────────────────────────
// Who did what, and what was saved: rows from public.audit_log, newest first.
import { el, esc } from '../utils.js';
import { isAdmin, Users } from '../auth/auth.js';
import { sbQuery, TABLE_MISSING } from '../data/sbRest.js';
import { AUDIT_TABLE } from '../data/audit.js';

const PAGE = 200;
const ENTITIES = [
  ['', 'Everything'], ['candidates', 'Candidates'], ['positions', 'Positions'], ['people', 'People'],
  ['blacklist', 'Blackball'], ['companies', 'Companies'], ['placements', 'Placements'],
  ['app_kv', 'Settings (stages, AI)'], ['app_users', 'Users & sign-ins'],
];
const ACTION_BADGE = { create: 'badge-green', update: 'badge-blue', delete: 'badge-red', login: 'badge-gray', logout: 'badge-gray', login_failed: 'badge-yellow' };

// Filters survive re-renders (background refresh, navigating away and back).
const filters = { user: '', entity: '', from: '', to: '' };

function queryFor(offset) {
  const q = ['select=*', 'order=at.desc', `limit=${PAGE}`, `offset=${offset}`];
  if (filters.user) q.push(`user_id=eq.${encodeURIComponent(filters.user)}`);
  if (filters.entity) q.push(`entity=eq.${encodeURIComponent(filters.entity)}`);
  // Dates are the admin's local days.
  if (filters.from) q.push(`at=gte.${encodeURIComponent(new Date(`${filters.from}T00:00:00`).toISOString())}`);
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`); end.setDate(end.getDate() + 1);
    q.push(`at=lt.${encodeURIComponent(end.toISOString())}`);
  }
  return q.join('&');
}

const fmtTime = iso => {
  try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
  catch { return iso || ''; }
};

export function renderActivity() {
  const wrap = el('div');
  if (!isAdmin()) {
    wrap.appendChild(el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Only admins can see the activity log.')));
    return wrap;
  }

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Activity'),
    el('span', { class: 'muted', style: 'font-size:12px' }, 'Every change, sign-in and sign-out, newest first. Read-only.')));

  // Filters
  const userSel = el('select', { id: 'act-user' });
  userSel.appendChild(el('option', { value: '' }, 'Everyone'));
  Users.all().slice().sort((a, b) => String(a.name || a.username).localeCompare(String(b.name || b.username)))
    .forEach(u => userSel.appendChild(el('option', { value: u.id }, `${u.name || u.username} (${u.username})`)));
  userSel.appendChild(el('option', { value: 'system' }, 'System'));
  const entSel = el('select', { id: 'act-entity' });
  ENTITIES.forEach(([v, l]) => entSel.appendChild(el('option', { value: v }, l)));
  const from = el('input', { type: 'date', id: 'act-from' });
  const to = el('input', { type: 'date', id: 'act-to' });
  // Set current filters as both value and default, so a background refresh
  // doesn't think the admin is mid-edit.
  const setInit = (f, v) => { f.value = v; if ('defaultValue' in f) f.defaultValue = v; };
  setInit(from, filters.from); setInit(to, filters.to);
  userSel.value = filters.user; entSel.value = filters.entity;
  [...userSel.options].forEach(o => { o.defaultSelected = o.value === filters.user; });
  [...entSel.options].forEach(o => { o.defaultSelected = o.value === filters.entity; });

  const filterRow = el('div', { style: 'display:grid;grid-template-columns:repeat(4,minmax(140px,1fr)) auto;gap:12px;align-items:end;margin-bottom:12px' },
    el('div', { class: 'form-group', style: 'margin:0' }, el('label', {}, 'User'), userSel),
    el('div', { class: 'form-group', style: 'margin:0' }, el('label', {}, 'What'), entSel),
    el('div', { class: 'form-group', style: 'margin:0' }, el('label', {}, 'From'), from),
    el('div', { class: 'form-group', style: 'margin:0' }, el('label', {}, 'To'), to));
  const clearBtn = el('button', { class: 'btn btn-sm btn-ghost' }, 'Clear');
  filterRow.appendChild(el('div', {}, clearBtn));
  card.appendChild(filterRow);

  const mount = el('div');
  card.appendChild(mount);
  wrap.appendChild(card);

  let offset = 0;
  const apply = () => {
    Object.assign(filters, { user: userSel.value, entity: entSel.value, from: from.value, to: to.value });
    setInit(from, filters.from); setInit(to, filters.to);
    [...userSel.options].forEach(o => { o.defaultSelected = o.value === filters.user; });
    [...entSel.options].forEach(o => { o.defaultSelected = o.value === filters.entity; });
    offset = 0; load(false);
  };
  [userSel, entSel, from, to].forEach(f => f.addEventListener('change', () => { f.blur(); apply(); }));
  clearBtn.onclick = () => { userSel.value = ''; entSel.value = ''; from.value = ''; to.value = ''; apply(); };

  const table = el('table', { class: 'rank-table' });
  table.innerHTML = '<thead><tr><th style="width:170px">When</th><th style="width:150px">Who</th><th style="width:100px">Action</th><th style="width:110px">What</th><th>Summary</th></tr></thead>';
  const tbody = el('tbody');
  table.appendChild(tbody);
  const more = el('button', { class: 'btn btn-sm', style: 'margin-top:12px' }, 'Load more');
  more.onclick = () => { offset += PAGE; load(true); };

  async function load(append) {
    if (!append) { mount.innerHTML = ''; mount.appendChild(el('div', { class: 'muted' }, 'Loading activity…')); }
    more.disabled = true;
    const rows = await sbQuery(AUDIT_TABLE, queryFor(offset));
    if (!append) mount.innerHTML = '';
    if (rows === TABLE_MISSING) {
      mount.appendChild(el('div', { class: 'banner banner-warn' },
        'The activity log table has not been created yet. Run supabase/add-audit-log.sql in the Supabase SQL Editor. Changes made until then are kept and uploaded automatically once it exists.'));
      return;
    }
    if (rows == null) {
      mount.appendChild(el('div', { class: 'banner banner-error' }, 'Could not load the activity log. Check the connection and try again.'));
      return;
    }
    if (!append) {
      if (!rows.length) { mount.appendChild(el('div', { class: 'empty' }, 'No activity matches these filters.')); return; }
      tbody.innerHTML = '';
      mount.appendChild(table);
      mount.appendChild(more);
    }
    rows.forEach(r => tbody.appendChild(rowFor(r)));
    more.disabled = false;
    more.style.display = rows.length < PAGE ? 'none' : '';
  }
  load(false);
  return wrap;
}

function rowFor(r) {
  const tr = el('tr');
  tr.innerHTML = `
    <td class="muted" style="white-space:nowrap;font-size:12px">${esc(fmtTime(r.at))}</td>
    <td>${esc(r.user_name || r.user_id || '—')}</td>
    <td><span class="badge ${ACTION_BADGE[r.action] || 'badge-gray'}">${esc(r.action || '')}</span></td>
    <td class="muted" style="font-size:12px">${esc(r.entity || '')}${r.entity_id ? `<div style="font-size:11px;word-break:break-all">${esc(r.entity_id)}</div>` : ''}</td>`;
  const td = el('td');
  td.appendChild(el('div', {}, r.summary || '—'));
  if (r.before != null || r.after != null) {
    const d = el('details', { style: 'margin-top:6px' });
    d.appendChild(el('summary', { class: 'muted', style: 'cursor:pointer;font-size:12px' }, 'Show before / after'));
    const grid = el('div', { class: 'grid grid-2', style: 'margin-top:8px' });
    [['Before', r.before], ['After', r.after]].forEach(([label, v]) => {
      const box = el('div');
      box.appendChild(el('div', { class: 'muted', style: 'font-size:11px;font-weight:600;margin-bottom:4px' }, label));
      const pre = el('div', { class: 'explain', style: 'white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:11px;max-height:320px;overflow:auto;border-left-color:var(--border)' });
      pre.textContent = v == null ? '—' : JSON.stringify(v, null, 2);
      box.appendChild(pre);
      grid.appendChild(box);
    });
    d.appendChild(grid);
    td.appendChild(d);
  }
  tr.appendChild(td);
  return tr;
}
