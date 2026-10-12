// ── JOB POSITIONS VIEW ────────────────────────────────────────────────────────
// A job position is DATA — its criteria, weights, and required skills. Sales now;
// Accountant, Telecom Analyst, etc. later, no code changes. Positions can be
// Open (actively screening) or Archived (filled/closed, kept for the record).
import { Profiles, Candidates, Companies, Settings, WORKSPACES, EXAMPLE_ROLE_TEMPLATES } from '../data/db.js';
import { el, esc, uid, daysOpenLabel, fmtDate } from '../utils.js';
import { confirm as confirmDialog, alert as alertDialog } from '../ui/modal.js';

// Remember which tab (open/archived) the user last viewed, within the session.
let listFilter = 'open';
let listSearch = '';     // search box text
let listCompany = '';    // company filter ('' = all)

export function renderProfiles(navigate, selectedId) {
  if (selectedId === 'new') return renderEditor(navigate, null);
  if (selectedId) {
    const p = Profiles.get(selectedId);
    if (p) return renderEditor(navigate, p);
  }
  return renderList(navigate);
}

function renderList(navigate) {
  const ws = Settings.workspace();
  const openList = Profiles.open(ws);
  const archivedList = Profiles.archived(ws);
  const showing = listFilter === 'archived' ? archivedList : openList;
  const wrap = el('div');

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Job Positions'),
    el('button', { class: 'btn btn-primary btn-sm', onclick: () => navigate('profiles', 'new') }, '+ New Position'),
  ));

  // Open / Archived filter
  const filterRow = el('div', { class: 'tabs', style: 'margin:0 0 12px' });
  filterRow.appendChild(el('button', {
    class: `tab-btn${listFilter === 'open' ? ' active' : ''}`,
    onclick: () => { listFilter = 'open'; navigate('profiles'); },
  }, `Open (${openList.length})`));
  filterRow.appendChild(el('button', {
    class: `tab-btn${listFilter === 'archived' ? ' active' : ''}`,
    onclick: () => { listFilter = 'archived'; navigate('profiles'); },
  }, `Archived (${archivedList.length})`));
  card.appendChild(filterRow);

  // Resolve a display company name for a position (internal: Vimenture/Qualis;
  // staffing: the client company name).
  const companyName = p => ws === 'staffing' ? (Companies.name(p.companyId) || '—') : (p.company || '—');

  // Search + company filter toolbar.
  const companyOptions = [...new Set(showing.map(companyName).filter(c => c && c !== '—'))].sort();
  const toolbar = el('div', { style: 'display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap' });
  const search = el('input', { type: 'text', placeholder: 'Search positions…', value: listSearch, style: 'flex:1;min-width:200px' });
  search.addEventListener('input', () => {
    listSearch = search.value;
    applyFilter();
    // keep focus + caret after re-filter
    const pos = search.selectionStart;
    const again = toolbar.querySelector('input'); if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  });
  const coSel = el('select', { style: 'max-width:220px' });
  coSel.appendChild(el('option', { value: '' }, 'All companies'));
  companyOptions.forEach(c => { const o = el('option', { value: c }, c); if (c === listCompany) o.setAttribute('selected', 'selected'); coSel.appendChild(o); });
  coSel.addEventListener('change', () => { listCompany = coSel.value; applyFilter(); });
  toolbar.append(search, coSel);
  card.appendChild(toolbar);

  const tableMount = el('div');
  card.appendChild(tableMount);

  function applyFilter() {
    const q = listSearch.trim().toLowerCase();
    const filtered = showing.filter(p => {
      if (listCompany && companyName(p) !== listCompany) return false;
      if (q && !(`${p.role} ${p.summary || ''} ${companyName(p)}`.toLowerCase().includes(q))) return false;
      return true;
    });
    renderTable(filtered);
  }

  function renderTable(rows) {
    tableMount.innerHTML = '';
    if (!showing.length) {
      const e = el('div', { class: 'empty' });
      e.innerHTML = listFilter === 'archived'
        ? `<div class="big">🗂️</div><p>No archived positions. Archive a role once it's filled to keep its record here.</p>`
        : `<div class="big">🧩</div><p>No open positions yet.</p>`;
      tableMount.appendChild(e);
      return;
    }
    if (!rows.length) {
      tableMount.appendChild(el('div', { class: 'muted', style: 'padding:16px 0' }, 'No positions match your search / filter.'));
      return;
    }
    const isArchived = listFilter === 'archived';
    const staffing = ws === 'staffing';
    const money = n => '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toLocaleString('en-US');
    const table = el('table');
    table.innerHTML = `<thead><tr>
      <th>Position</th>
      <th>${staffing ? 'Client' : 'Company'}</th>
      ${staffing ? '<th>Bill/mo</th><th>Margin/mo</th>' : '<th>Criteria</th>'}
      <th>Resumes</th>
      <th>${isArchived ? 'Archived' : 'Days open'}</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');
    rows.forEach(p => {
      const req = (p.criteria || []).filter(c => c.required).length;
      const resumeCount = Candidates.byProfile(p.id).length;
      const timing = isArchived ? fmtDate(p.archivedAt) : daysOpenLabel(p.openedAt || p.createdAt);
      const roleCell = `<strong>${esc(p.role)}</strong>${p.priority === 'urgent' ? ' <span class="badge badge-red">Urgent</span>' : ''}<div class="muted" style="font-size:12px">${esc(p.summary || '')}</div>`;
      const co = esc(companyName(p));
      const tr = el('tr');
      if (staffing) {
        const m = Profiles.margin(p);
        tr.innerHTML = `
          <td>${roleCell}</td>
          <td>${co}</td>
          <td class="mono">${p.billRate ? money(p.billRate) : '—'}</td>
          <td class="mono ${m >= 0 ? 'text-green' : 'text-red'}">${p.billRate || p.payBudget ? money(m) : '—'}</td>
          <td>${resumeCount}</td>
          <td>${esc(timing)}</td>`;
      } else {
        tr.innerHTML = `
          <td>${roleCell}</td>
          <td><span class="badge badge-gray">${co}</span></td>
          <td>${(p.criteria || []).length} <span class="muted">(${req} required)</span></td>
          <td>${resumeCount}</td>
          <td>${esc(timing)}</td>`;
      }
      const td = el('td', { style: 'white-space:nowrap' });
      td.appendChild(el('button', { class: 'btn btn-sm', onclick: () => navigate('profiles', p.id) }, 'Edit'));
      if (isArchived) {
        td.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:6px', onclick: () => { Profiles.reopen(p.id); navigate('profiles'); } }, 'Reopen'));
      } else {
        td.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:6px', onclick: async () => {
          const ok = await confirmDialog({
            title: `Archive "${p.role}"?`,
            message: 'It stays on record under Archived and can be reopened anytime.',
            confirmText: 'Archive', cancelText: 'Keep open',
          });
          if (ok) { Profiles.archive(p.id); navigate('profiles'); }
        } }, 'Archive'));
      }
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    tableMount.appendChild(table);
  }

  applyFilter();
  wrap.appendChild(card);
  return wrap;
}

function renderEditor(navigate, profile) {
  const isNew = !profile;
  // Working copy of criteria we mutate in-memory until Save.
  const ws = Settings.workspace();
  const draft = {
    role: profile?.role || '',
    summary: profile?.summary || '',
    minYears: profile?.minYears || 0,
    threshold: profile?.threshold != null ? profile.threshold : 60,
    workspace: profile?.workspace || ws,
    company: profile?.company || (ws === 'internal' ? 'Vimenture' : ''),
    // Staffing commercial fields.
    companyId: profile?.companyId || '',
    billRate: profile?.billRate || '',
    payBudget: profile?.payBudget || '',
    payCurrency: profile?.payCurrency || 'USD',
    priority: profile?.priority || 'normal',
    criteria: profile ? JSON.parse(JSON.stringify(profile.criteria || [])) : [],
  };

  const wrap = el('div');
  const back = el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-bottom:14px', onclick: () => navigate('profiles') }, '← Back to positions');
  wrap.appendChild(back);

  const card = el('div', { class: 'card' });
  const header = el('div', { class: 'card-header' }, el('h2', {}, isNew ? 'New Position' : `Edit: ${esc(profile.role)}`));
  if (!isNew && profile.status === 'archived') {
    header.appendChild(el('span', { class: 'badge badge-gray', style: 'margin-left:auto' }, 'Archived'));
  }
  card.appendChild(header);

  const form = el('div');
  form.innerHTML = `
    <div class="form-row">
      <div class="form-group"><label>Role Title</label><input id="p-role" placeholder="e.g. Sales Representative" value="${esc(draft.role)}" /></div>
      <div class="form-group"><label>Minimum Years Experience</label><input id="p-years" type="number" min="0" step="1" value="${draft.minYears}" /></div>
    </div>
    <div class="form-group">
      <label>Interview threshold (%)</label>
      <input id="p-threshold" type="number" min="0" max="100" step="1" value="${draft.threshold}" />
      <div class="tag-hint">Candidates scoring below this are flagged "below threshold" and suggested for Will Not Interview. Nothing is auto-rejected — you decide.</div>
    </div>
    ${draft.workspace === 'internal' ? `
    <div class="form-group">
      <label>Hiring for</label>
      <select id="p-company">
        ${WORKSPACES.internal.companies.map(co => `<option value="${co}"${draft.company === co ? ' selected' : ''}>${co}</option>`).join('')}
      </select>
      <div class="tag-hint">Which internal company this role is for.</div>
    </div>` : `
    <div class="fieldset-title" style="margin:8px 0;font-weight:600;color:var(--text2);font-size:12px;text-transform:uppercase;letter-spacing:.05em">Client &amp; Commercials</div>
    <div class="form-group">
      <label>Client company</label>
      <select id="p-clientco">
        <option value="">— Select client —</option>
        ${Companies.all().map(c => `<option value="${esc(c.id)}"${draft.companyId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <div class="tag-hint">Which Kruew client this role is for. Add clients under the Companies tab.</div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Priority</label>
        <select id="p-priority">
          <option value="normal"${draft.priority === 'normal' ? ' selected' : ''}>Normal</option>
          <option value="urgent"${draft.priority === 'urgent' ? ' selected' : ''}>Urgent</option>
        </select>
      </div>
      <div class="form-group"><label>Bill rate — client pays (USD/mo)</label>
        <input id="p-bill" type="number" min="0" step="1" value="${draft.billRate}" placeholder="e.g. 3000" />
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Pay budget — worker</label>
        <input id="p-pay" type="number" min="0" step="1" value="${draft.payBudget}" placeholder="amount / month" />
      </div>
      <div class="form-group"><label>Pay currency</label>
        <select id="p-paycur">
          <option value="USD"${draft.payCurrency === 'USD' ? ' selected' : ''}>USD ($)</option>
          <option value="PHP"${draft.payCurrency === 'PHP' ? ' selected' : ''}>PHP (₱)</option>
        </select>
      </div>
    </div>
    <div class="explain" id="p-margin" style="margin-bottom:12px"></div>`}
    <div class="form-group"><label>Summary</label><textarea id="p-summary" placeholder="What this role is and what a great candidate looks like.">${esc(draft.summary)}</textarea></div>
    <div class="form-group">
      <label>Quick start from a template</label>
      <div class="chips" id="p-templates"></div>
      <div class="tag-hint">Adds a set of starter keywords you can then tune. Future-proofing in action.</div>
    </div>
  `;
  card.appendChild(form);

  // Staffing: live margin preview (bill − pay, PHP converted to USD).
  if (draft.workspace !== 'internal') {
    const marginBox = form.querySelector('#p-margin');
    const rate = Settings.get().phpPerUsd || 56;
    const money = n => '$' + (Math.round((parseFloat(n) || 0) * 100) / 100).toLocaleString('en-US');
    const updateMargin = () => {
      const bill = parseFloat(form.querySelector('#p-bill').value) || 0;
      let pay = parseFloat(form.querySelector('#p-pay').value) || 0;
      if (form.querySelector('#p-paycur').value === 'PHP') pay = pay / rate;
      const m = bill - pay;
      marginBox.innerHTML = `<strong>Est. monthly margin:</strong> ${money(m)}${bill > 0 ? ` (${Math.round(m / bill * 100)}% GP)` : ''}`;
      marginBox.style.borderLeftColor = m >= 0 ? 'var(--green)' : 'var(--red)';
    };
    ['#p-bill', '#p-pay', '#p-paycur'].forEach(sel => {
      const elx = form.querySelector(sel);
      elx.addEventListener('input', updateMargin);
      elx.addEventListener('change', updateMargin);
    });
    updateMargin();
  }

  // Template chips
  const tWrap = form.querySelector('#p-templates');
  Object.keys(EXAMPLE_ROLE_TEMPLATES).forEach(roleName => {
    const chip = el('button', { class: 'chip', onclick: () => {
      draft.criteria.push({ id: uid('CRIT'), label: `${roleName} skills`, kind: 'skill', keywords: [...EXAMPLE_ROLE_TEMPLATES[roleName]], weight: 3, required: false });
      renderCriteria();
    } }, `+ ${roleName}`);
    tWrap.appendChild(chip);
  });

  // Criteria editor
  const critCard = el('div', { class: 'card' });
  critCard.appendChild(el('div', { class: 'card-header' },
    el('h2', {}, 'Criteria'),
    el('button', { class: 'btn btn-sm', onclick: () => { draft.criteria.push(blankCriterion()); renderCriteria(); } }, '+ Add Criterion'),
  ));
  const critMount = el('div');
  critCard.appendChild(critMount);

  function renderCriteria() {
    critMount.innerHTML = '';
    if (!draft.criteria.length) {
      const e = el('div', { class: 'muted', style: 'padding:8px 0' }, 'No criteria yet. Add one, or use a template above.');
      critMount.appendChild(e);
      return;
    }
    draft.criteria.forEach((c, i) => critMount.appendChild(criterionRow(c, i)));
  }

  function criterionRow(c, i) {
    const box = el('div', { class: 'card', style: 'margin:0 0 10px;padding:14px' });
    box.innerHTML = `
      <div class="form-row">
        <div class="form-group" style="margin-bottom:8px"><label>Label</label><input data-f="label" value="${esc(c.label)}" placeholder="e.g. B2B sales experience" /></div>
        <div class="form-group" style="margin-bottom:8px"><label>Kind</label>
          <select data-f="kind">
            ${['skill','experience','education','certification','other'].map(k => `<option value="${k}"${c.kind===k?' selected':''}>${k}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:8px"><label>Keywords (comma separated)</label><input data-f="keywords" value="${esc((c.keywords||[]).join(', '))}" placeholder="salesforce, hubspot, crm" /></div>
      <div class="form-row">
        <div class="form-group" style="margin-bottom:0"><label>Weight (1–5)</label><input data-f="weight" type="number" min="1" max="5" value="${c.weight||1}" /></div>
        <div class="form-group" style="margin-bottom:0"><label>Required?</label>
          <select data-f="required"><option value="no"${!c.required?' selected':''}>No</option><option value="yes"${c.required?' selected':''}>Yes</option></select>
        </div>
      </div>
    `;
    // live-bind inputs back into the draft
    box.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('input', () => bind(c, inp));
      inp.addEventListener('change', () => bind(c, inp));
    });
    const rm = el('button', { class: 'btn btn-sm btn-danger', style: 'margin-top:10px', onclick: () => { draft.criteria.splice(i, 1); renderCriteria(); } }, 'Remove criterion');
    box.appendChild(rm);
    return box;
  }

  function bind(c, inp) {
    const f = inp.getAttribute('data-f');
    if (f === 'keywords') c.keywords = inp.value.split(',').map(s => s.trim()).filter(Boolean);
    else if (f === 'weight') c.weight = Math.max(1, Math.min(5, parseInt(inp.value, 10) || 1));
    else if (f === 'required') c.required = inp.value === 'yes';
    else c[f] = inp.value;
  }

  renderCriteria();

  // Save / delete
  const bar = el('div', { class: 'row-between', style: 'margin-top:4px' });
  bar.appendChild(el('div', { class: 'muted' }, 'Weights set importance; required criteria heavily penalize when missing.'));
  const right = el('div', { style: 'display:flex;gap:8px' });
  if (!isNew) {
    right.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
      const ok = await confirmDialog({
        title: 'Delete this position?',
        message: 'This permanently removes the position and its data. To keep its record instead, use Archive.',
        confirmText: 'Delete', cancelText: 'Cancel', danger: true,
      });
      if (ok) { Profiles.remove(profile.id); navigate('profiles'); }
    } }, 'Delete'));
    if (profile.status === 'archived') {
      right.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: () => { Profiles.reopen(profile.id); navigate('profiles'); } }, 'Reopen'));
    } else {
      right.appendChild(el('button', { class: 'btn btn-sm btn-ghost', onclick: async () => {
        const ok = await confirmDialog({
          title: `Archive "${profile.role}"?`,
          message: 'It stays on record under Archived and can be reopened anytime.',
          confirmText: 'Archive', cancelText: 'Keep open',
        });
        if (ok) { Profiles.archive(profile.id); navigate('profiles'); }
      } }, 'Archive'));
    }
  }
  right.appendChild(el('button', { class: 'btn btn-primary', onclick: async () => {
    const role = form.querySelector('#p-role').value.trim();
    if (!role) { await alertDialog({ title: 'Missing title', message: 'Please enter a position title.' }); form.querySelector('#p-role').focus(); return; }
    const companyEl = form.querySelector('#p-company');
    const payload = {
      role,
      summary: form.querySelector('#p-summary').value.trim(),
      minYears: parseFloat(form.querySelector('#p-years').value) || 0,
      threshold: Math.max(0, Math.min(100, parseInt(form.querySelector('#p-threshold').value, 10) || 0)),
      workspace: draft.workspace,
      company: companyEl ? companyEl.value : draft.company,
      criteria: draft.criteria,
    };
    // Staffing commercial fields (only present in staffing mode).
    if (draft.workspace !== 'internal') {
      payload.companyId = form.querySelector('#p-clientco').value;
      payload.billRate = parseFloat(form.querySelector('#p-bill').value) || 0;
      payload.payBudget = parseFloat(form.querySelector('#p-pay').value) || 0;
      payload.payCurrency = form.querySelector('#p-paycur').value;
      payload.priority = form.querySelector('#p-priority').value;
    }
    if (isNew) Profiles.create(payload);
    else Profiles.update(profile.id, payload);
    navigate('profiles');
  } }, isNew ? 'Create Position' : 'Save Changes'));
  bar.appendChild(right);

  wrap.appendChild(card);
  wrap.appendChild(critCard);
  wrap.appendChild(bar);
  return wrap;
}

function blankCriterion() {
  return { id: uid('CRIT'), label: '', kind: 'skill', keywords: [], weight: 3, required: false };
}
