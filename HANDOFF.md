# HANDOFF — IDE Work Plan

This baseline runs on localhost with a rule-based engine. Below are the two
integrations to build in the IDE, in priority order, with exact seams.

---

## 1. Real PDF parsing  (`src/data/parser.js` → `extractText`)

The baseline reads `.txt` and honestly reports that PDFs need a real parser.
Pick ONE approach:

**A) Client-side with pdf.js (recommended first step — private, no server)**
- Add Mozilla `pdf.js`.
- In `extractText`, when the file is a PDF: read it as an ArrayBuffer, load with
  pdf.js, iterate pages, concatenate `getTextContent()` items into `rawText`.
- Return `{ ok: true, rawText, needsRealParser: false }`.

**B) Server-side with Python (reuse the estimating tool's stack)**
- The estimating tool already uses Python PDF parsing (pdfplumber / PyMuPDF).
- Add a small endpoint to `serve.py` (or a sibling Flask/FastAPI app) that
  accepts an uploaded PDF and returns extracted text as JSON.
- Call it from `extractText` via `fetch`.

**C) AI vision (most robust for scanned/messy resumes)**
- Send page images to a multimodal model and ask for clean text.
- Heavier and sends data off-machine; good as a fallback for files A/B can't read.

Then optionally enrich `lightStructure()` for better name/email/phone/skill
extraction.

---

## 2. AI screening  (`src/data/screener.js` → `screenWithAI`)

The seam already exists and the app already prefers AI when enabled, falling back
to rules on any error. To turn it on:

1. **Pick a provider** (Anthropic Claude or OpenAI recommended). Decide client-
   vs server-side calls. For an API key, DO NOT ship it in client JS — route
   through a tiny server endpoint (extend `serve.py` or a small Node/Python API).

2. **Implement `screenWithAI(resumeText, profile)`** to call the model and return
   the SAME shape the rule engine returns:
   ```js
   { score /*0-100*/, matched:[{label,weight}], missing:[{label,weight,required}],
     yearsFound, explanation /*string*/, engine:'ai' }
   ```

3. **Prompt contract (suggested):**
   - System: "You are a first-level resume screener. Score how well the resume
     meets the JOB criteria below. Return STRICT JSON only. Base judgments solely
     on job-relevant skills and experience. **Never** infer or use age, gender,
     race, religion, national origin, disability, or other protected
     characteristics. If evidence is absent, say so rather than guessing."
   - User: the profile (role, summary, criteria with weights/required, minYears)
     + the resume text. Ask for per-criterion matched/missing + a concise
     explanation of the ranking.

4. **Flip it on** via Settings:
   ```js
   Settings.update({ ai: { enabled: true, provider: 'anthropic', model: '…', note: '' } });
   ```
   (Add a small Settings UI, or set it from the console during testing.)

5. **Keep the fallback.** `screenCandidate()` already catches AI errors and falls
   back to the rule engine — preserve that so a bad API call never blocks screening.

---

## 3. Database (when ready to go live)

See README "localhost now, database later." Swap the `backend` object in
`src/data/db.js` to a real DB/API (reuse the tracker's Supabase), make repo
methods async, and `await` them in the views.

---

## Guardrails to carry forward

- Human-in-the-loop: the tool ranks and explains; it does not auto-reject.
- Job-relevant criteria only; never protected characteristics.
- When AI is on, log what was sent for auditability, and consider keeping resume
  data on your own infrastructure where possible.
