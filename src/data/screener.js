/**
 * SCREENING ENGINE — Vimenture Resume Screener
 * ------------------------------------------------------------------
 * Role-AGNOSTIC: it screens a resume against whatever criteria a
 * profile defines, so the SAME engine serves Sales, Accountant,
 * Telecom Analyst, or any future role with no code changes.
 *
 * TWO MODES:
 *   1. screenRuleBased()  — works today, no network, fully transparent.
 *   2. screenWithAI()     — ⚠️ SEAM for the IDE handoff. Not wired yet.
 *
 * `screenCandidate()` picks the mode based on Settings.ai.enabled, so
 * the rest of the app doesn't care which engine ran. Both return the
 * same shape:
 *   { score:0-100, matched:[{label,weight}], missing:[{label,weight,required}],
 *     yearsFound, explanation:string, engine:'rules'|'ai' }
 *
 * RESPONSIBLE-USE NOTE: this is a FIRST-LEVEL screen to surface and
 * explain candidates. A human makes the hiring decision. Criteria and
 * prompts should describe the JOB, never protected characteristics
 * (age, gender, race, religion, national origin, disability, etc.).
 */

import { Settings } from './db.js';

// Rough years-of-experience sniff from resume text (baseline heuristic).
export function extractYears(text) {
  if (!text) return 0;
  const t = text.toLowerCase();
  let best = 0;
  // "X years" patterns
  for (const m of t.matchAll(/(\d{1,2})\+?\s*(?:years|yrs)\b/g)) {
    best = Math.max(best, parseInt(m[1], 10) || 0);
  }
  // Year ranges like 2015-2021 / 2015 – present
  for (const m of t.matchAll(/(19|20)\d{2}\s*[-–to]+\s*((19|20)\d{2}|present|current)/g)) {
    const start = parseInt(m[0].slice(0, 4), 10);
    const endStr = m[0].slice(-4);
    const end = /present|current/i.test(m[0]) ? new Date().getFullYear() : parseInt(endStr, 10);
    if (start && end && end >= start) best = Math.max(best, end - start);
  }
  return best;
}

function countKeywordHits(text, keywords) {
  const t = (text || '').toLowerCase();
  const hits = [];
  for (const kw of keywords) {
    if (!kw) continue;
    if (t.includes(String(kw).toLowerCase())) hits.push(kw);
  }
  return hits;
}

/**
 * RULE-BASED BASELINE
 * Weighted keyword matching across the profile's criteria + a years check.
 */
export function screenRuleBased(resumeText, profile) {
  const criteria = profile.criteria || [];
  const matched = [];
  const missing = [];

  let earned = 0;
  let possible = 0;

  for (const c of criteria) {
    const w = c.weight || 1;
    possible += w;
    const hits = countKeywordHits(resumeText, c.keywords || []);
    if (hits.length) {
      earned += w;
      matched.push({ label: c.label, weight: w, hits });
    } else {
      missing.push({ label: c.label, weight: w, required: !!c.required });
    }
  }

  // Base score from weighted criteria.
  let score = possible > 0 ? (earned / possible) * 100 : 0;

  // Required-but-missing criteria apply a hard penalty.
  const missedRequired = missing.filter(m => m.required);
  if (missedRequired.length) score *= Math.max(0.4, 1 - 0.3 * missedRequired.length);

  // Years-of-experience check against profile.minYears.
  const yearsFound = extractYears(resumeText);
  if (profile.minYears && yearsFound) {
    if (yearsFound < profile.minYears) score *= 0.85; // short on experience
    else if (yearsFound >= profile.minYears * 2) score = Math.min(100, score * 1.05); // well over
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    matched,
    missing,
    yearsFound,
    explanation: buildExplanation({ profile, score, matched, missing, missedRequired, yearsFound }),
    engine: 'rules',
  };
}

/**
 * Human-readable "why" — assembled from the structured result so it's
 * transparent and defensible. (The AI version will produce richer prose.)
 */
function buildExplanation({ profile, score, matched, missing, missedRequired, yearsFound }) {
  const parts = [];
  const strongest = [...matched].sort((a, b) => b.weight - a.weight).slice(0, 3);

  if (score >= 75) parts.push(`Strong match for ${profile.role}.`);
  else if (score >= 50) parts.push(`Possible match for ${profile.role}, with gaps.`);
  else parts.push(`Weak match for ${profile.role}.`);

  if (strongest.length) {
    parts.push(`Meets key criteria: ${strongest.map(m => m.label).join(', ')}.`);
  }
  if (missedRequired.length) {
    parts.push(`Missing REQUIRED: ${missedRequired.map(m => m.label).join(', ')}.`);
  }
  const niceMisses = missing.filter(m => !m.required);
  if (niceMisses.length) {
    parts.push(`Not evidenced: ${niceMisses.map(m => m.label).join(', ')}.`);
  }
  if (yearsFound) {
    parts.push(`~${yearsFound} yrs experience detected${profile.minYears ? ` (role targets ${profile.minYears}+)` : ''}.`);
  } else {
    parts.push(`Years of experience could not be reliably detected from the text.`);
  }
  parts.push(`First-level screen only — please review the full resume before deciding.`);
  return parts.join(' ');
}

