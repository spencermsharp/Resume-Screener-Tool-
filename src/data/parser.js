/**
 * RESUME PARSER — Vimenture Resume Screener
 * ------------------------------------------------------------------
 * Turns an uploaded PDF into plain text (and, later, structured fields)
 * that the screening engine can read.
 *
 * BASELINE (today):
 *   - Accepts a File. If it's a .txt we read it directly (handy for
 *     testing without PDFs).
 *   - For PDFs, we DON'T silently fail: we return a clear flag so the UI
 *     can tell the user that real PDF parsing is wired up in the IDE.
 *     The user can paste resume text manually in the meantime.
 *
 * ⚠️ IDE HANDOFF — pick ONE of these for real PDF extraction:
 *   A) Client-side: bundle pdf.js (Mozilla) and extract text in-browser.
 *      Good for privacy (nothing leaves the machine).
 *   B) Server-side: a small Python endpoint using pdfplumber / PyMuPDF
 *      (the estimating tool already uses Python parsers — reuse that).
 *   C) AI vision: send the PDF/page images to a multimodal model for
 *      messy/scanned resumes. Most robust, but sends data to the API.
 *
 * Then OPTIONALLY add light structuring (name, email, phone, skills).
 * The screening engine only needs `rawText`, so structuring is a bonus.
 */

// Best-effort contact/name extraction from raw text (baseline heuristics).
export function lightStructure(rawText) {
  const text = rawText || '';
  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '';
  const phone = (text.match(/(\+?\d[\d\s().-]{7,}\d)/) || [])[0] || '';
  const name = guessName(text, email);
  return { name, email, phone };
}

// Lines that are resume headings/labels, not a person's name.
const NAME_STOPWORDS = /\b(resume|résumé|cv|curriculum\s+vitae|profile|summary|objective|contact|address|phone|email|e-mail|linkedin|github|portfolio|references|experience|education|skills|confidential)\b/i;

// Try to pull the candidate's actual name out of the resume text. Resumes
// almost always lead with the name, so we scan the first several lines and
// pick the first that genuinely looks like a person's name — skipping emails,
// phone numbers, URLs, addresses, and section headings.
function guessName(text, email = '') {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 12);

  for (const line of lines) {
    if (looksLikeName(line)) return cleanName(line);
  }

  // Fallback: derive a name from the email local-part (e.g. "jane.doe@…" → "Jane Doe").
  if (email) {
    const local = email.split('@')[0].replace(/\d+/g, '');
    const parts = local.split(/[._-]+/).filter(p => p.length > 1);
    if (parts.length >= 2) return cleanName(parts.join(' '));
  }

  return '';
}

// Heuristic: is this line plausibly a person's name?
function looksLikeName(line) {
  if (!line || line.length > 60) return false;
  if (/[@/\\]|www\.|https?:/i.test(line)) return false;   // email / URL
  if (/\d/.test(line)) return false;                        // phone / address / dates
  if (NAME_STOPWORDS.test(line)) return false;              // section heading
  if (/[,:;|•·]/.test(line)) return false;                  // label/credential list

  // 2–4 words, each starting with a letter. Accepts "Jane Doe", "JANE DOE",
  // "Jane A. Doe", "Mary-Jane O'Neil". Rejects single words and long sentences.
  const words = line.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  return words.every(w => /^[A-Za-z][A-Za-z'.-]*$/.test(w));
}

// Normalize casing: "JANE DOE" / "jane doe" → "Jane Doe"; leave mixed case alone.
function cleanName(raw) {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    return s.toLowerCase().replace(/\b([a-z])([a-z'.-]*)/g, (_, a, b) => a.toUpperCase() + b);
  }
  return s;
}

// Turn a resume filename into a readable name as a LAST resort, so the UI never
// shows raw filenames like "jane_doe_resume_v2.pdf". Strips the extension,
// drops "resume"/"cv"/version tags, converts separators to spaces, Title-cases.
export function nameFromFileName(fileName) {
  if (!fileName) return '';
  let base = String(fileName).split('/').pop().replace(/\.[^.]+$/, ''); // drop path + extension
  base = base
    .replace(/[_+]+/g, ' ')
    .replace(/(?<=[a-z])(?=[A-Z])/g, ' ')               // camelCase → spaced
    .replace(/\b(resume|résumé|cv|curriculum\s*vitae|final|updated|copy|v?\d+(\.\d+)?)\b/gi, ' ')
    .replace(/[-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  return base.toLowerCase().replace(/\b([a-z])([a-z'’-]*)/g, (_, a, b) => a.toUpperCase() + b);
}

// pdf.js is loaded on demand (only when a PDF is dropped) so .txt stays fast
// and the ~1MB library isn't fetched unless it's actually needed.
const PDFJS_VERSION = '4.7.76';
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let _pdfjsPromise = null;
function loadPdfJs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import(/* @vite-ignore */ PDFJS_URL).then(mod => {
      const pdfjs = mod.getDocument ? mod : (mod.default || mod);
      try { pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch { /* older builds */ }
      return pdfjs;
    });
  }
  return _pdfjsPromise;
}

// Extract text from a PDF File using pdf.js (client-side, nothing leaves the machine).
async function extractPdfText(file) {
  const pdfjs = await loadPdfJs();
  const data = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Join text items; pdf.js exposes each span's string in `.str`.
    pages.push(content.items.map(it => (it.str || '')).join(' '));
  }
  try { await doc.destroy(); } catch { /* ignore */ }
  return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Read a File into text. Supports .txt (direct) and .pdf (via pdf.js).
 * @returns {Promise<{ok:boolean, rawText:string, needsRealParser:boolean, reason?:string}>}
 */
export async function extractText(file) {
  const name = (file && file.name) || '';
  const isTxt = /\.txt$/i.test(name) || (file && file.type === 'text/plain');
  const isPdf = /\.pdf$/i.test(name) || (file && file.type === 'application/pdf');

  if (isTxt) {
    const rawText = await file.text();
    return { ok: true, rawText, needsRealParser: false };
  }

  if (isPdf) {
    try {
      const rawText = await extractPdfText(file);
      if (!rawText) {
        return {
          ok: false,
          rawText: '',
          needsRealParser: false,
          reason: 'This PDF has no extractable text (likely a scan/image). An AI-vision fallback would be needed to read it.',
        };
      }
      return { ok: true, rawText, needsRealParser: false };
    } catch (err) {
      return {
        ok: false,
        rawText: '',
        needsRealParser: false,
        reason: `Could not read PDF: ${err && err.message ? err.message : err}`,
      };
    }
  }

  return {
    ok: false,
    rawText: '',
    needsRealParser: false,
    reason: `Unsupported file type: ${name || 'unknown'}. Use .pdf or .txt (or paste the text).`,
  };
}
