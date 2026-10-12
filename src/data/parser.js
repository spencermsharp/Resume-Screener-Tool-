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
  // Guess the name from the first non-empty line that isn't a contact detail.
  let name = '';
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    if (/@|\d{3}/.test(line)) continue;
    if (line.length <= 60) { name = line; break; }
  }
  return { name, email, phone };
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