/**
 * AI ENGINE — Anthropic Claude via the server-side proxy (POST /api/screen).
 * ------------------------------------------------------------------
 * The API key lives ONLY on the server (serve.py reads ANTHROPIC_API_KEY).
 * This function never sees it — it just posts the prompt and resume text.
 *
 * The prompt passes EVERY criterion the profile defines (label, weight,
 * required flag, kind) plus role/summary/minYears, so the model reasons
 * over ALL the requirements, not just keyword hits. It must return strict
 * JSON which we map to the same shape the rule engine returns.
 */

// Build the system prompt — responsible-use rules + strict-JSON contract.
function buildSystemPrompt() {
  return [
    'You are a first-level resume screener for a hiring team.',
    'Score how well the RESUME meets the JOB CRITERIA provided.',
    'Base every judgment SOLELY on job-relevant skills and experience.',
    'NEVER infer or use age, gender, race, religion, national origin,',
    'disability, or any other protected characteristic. If evidence for a',
    'criterion is absent, mark it missing rather than guessing.',
    '',
    'Weigh each criterion by its weight (1-5). A missing REQUIRED criterion',
    'should heavily reduce the score. Consider years of experience vs the',
    "role's minimum. Recognize equivalent evidence (e.g. \"closed $2M in new",
    'logos" satisfies a revenue/quota criterion even without the word "quota").',
    '',
    'Return STRICT JSON ONLY, no markdown, with exactly this shape:',
    '{',
    '  "score": <integer 0-100>,',
    '  "matched": [{"label": <string>, "weight": <number>}],',
    '  "missing": [{"label": <string>, "weight": <number>, "required": <boolean>}],',
    '  "yearsFound": <number>,',
    '  "explanation": <string, 2-4 sentences explaining the ranking>',
    '}',
    'Every criterion listed in the job must appear in either matched or missing.',
  ].join('\n');
}

// Build the user prompt — the FULL profile (all criteria) + the resume text.
function buildUserPrompt(resumeText, profile) {
  const criteria = (profile.criteria || []).map((c, i) => ({
    n: i + 1,
    label: c.label,
    kind: c.kind || 'other',
    weight: c.weight || 1,
    required: !!c.required,
  }));

  const job = {
    role: profile.role || 'Untitled Role',
    summary: profile.summary || '',
    minYears: profile.minYears || 0,
    criteria,
  };

  return [
    'JOB CRITERIA (JSON):',
    JSON.stringify(job, null, 2),
    '',
    'RESUME TEXT:',
    '"""',
    resumeText || '',
    '"""',
    '',
    'Evaluate the resume against ALL criteria above and return the strict JSON.',
  ].join('\n');
}

// Pull a JSON object out of the model text (tolerates stray prose/fences).
function parseModelJson(text) {
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// Normalize the model result into the engine's standard shape.
function normalizeResult(raw, resumeText) {
  const clampScore = Math.max(0, Math.min(100, Math.round(Number(raw.score) || 0)));
  const matched = Array.isArray(raw.matched)
    ? raw.matched.map(m => ({ label: String(m.label || ''), weight: Number(m.weight) || 1 }))
    : [];
  const missing = Array.isArray(raw.missing)
    ? raw.missing.map(m => ({ label: String(m.label || ''), weight: Number(m.weight) || 1, required: !!m.required }))
    : [];
  const yearsFound = Number.isFinite(Number(raw.yearsFound)) && Number(raw.yearsFound) > 0
    ? Number(raw.yearsFound)
    : extractYears(resumeText);

  return {
    score: clampScore,
    matched,
    missing,
    yearsFound,
    explanation: String(raw.explanation || 'AI screening completed.')
      + ' First-level screen only — please review the full resume before deciding.',
    engine: 'ai',
  };
}

export async function screenWithAI(resumeText, profile) {
  const ai = Settings.get().ai || {};
  const body = {
    system: buildSystemPrompt(),
    user: buildUserPrompt(resumeText, profile),
  };
  if (ai.model) body.model = ai.model;

  const resp = await fetch('/api/screen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let msg = `AI proxy returned ${resp.status}`;
    try { const j = await resp.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }

  const data = await resp.json();
  const parsed = parseModelJson(data.text);
  return normalizeResult(parsed, resumeText);
}

/**
 * PUBLIC ENTRY — the app calls this; it chooses the engine.
 */
export async function screenCandidate(resumeText, profile) {
  const ai = Settings.get().ai;
  if (ai && ai.enabled) {
    try { return await screenWithAI(resumeText, profile); }
    catch (e) { console.warn('AI screen failed, falling back to rules:', e.message); }
  }
  return screenRuleBased(resumeText, profile);
}
