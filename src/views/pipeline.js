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

export function renderPipeline(navigate, profile, search = '') {
  const wrap = el('div', { class: 'card' });
  const stages = Stages.all();
  const cands = Candidates.byProfile(profile.id).filter(c => c.result);

  const q = String(search || '').trim().toLowerCase();
  const matches = c => !q || String(c.name || '').toLowerCase().includes(q);

  if (q) {
    const hitCount = cands.filter(matches).length;
    wrap.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:14px' },
      `${hitCount} match(es) for “${esc(search.trim())}”. Matching stages are expanded below.`));
  } else {
    wrap.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:14px' },
      `${cands.length} candidate(s) in the pipeline for "${esc(profile.role)}". Click a stage to see who's in it.`));
  }

  // Max count for bar scaling (ignore empty).
  const counts = stages.map(s => cands.filter(c => c.stage === s.id).length);
  const max = Math.max(1, ...counts);

  stages.forEach((stage, i) => {
    const inStage = cands.filter(c => c.stage === stage.id);
    const n = inStage.length;
    const stageMatches = inStage.filter(matches);
    // While searching, hide stages with no matching candidate to cut noise.
    if (q && !stageMatches.length) return;
    const row = el('div', { class: 'pf-row' });

    // While searching, auto-expand any stage that contains a match.
    const isOpen = q ? stageMatches.length > 0 : expanded === stage.id;

    const head = el('div', { class: 'pf-head', onclick: () => { expanded = expanded === stage.id ? null : stage.id; navigate('results', profile.id); } });
    head.innerHTML = `
      <div class="pf-label">${esc(stage.label)}</div>
      <div class="pf-track"><div class="pf-fill ${stageBarClass(stage)}" style="width:${Math.round((n / max) * 100)}%"></div></div>
      <div class="pf-count">${q ? `${stageMatches.length}/${n}` : n}</div>
      <div class="pf-caret">${isOpen ? '▾' : '▸'}</div>`;
    row.appendChild(head);

    // Expanded people list. While searching, only show matching people.
    if (isOpen) {
      const people = q ? stageMatches : inStage;
      const list = el('div', { class: 'pf-people' });
      if (!people.length) {
        list.appendChild(el('div', { class: 'muted', style: 'font-size:13px;padding:8px 0' }, 'No one in this stage.'));
      } else {
        people.sort((a, b) => (b.result.score || 0) - (a.result.score || 0)).forEach(c => {
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
