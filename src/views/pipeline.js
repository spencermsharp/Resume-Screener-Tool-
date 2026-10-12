// ── PIPELINE SUMMARY ──────────────────────────────────────────────────────────
// A dashboard of how many candidates sit in each stage for one position — the
// funnel at a glance. Click a stage to expand the people in it.
import { Candidates, Stages } from '../data/db.js';
import { el, esc, scoreClass } from '../utils.js';

// Remember which stage is expanded, within the session.
let expanded = null;

function stageBarClass(stage) {
  return { screen: 'pf-blue', parked: 'pf-blue', interview: 'pf-orange', offer: 'pf-yellow', hired: 'pf-green', reject: 'pf-red' }[stage.kind] || 'pf-gray';
}

export function renderPipeline(navigate, profile) {
  const wrap = el('div', { class: 'card' });
  const stages = Stages.all();
  const cands = Candidates.byProfile(profile.id).filter(c => c.result);

  wrap.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:14px' },
    `${cands.length} candidate(s) in the pipeline for "${esc(profile.role)}". Click a stage to see who's in it.`));

  // Max count for bar scaling (ignore empty).
  const counts = stages.map(s => cands.filter(c => c.stage === s.id).length);
  const max = Math.max(1, ...counts);

  stages.forEach((stage, i) => {
    const inStage = cands.filter(c => c.stage === stage.id);
    const n = inStage.length;
    const row = el('div', { class: 'pf-row' });

    const head = el('div', { class: 'pf-head', onclick: () => { expanded = expanded === stage.id ? null : stage.id; navigate('results', profile.id); } });
    head.innerHTML = `
      <div class="pf-label">${esc(stage.label)}</div>
      <div class="pf-track"><div class="pf-fill ${stageBarClass(stage)}" style="width:${Math.round((n / max) * 100)}%"></div></div>
      <div class="pf-count">${n}</div>
      <div class="pf-caret">${expanded === stage.id ? '▾' : '▸'}</div>`;
    row.appendChild(head);

    // Expanded people list.
    if (expanded === stage.id) {
      const list = el('div', { class: 'pf-people' });
      if (!n) {
        list.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:8px 0' }, 'No one in this stage.'));
      } else {
        inStage.sort((a, b) => (b.result.score || 0) - (a.result.score || 0)).forEach(c => {
          const p = el('div', { class: 'pf-person', onclick: () => navigate('candidate', c.id) });
          p.innerHTML = `<span class="score-chip ${scoreClass(c.result.score)}">${c.result.score}</span><strong>${esc(c.name)}</strong>`;
          list.appendChild(p);
        });
      }
      row.appendChild(list);
    }
    wrap.appendChild(row);
  });

  return wrap;
}
