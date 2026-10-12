// ── JOB POSITIONS VIEW ────────────────────────────────────────────────────────
// A job position is DATA — its criteria, weights, and required skills. Sales now;
// Accountant, Telecom Analyst, etc. later, no code changes. Positions can be
// Open (actively screening) or Archived (filled/closed, kept for the record).
import { Profiles, Candidates, Settings, WORKSPACES, EXAMPLE_ROLE_TEMPLATES } from '../data/db.js';
import { el, esc, uid, daysOpenLabel, fmtDate } from '../utils.js';
import { confirm as confirmDialog, alert as alertDialog } from '../ui/modal.js';

// Remember which tab (open/archived) the user last viewed, within the session.
let listFilter = 'open';

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

  if (!showing.length) {
    const e = el('div', { class: 'empty' });
    e.innerHTML = listFilter === 'archived'
      ? `<div class="big">🗂️</div><p>No archived positions. Archive a role once it's filled to keep its record here.</p>`
      : `<div class="big">🧩</div><p>No open positions yet.</p>`;
    card.appendChild(e);
  } else {
    const isArchived = listFilter === 'archived';
    const table = el('table');
    table.innerHTML = `<thead><tr>
      <th>Position</th><th>Criteria</th><th>Resumes</th>
      <th>${isArchived ? 'Archived' : 'Open for'}</th><th></th>
    </tr></thead>`;
    const tb = el('tbody');
    showing.forEach(p => {
      const req = (p.criteria || []).filter(c => c.required).length;
      const resumeCount = Candidates.byProfile(p.id).length;
      const timing = isArchived
        ? fmtDate(p.archivedAt)
        : daysOpenLabel(p.openedAt || p.createdAt);
      const tr = el('tr');
      tr.innerHTML = `
        <td><strong>${esc(p.role)}</strong><div class="muted" style="font-size:12px">${esc(p.summary || '')}</div></td>
        <td>${(p.criteria || []).length} <span class="muted">(${req} required)</span></td>
        <td>${resumeCount}</td>
        <td>${esc(timing)}</td>`;
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
    card.appendChild(table);
  }
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
    </div>` : ''}
    <div class="form-group"><label>Summary</label><textarea id="p-summary" placeholder="What this role is and what a great candidate looks like.">${esc(draft.summary)}</textarea></div>
    <div class="form-group">
      <label>Quick start from a template</label>
      <div class="chips" id="p-templates"></div>
      <div class="tag-hint">Adds a set of starter keywords you can then tune. Future-proofing in action.</div>
    </div>
  `;
  card.appendChild(form);

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
