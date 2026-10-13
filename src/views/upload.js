// ── UPLOAD & SCREEN VIEW ──────────────────────────────────────────────────────
import { Profiles, Candidates, People, Blacklist, Settings, Stages } from '../data/db.js';
import { extractText, lightStructure } from '../data/parser.js';
import { screenCandidate } from '../data/screener.js';
import { el, esc, scoreClass } from '../utils.js';

// Store a resume PDF in Supabase Storage (bucket: 'resumes') via REST and return
// a public URL for preview. If Supabase isn't configured, returns '' (text still
// screens — preview is best-effort).
async function storePdf(file) {
  const { getConfig, isConfigured } = await import('../auth/supabaseClient.js');
  if (!isConfigured()) return '';
  const { supabaseUrl, supabaseAnonKey } = getConfig();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
  try {
    const r = await fetch(`${supabaseUrl}/storage/v1/object/resumes/${name}`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        'Content-Type': 'application/pdf',
      },
      body: file,
    });
    if (!r.ok) return '';
    return `${supabaseUrl}/storage/v1/object/public/resumes/${name}`;
  } catch { return ''; }
}

export function renderUpload(navigate) {
  const profiles = Profiles.open(Settings.workspace());
  const wrap = el('div');

  if (!profiles.length) {
    const card = el('div', { class: 'card' });
    const e = el('div', { class: 'empty' });
    e.innerHTML = `<div class="big">🧩</div><p>Create an open position first, then upload resumes to screen against it.</p>`;
    e.appendChild(el('button', { class: 'btn btn-primary', style: 'margin-top:12px', onclick: () => navigate('profiles', 'new') }, 'Create a position'));
    card.appendChild(e);
    wrap.appendChild(card);
    return wrap;
  }

  const state = { files: [], pastedText: '', pastedName: '' };

  const card = el('div', { class: 'card' });
  card.innerHTML = `<div class="card-header"><h2>Upload &amp; Screen Resumes</h2></div>`;

  const form = el('div');
  form.innerHTML = `
    <div class="form-group">
      <label>Screen against role</label>
      <select id="u-profile">${profiles.map(p => `<option value="${p.id}">${esc(p.role)}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label>Resumes</label>
      <div class="dropzone" id="dropzone">
        <div style="font-size:28px">📄</div>
        <div>Drag &amp; drop resumes here, or <strong>click to browse</strong></div>
        <div class="tag-hint">PDF and .txt supported. Scanned/image-only PDFs may not have extractable text.</div>
      </div>
      <div class="tag-hint">Drop a folder (even with subfolders) and we'll pull every resume out of it.</div>
      <input type="file" id="u-files" multiple accept=".txt,.pdf" style="display:none" />
      <input type="file" id="u-folder" webkitdirectory directory multiple style="display:none" />
      <div style="margin-top:8px">
        <button type="button" class="btn btn-sm btn-ghost" id="u-browse-folder">📁 Browse a folder…</button>
      </div>
      <ul class="file-list" id="file-list"></ul>
    </div>
    <div class="form-group">
      <label>…or paste a single resume's text</label>
      <input id="u-pname" placeholder="Candidate name (optional)" style="margin-bottom:8px" />
      <textarea id="u-ptext" placeholder="Paste resume text here to screen without a file."></textarea>
    </div>
    <div class="row-between" style="margin-top:4px">
      <div class="muted" id="u-hint">Screens with the rule-based baseline (or AI if enabled).</div>
      <button class="btn btn-primary" id="u-run">⚙️ Screen Candidates</button>
    </div>
    <div id="u-progress" style="display:none;margin-top:14px">
      <div class="row-between" style="margin-bottom:6px">
        <span class="muted" id="u-progress-label" style="font-size:13px">Preparing…</span>
        <span class="muted" id="u-progress-count" style="font-size:13px"></span>
      </div>
      <div style="height:10px;border-radius:6px;background:var(--border,#e5e7eb);overflow:hidden">
        <div id="u-progress-fill" style="height:100%;width:0%;background:var(--accent,#4f46e5);transition:width .2s ease"></div>
      </div>
    </div>
  `;
  card.appendChild(form);
  wrap.appendChild(card);

  const resultMount = el('div');
  wrap.appendChild(resultMount);

  // File handling
  const dz = form.querySelector('#dropzone');
  const fileInput = form.querySelector('#u-files');
  const fileListEl = form.querySelector('#file-list');

  const folderInput = form.querySelector('#u-folder');

  // Only keep files we can actually screen; ignore hidden/system junk.
  const SUPPORTED = /\.(txt|pdf)$/i;
  function isSupported(f) {
    const n = f.name || '';
    if (n.startsWith('.')) return false;            // .DS_Store and friends
    return SUPPORTED.test(n) || f.type === 'text/plain';
  }

  function renderFiles() {
    fileListEl.innerHTML = '';
    if (!state.files.length) return;
    const header = el('li', { style: 'font-weight:600;border:0' },
      `${state.files.length} file(s) ready`);
    header.appendChild(el('button', { class: 'btn btn-sm btn-ghost', style: 'margin-left:auto', onclick: () => { state.files = []; renderFiles(); } }, 'Clear all'));
    fileListEl.appendChild(header);
    state.files.forEach((f, i) => {
      const li = el('li');
      // Show the relative path when the file came from a folder, so nested
      // structure is visible (e.g. "2026-batch/sales/jane.pdf").
      const label = f._relPath || f.name;
      li.innerHTML = `<span>📎 ${esc(label)}</span>`;
      li.appendChild(el('button', { class: 'btn btn-sm btn-danger', onclick: () => { state.files.splice(i, 1); renderFiles(); } }, 'Remove'));
      fileListEl.appendChild(li);
    });
  }

  // De-dupe by path+size so dragging the same folder twice doesn't pile up.
  function addFiles(list) {
    const seen = new Set(state.files.map(f => `${f._relPath || f.name}:${f.size}`));
    let added = 0, ignored = 0;
    for (const f of list) {
      if (!isSupported(f)) { ignored++; continue; }
      const key = `${f._relPath || f.name}:${f.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.files.push(f);
      added++;
    }
    renderFiles();
    return { added, ignored };
  }

  // Recursively walk a dropped directory entry into a flat list of Files.
  // Each File gets a _relPath so we can show where it came from.
  function readEntry(entry, pathPrefix = '') {
    return new Promise(resolve => {
      if (entry.isFile) {
        entry.file(file => {
          try { file._relPath = pathPrefix + file.name; } catch { /* read-only in some browsers */ }
          resolve([file]);
        }, () => resolve([]));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        // readEntries returns in batches; keep calling until empty.
        const readBatch = () => reader.readEntries(async batch => {
          if (!batch.length) {
            const nested = await Promise.all(all.map(e => readEntry(e, pathPrefix + entry.name + '/')));
            resolve(nested.flat());
            return;
          }
          all.push(...batch);
          readBatch();
        }, () => resolve([]));
        readBatch();
      } else {
        resolve([]);
      }
    });
  }

  async function handleDrop(e) {
    const items = e.dataTransfer?.items;
    // Preferred path: DataTransferItemList supports folder recursion.
    if (items && items.length && items[0].webkitGetAsEntry) {
      const entries = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length) {
        const nested = await Promise.all(entries.map(en => readEntry(en)));
        const { added, ignored } = addFiles(nested.flat());
        flashHint(added, ignored);
        return;
      }
    }
    // Fallback: plain file list (no folder support in this browser).
    if (e.dataTransfer?.files) {
      const { added, ignored } = addFiles(e.dataTransfer.files);
      flashHint(added, ignored);
    }
  }

  function flashHint(added, ignored) {
    const hint = form.querySelector('#u-hint');
    if (!hint) return;
    const bits = [];
    if (added) bits.push(`Added ${added} file(s)`);
    if (ignored) bits.push(`ignored ${ignored} unsupported`);
    hint.textContent = bits.length ? bits.join(', ') + '.' : 'No supported files found (looking for .txt / .pdf).';
  }

  dz.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  form.querySelector('#u-browse-folder').addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', e => {
    // webkitdirectory populates webkitRelativePath; mirror it to _relPath.
    for (const f of e.target.files) { try { f._relPath = f.webkitRelativePath || f.name; } catch { /* ignore */ } }
    addFiles(e.target.files);
    e.target.value = '';
  });
  ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragover'); handleDrop(e); });

  // Run screening
  const runBtn = form.querySelector('#u-run');
  runBtn.addEventListener('click', async () => {
    const profileId = form.querySelector('#u-profile').value;
    const profile = Profiles.get(profileId);
    const pastedText = form.querySelector('#u-ptext').value.trim();
    const pastedName = form.querySelector('#u-pname').value.trim();

    const origLabel = runBtn.textContent;
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Screening…';

    // Progress bar: total work = files to parse + (parsed items + pasted) to screen.
    // We don't know how many files parse successfully up front, so we advance
    // the bar per unit of work completed, re-basing the total after parsing.
    const progress = form.querySelector('#u-progress');
    const fill = form.querySelector('#u-progress-fill');
    const label = form.querySelector('#u-progress-label');
    const count = form.querySelector('#u-progress-count');
    let done = 0;
    let total = state.files.length + (pastedText ? 1 : 0); // parse units + 1 screen unit for paste
    progress.style.display = 'block';
    const paint = (text) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 100;
      fill.style.width = `${pct}%`;
      if (text) label.textContent = text;
      count.textContent = `${done} / ${total} · ${pct}%`;
    };
    // Let the browser paint between async steps so the bar visibly moves.
    const tick = () => new Promise(r => requestAnimationFrame(() => r()));
    paint('Preparing…');

    try {
      const toScreen = []; // {name, fileName, rawText}
      const skipped = [];

      // ── Phase 1: parse files ────────────────────────────────────────────
      for (const f of state.files) {
        const displayName = f._relPath || f.name;
        label.textContent = `Reading ${displayName}`;
        await tick();
        try {
          const res = await extractText(f);
          if (res.ok && res.rawText.trim()) {
            // Dedupe/known-person detection BEFORE screening.
            const struct = lightStructure(res.rawText);
            const nm = struct.name || displayName;
            const banned = Blacklist.match({ name: nm, email: struct.email, phone: struct.phone });
            const known = banned ? null : People.match({ name: nm, email: struct.email, phone: struct.phone });
            toScreen.push({ fileName: displayName, rawText: res.rawText, file: f, _struct: struct, _banned: banned, _known: known });
          } else {
            skipped.push({ name: displayName, reason: res.reason || 'Could not read file.' });
          }
        } catch (err) {
          skipped.push({ name: displayName, reason: `Read failed: ${err.message || err}` });
        }
        done++;
        paint();
      }
      if (pastedText) toScreen.push({ fileName: '', rawText: pastedText, name: pastedName });

      if (!toScreen.length) {
        progress.style.display = 'none';
        renderResults([], skipped, profile, navigate, resultMount);
        return;
      }

      // Re-base totals for phase 2: parsing done, now one unit per screen.
      done = state.files.length;        // all parse units consumed
      total = state.files.length + toScreen.length;
      paint('Screening…');

      // ── Phase 2: screen each candidate ──────────────────────────────────
      const created = [];
      const duplicates = [];   // {name, stageLabel} — same person, same position
      const dedupe = { newN: 0, knownN: 0, bannedN: 0 };
      for (const item of toScreen) {
        const who = item.name || item.fileName || 'Pasted text';
        label.textContent = `Screening ${who}`;
        await tick();
        try {
          const struct = item._struct || lightStructure(item.rawText);

          // DUPLICATE CHECK (same person + same position, by email/phone):
          // resolve the person this resume belongs to, and if they already have
          // an application for THIS position, skip — keep the original.
          const person = People.match({ name: item.name || struct.name, email: struct.email, phone: struct.phone });
          if (person) {
            const dup = Candidates.findDuplicate(person.id, profileId);
            if (dup) {
              duplicates.push({ name: who, stageLabel: Stages.label(dup.stage), id: dup.id });
              done++; paint();
              continue; // don't create a second application
            }
          }

          if (item._banned) dedupe.bannedN++; else if (item._known) dedupe.knownN++; else dedupe.newN++;

          const result = await screenCandidate(item.rawText, profile);
          const banned = item._banned || Blacklist.match({ name: item.name || struct.name, email: struct.email, phone: struct.phone });
          const startStage = banned ? 'out' : 'screened';
          let pdfUrl = '';
          const isPdfFile = item.file && (item.file.type === 'application/pdf' || /\.pdf$/i.test(item.file.name || ''));
          if (isPdfFile) {
            try { pdfUrl = await storePdf(item.file); } catch { /* preview is best-effort */ }
          }

          const cand = Candidates.create({
            name: item.name || struct.name || item.fileName || 'Unknown Candidate',
            fileName: item.fileName,
            profileId,
            rawText: item.rawText,
            pdfUrl,
            parsed: { ...struct, years: result.yearsFound },
            result,
            stage: startStage,
          });
          if (banned) {
            Candidates.setStage(cand.id, 'out', `Auto-moved to Out — blackball match (${banned.email || banned.name || banned.phone}).`);
          }
          created.push(cand);
        } catch (err) {
          skipped.push({ name: who, reason: `Screening failed: ${err.message || err}` });
        }
        done++;
        paint();
      }
      label.textContent = 'Done';
      renderResults(created, skipped, profile, navigate, resultMount, dedupe, duplicates);
    } catch (err) {
      resultMount.innerHTML = '';
      const card = el('div', { class: 'card' });
      const b = el('div', { class: 'banner banner-warn' });
      b.innerHTML = `⚠️ Screening hit an unexpected error: ${esc(err.message || String(err))}`;
      card.appendChild(b);
      resultMount.appendChild(card);
      console.error('Screening error:', err);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = origLabel;
      // Leave the bar visible briefly at 100%, then hide it.
      setTimeout(() => { progress.style.display = 'none'; }, 1200);
    }
  });

  return wrap;
}

