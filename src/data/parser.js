/**
 * RESUME PARSER — Vimenture Resume Screener
 * ------------------------------------------------------------------
 * Turns an uploaded resume (.pdf, .docx, .doc, .txt) into plain text (and,
 * later, structured fields) that the screening engine can read.
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
  return normalizeExtractedText(pages.join('\n\n'));
}

// Shared cleanup for every extracted (non-.txt) format: drop trailing spaces
// before newlines and trim the ends.
export function normalizeExtractedText(text) {
  return String(text || '').replace(/[ \t]+\n/g, '\n').trim();
}

// Word libraries are UMD/classic-script builds (no ES module export), so they
// are loaded on demand with a <script> tag that resolves once the global is set.
// Like pdf.js, nothing is fetched unless that file type is actually dropped.
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';
const CFB_URL = 'https://cdn.jsdelivr.net/npm/cfb@1.2.2/dist/cfb.min.js';

const _scriptPromises = {};
function loadScriptGlobal(url, globalName) {
  if (!_scriptPromises[url]) {
    _scriptPromises[url] = new Promise((resolve, reject) => {
      if (window[globalName]) { resolve(window[globalName]); return; }
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => window[globalName]
        ? resolve(window[globalName])
        : reject(new Error(`${globalName} did not load`));
      s.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(s);
    });
    _scriptPromises[url].catch(() => { delete _scriptPromises[url]; }); // allow retry
  }
  return _scriptPromises[url];
}

// .docx → plain text with mammoth. `mammoth` is injected so this can run
// with the CDN build in the browser or the same browser build in Node.
// mammoth.extractRawText() silently drops soft line breaks (Shift+Enter), which
// glues "Name<br>email<br>phone" contact blocks into one word. So we let mammoth
// parse the document, grab its document tree via the documented
// `transformDocument` hook, and walk it ourselves.
export async function docxToText(mammoth, arrayBuffer) {
  let tree = null;
  await mammoth.convertToHtml({ arrayBuffer }, {
    transformDocument: doc => (tree = doc),
    convertImage: mammoth.images.imgElement(() => ({ src: '' })), // skip base64-encoding images
  });
  return normalizeExtractedText(docxNodeText(tree));
}

// One line per paragraph; table cells end with a tab and rows with a newline
// (the same layout docToText produces for .doc).
function docxNodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  if (node.type === 'tab') return '\t';
  if (node.type === 'break') return '\n';
  const inner = (node.children || []).map(docxNodeText).join('');
  if (node.type === 'paragraph') return inner + '\n';
  if (node.type === 'tableCell') return inner.replace(/\n$/, '') + '\t';
  if (node.type === 'tableRow') return inner + '\n';
  return inner;
}

const DOC_UNREADABLE = 'Could not read this .doc file (it may be password-protected or corrupted). Save it as .docx or PDF and try again.';

// .doc (Word 97-2003, OLE compound file) → plain text via the piece table.
// `CFB` (SheetJS cfb) is injected for the same reason as `mammoth` above.
export function docToText(CFB, bytes) {
  const toU8 = c => (c instanceof Uint8Array ? c : Uint8Array.from(c || []));
  const container = CFB.read(toU8(bytes), { type: 'array' });
  const wordEntry = CFB.find(container, 'WordDocument');
  if (!wordEntry || !wordEntry.content) throw new Error('No WordDocument stream');
  const word = toU8(wordEntry.content);
  const wv = new DataView(word.buffer, word.byteOffset, word.byteLength);

  // FibBase
  if (wv.getUint16(0, true) !== 0xA5EC) throw new Error('Not a Word 97-2003 document');
  const flags = wv.getUint16(0x0A, true);
  if (flags & 0x0100) throw new Error('Encrypted document');   // fEncrypted
  const tableName = (flags & 0x0200) ? '1Table' : '0Table';     // fWhichTblStm

  // Walk the variable-length FIB: FibRgW97, FibRgLw97, then FibRgFcLcb.
  let off = 32;
  const csw = wv.getUint16(off, true); off += 2 + csw * 2;
  const cslw = wv.getUint16(off, true); off += 2;
  const rgLw = off; off += cslw * 4;
  off += 2; // cbRgFcLcb
  const fcClx = wv.getUint32(off + 33 * 8, true);
  const lcbClx = wv.getUint32(off + 33 * 8 + 4, true);
  if (!lcbClx) throw new Error('No piece table');

  // Story lengths (in CPs). Read the main body plus text boxes (resume layouts
  // often put content in them). Headers, footnotes and comments are skipped,
  // matching what the .docx path reads.
  const lw = i => (i < cslw ? wv.getInt32(rgLw + i * 4, true) : 0);
  const ccpText = lw(3), ccpTxbx = lw(9);
  const txbxStart = ccpText + lw(4) + lw(5) + lw(6) + lw(7) + lw(8); // + ftn, hdd, mcr, atn, edn
  const ranges = [[0, ccpText], [txbxStart, txbxStart + ccpTxbx]].filter(([a, b]) => b > a);

  const tableEntry = CFB.find(container, tableName);
  if (!tableEntry || !tableEntry.content) throw new Error(`No ${tableName} stream`);
  const table = toU8(tableEntry.content);
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);

  // Clx: skip any Prc blocks (0x01), then the Pcdt (0x02) holds the PlcPcd.
  let p = fcClx;
  const clxEnd = fcClx + lcbClx;
  while (p < clxEnd && table[p] === 0x01) p += 3 + tv.getInt16(p + 1, true);
  if (table[p] !== 0x02) throw new Error('Bad Clx');
  const lcbPlc = tv.getUint32(p + 1, true);
  const plc = p + 5;
  const n = (lcbPlc - 4) / 12;
  if (!Number.isInteger(n) || n < 1) throw new Error('Bad PlcPcd');

  const cp1252 = new TextDecoder('windows-1252');
  const utf16 = new TextDecoder('utf-16le');
  const pieces = [];
  for (let i = 0; i < n; i++) {
    const cpStart = tv.getUint32(plc + i * 4, true);
    const cpEnd = tv.getUint32(plc + (i + 1) * 4, true);
    const fcRaw = tv.getUint32(plc + (n + 1) * 4 + i * 8 + 2, true);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3FFFFFFF;
    pieces.push({ cpStart, cpEnd, compressed, fc });
  }

  // Read the characters for [a, b) by stitching together the pieces it spans.
  const readCps = (a, b) => {
    let out = '';
    for (const pc of pieces) {
      const s = Math.max(a, pc.cpStart), e = Math.min(b, pc.cpEnd);
      if (e <= s) continue;
      if (pc.compressed) {
        const start = pc.fc / 2 + (s - pc.cpStart);
        out += cp1252.decode(word.subarray(start, start + (e - s)));
      } else {
        const start = pc.fc + (s - pc.cpStart) * 2;
        out += utf16.decode(word.subarray(start, start + (e - s) * 2));
      }
    }
    return out;
  };

  return normalizeExtractedText(ranges.map(([a, b]) => wordControlsToText(readCps(a, b))).join('\n'));
}

// Map Word's in-text control characters to plain text.
function wordControlsToText(s) {
  let out = '';
  const fields = [];        // stack: true once a field has passed its separator
  let prev = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x13) { fields.push(false); prev = ch; continue; }                  // field begin
    if (c === 0x14) { if (fields.length) fields[fields.length - 1] = true; prev = ch; continue; } // separator
    if (c === 0x15) { fields.pop(); prev = ch; continue; }                        // field end
    if (fields.some(inResult => !inResult)) { prev = ch; continue; }              // field code text
    if (c === 0x0D || c === 0x0B || c === 0x0C) out += '\n';
    else if (c === 0x07) out += prev === '\x07' ? '\n' : '\t';                    // cell mark / row end
    else if (c === 0x1E) out += '-';                                              // non-breaking hyphen
    else if (c === 0x09 || c >= 0x20) out += ch;
    // other control chars (pictures, footnote refs, optional hyphens…) are dropped
    prev = ch;
  }
  return out;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';

/**
 * Which resume format is this File? Extension wins; MIME type is the fallback.
 * @returns {'txt'|'pdf'|'docx'|'doc'|''}
 */
