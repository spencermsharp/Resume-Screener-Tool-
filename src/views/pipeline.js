// ── PIPELINE BOARD ────────────────────────────────────────────────────────────
// Candidates grouped by hiring stage for one position. Drag a card between
// columns to move a candidate through the process (forward OR backward — real
// hiring is non-linear). Every move is logged to the candidate's stage history.
import { Candidates, Stages } from '../data/db.js';
import { el, esc, scoreClass } from '../utils.js';

export function renderPipeline(navigate, profile) {
  const wrap = el('div', { class: 'card' });
  const stages = Stages.all();
  const cands = Candidates.byProfile(profile.id).filter(c => c.result);

  wrap.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:12px' },
    `Drag a candidate between stages to move them. ${cands.length} in pipeline for "${esc(profile.role)}".`));

  const board = el('div', { class: 'pipeline' });

  stages.forEach(stage => {
    const col = el('div', { class: 'pipeline-col', 'data-stage': stage.id });
    const inStage = cands.filter(c => c.stage === stage.id);
    const headerRight = el('span', { class: 'badge badge-gray' }, String(inStage.length));
    const h = el('h4', {}, el('span', {}, stage.label));
    h.appendChild(headerRight);
    col.appendChild(h);

    inStage
      .sort((a, b) => (b.result.score || 0) - (a.result.score || 0))
      .forEach(c => col.appendChild(pipelineCard(c, navigate)));

    // Drop handling
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-target'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drop-target');
      const candId = e.dataTransfer.getData('text/candidate');
      if (!candId) return;
      const c = Candidates.get(candId);
      if (!c || c.stage === stage.id) return;
      const from = Stages.label(c.stage);
      Candidates.setStage(candId, stage.id, `Moved from ${from} to ${stage.label} (pipeline).`);
      navigate('results', profile.id);
    });

    board.appendChild(col);
  });

  wrap.appendChild(board);
  return wrap;
}

function pipelineCard(c, navigate) {
  const card = el('div', { class: 'pipeline-card', draggable: 'true' });
  const score = c.result?.score ?? 0;
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <span class="score-chip ${scoreClass(score)}" style="min-width:30px;height:20px;font-size:12px">${score}</span>
      <span class="pc-name">${esc(c.name)}</span>
    </div>
    <div class="pc-meta">${esc(c.fileName || 'pasted text')}</div>
  `;
  card.addEventListener('click', () => navigate('candidate', c.id));
  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/candidate', c.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}
