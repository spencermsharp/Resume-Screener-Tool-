// ── UTILITIES ────────────────────────────────────────────────────────────────
export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function html(str) {
  const d = document.createElement('div');
  d.innerHTML = String(str).trim();
  return d.firstElementChild;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Numbers / dates
export function pct(n) { return `${Math.round((parseFloat(n) || 0))}%`; }
export function today() { return new Date().toISOString().slice(0, 10); }
export function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

export function uid(prefix = 'ID') {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase();
}

// Whole days between an ISO date (e.g. "2026-10-09") and `to` (default: now).
export function daysBetween(iso, to = new Date()) {
  if (!iso) return 0;
  const start = new Date(iso);
  if (isNaN(start)) return 0;
  const ms = (to instanceof Date ? to : new Date(to)) - start;
  return Math.max(0, Math.floor(ms / 86400000));
}

// "today", "1 day", "N days" — friendly duration from a day count.
export function daysOpenLabel(iso, to = new Date()) {
  const d = daysBetween(iso, to);
  if (d <= 0) return 'today';
  return d === 1 ? '1 day' : `${d} days`;
}

// Score helpers — 0..100
export function scoreClass(score) {
  if (score >= 75) return 'score-high';
  if (score >= 50) return 'score-mid';
  return 'score-low';
}
export function scoreLabel(score) {
  if (score >= 75) return 'Strong match';
  if (score >= 50) return 'Possible match';
  return 'Weak match';
}