export function resumeFileKind(file) {
  const name = (file && file.name) || '';
  const type = (file && file.type) || '';
  const ext = (name.match(/\.(txt|pdf|docx|doc)$/i) || [])[1];
  if (ext) return ext.toLowerCase();
  if (type === 'text/plain') return 'txt';
  if (type === 'application/pdf') return 'pdf';
  if (type === DOCX_MIME) return 'docx';
  if (type === DOC_MIME) return 'doc';
  return '';
}

/**
 * Read a File into text. Supports .txt (direct), .pdf (via pdf.js),
 * .docx (via mammoth) and .doc (via SheetJS cfb + the Word piece table).
 * @returns {Promise<{ok:boolean, rawText:string, needsRealParser:boolean, reason?:string}>}
 */
export async function extractText(file) {
  const name = (file && file.name) || '';
  const kind = resumeFileKind(file);
  const isTxt = kind === 'txt';
  const isPdf = kind === 'pdf';

  if (kind === 'docx' || kind === 'doc') {
    let lib, rawText;
    try {
      lib = await (kind === 'docx' ? loadScriptGlobal(MAMMOTH_URL, 'mammoth') : loadScriptGlobal(CFB_URL, 'CFB'));
    } catch (err) {
      return {
        ok: false,
        rawText: '',
        needsRealParser: false,
        reason: `Could not load the Word reader: ${err && err.message ? err.message : err}`,
      };
    }
    try {
      rawText = kind === 'docx'
        ? await docxToText(lib, await file.arrayBuffer())
        : docToText(lib, new Uint8Array(await file.arrayBuffer()));
    } catch (err) {
      return {
        ok: false,
        rawText: '',
        needsRealParser: false,
        reason: kind === 'doc' ? DOC_UNREADABLE : `Could not read .docx: ${err && err.message ? err.message : err}`,
      };
    }
    if (!rawText) {
      return {
        ok: false,
        rawText: '',
        needsRealParser: false,
        reason: `This .${kind} file has no extractable text (it may contain only images). An AI-vision fallback would be needed to read it.`,
      };
    }
    return { ok: true, rawText, needsRealParser: false };
  }

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
    reason: `Unsupported file type: ${name || 'unknown'}. Use .pdf, .docx, .doc or .txt (or paste the text).`,
  };
}