function renderResults(created, skipped, profile, navigate, mount, dedupe, duplicates) {
  mount.innerHTML = '';
  const card = el('div', { class: 'card' });
  card.appendChild(el('div', { class: 'card-header' }, el('h2', {}, 'Screening Complete')));

  // Dedupe summary (known / new / blackballed).
  if (dedupe && (dedupe.knownN || dedupe.bannedN)) {
    const d = el('div', { class: 'banner banner-info' });
    const bits = [`${dedupe.newN} new`];
    if (dedupe.knownN) bits.push(`${dedupe.knownN} already in your system`);
    if (dedupe.bannedN) bits.push(`${dedupe.bannedN} blackballed → auto-moved to Out`);
    d.innerHTML = `👤 ${bits.join(' · ')}.`;
    card.appendChild(d);
  }

  // Duplicate summary — same person already applied to THIS position.
  if (duplicates && duplicates.length) {
    const d = el('div', { class: 'banner banner-warn' });
    d.innerHTML = `♊ ${duplicates.length} duplicate(s) skipped (same person already applied to this role):<br>`
      + duplicates.map(x => `• ${esc(x.name)} — kept the existing application (currently ${esc(x.stageLabel)})`).join('<br>');
    card.appendChild(d);
  }

  if (skipped.length) {
    const b = el('div', { class: 'banner banner-warn' });
    b.innerHTML = `⚠️ ${skipped.length} file(s) couldn't be screened:<br>${skipped.map(s => `• ${esc(s.name)} — ${esc(s.reason || 'unknown')}`).join('<br>')}`;
    card.appendChild(b);
  }

  if (!created.length) {
    card.appendChild(el('p', { class: 'muted' }, 'No candidates were screened. Try a .txt file or the paste box.'));
    mount.appendChild(card);
    return;
  }

  card.appendChild(el('div', { class: 'banner banner-info' }, `✅ Screened ${created.length} candidate(s) against "${profile.role}".`));
  mount.appendChild(card);

  // ── AI TRIAGE: auto-sort into Clear yes / Borderline / Clear no ───────────
  const threshold = profile.threshold != null ? profile.threshold : 60;
  const BAND = 12; // borderline window around the threshold
  const notBanned = created.filter(c => c.stage !== 'out');
  const groups = {
    yes:   { title: '✅ Clear yes — meets the bar', color: 'var(--green)', items: [] },
    maybe: { title: '🤔 Borderline — worth a look', color: 'var(--yellow)', items: [] },
    no:    { title: '❌ Clear no — below the bar', color: 'var(--red)', items: [] },
  };
  notBanned.forEach(c => {
    const s = c.result?.score || 0;
    if (s >= threshold + BAND) groups.yes.items.push(c);
    else if (s >= threshold - BAND) groups.maybe.items.push(c);
    else groups.no.items.push(c);
  });

  const triageCard = el('div', { class: 'card' });
  triageCard.appendChild(el('div', { class: 'card-header' }, el('h3', {}, 'AI triage — act in bulk, then review'),
    el('button', { class: 'btn btn-sm btn-primary', onclick: () => navigate('results', profile.id) }, 'Open full results →')));
  triageCard.appendChild(el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:12px' },
    `Sorted around the ${threshold}% threshold. Spend your time on the borderline group — bulk-act on the obvious yes/no.`));

  Object.entries(groups).forEach(([key, g]) => {
    if (!g.items.length) return;
    const section = el('div', { style: 'margin-bottom:14px' });
    const head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px' });
    head.appendChild(el('span', { style: `font-weight:700;color:${g.color}` }, `${g.title} · ${g.items.length}`));

    // Bulk actions per group.
    const bulk = el('span', { style: 'margin-left:auto;display:flex;gap:6px' });
    const ids = g.items.map(c => c.id);
    if (key === 'yes') {
      bulk.appendChild(bulkBtn('→ Advance all to HR', () => { ids.forEach(id => Candidates.setStage(id, 'hr', 'Bulk-advanced to HR from triage.')); navigate('results', profile.id); }));
    }
    if (key === 'maybe') {
      bulk.appendChild(bulkBtn('All → Future Fit', () => { ids.forEach(id => Candidates.setStage(id, 'future_fit', 'Bulk-parked in Future Fit from triage.')); navigate('results', profile.id); }));
    }
    if (key === 'no') {
      bulk.appendChild(bulkBtn('Reject all', () => { ids.forEach(id => Candidates.setStage(id, 'rejected', 'Bulk-rejected from triage.')); navigate('results', profile.id); }, 'btn-danger'));
      bulk.appendChild(bulkBtn('All → Future Fit', () => { ids.forEach(id => Candidates.setStage(id, 'future_fit', 'Bulk-parked in Future Fit from triage.')); navigate('results', profile.id); }));
    }
    head.appendChild(bulk);
    section.appendChild(head);

    g.items.sort((a, b) => (b.result.score || 0) - (a.result.score || 0)).forEach(c => {
      const row = el('div', { class: 'triage-row', onclick: () => navigate('candidate', c.id) });
      row.innerHTML = `<span class="score-chip ${scoreClass(c.result.score)}">${c.result.score}</span><strong>${esc(c.name)}</strong>`;
      section.appendChild(row);
    });
    triageCard.appendChild(section);
  });

  mount.appendChild(triageCard);
  mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bulkBtn(label, onclick, extra = '') {
  return el('button', { class: `btn btn-sm ${extra}`, onclick: (e) => { e.stopPropagation(); onclick(); } }, label);
}
