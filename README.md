# Vimenture Resume Screener

A first-level resume screening assistant for Vimenture. You
define a role as a **screening profile**, upload a stack of resumes, and the tool
ranks the best candidates against that profile — each with a written explanation
of **why** they fit. A human always makes the final hiring decision.

This is the **baseline / localhost** phase. It runs entirely in your browser with
no backend and no AI calls yet. The screening engine uses a transparent
rule-based baseline, with a clearly marked seam where AI drops in during the IDE
handoff (see `HANDOFF.md`).

---

## Running Locally

```bash
cd ~/Desktop/vimenture-resume-screener
pip install -r requirements.txt      # first time only (Flask + python-dotenv)
cp .env.example .env                 # first time only, then add your key
python3 serve.py
```

Opens automatically at **http://localhost:3200**
(Tracker is on 3000, Estimating tool on 3100, so all three can run together.)

Press `Ctrl+C` to stop.

### Enabling AI screening

AI screening calls Anthropic Claude through a small **server-side proxy**, so
your API key never ships to the browser and never lives in source code.

1. Put your key in `.env` (git-ignored):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
2. Restart the server. The startup line will read `AI: ON`.
3. In the app's Dashboard, click **Turn AI on**. Screening now uses Claude and
   falls back to the rule engine automatically on any error.

**Going live:** set `ANTHROPIC_API_KEY` (and `SECRET_KEY`) as environment
variables in your host's dashboard — no `.env`, no code change. Login hooks into
the `login_required` seam in `server/routes.py`.

## Server architecture

```
serve.py                     # entry point: build app, start dev server
server/
  config.py                  # single source of truth — reads env (.env in dev)
  anthropic_client.py        # the ONLY module that calls Anthropic
  routes.py                  # thin HTTP handlers + login_required auth seam
  app.py                     # Flask application factory
```

---

## Future-proof by design: roles are DATA, not code

Your requirement was: *sales now, accountants and telecom analysts later, with no
rebuild.* That's exactly how this is built.

A **screening profile** is a piece of data describing a role — its weighted
criteria, required skills, and minimum experience. The screening engine is
**role-agnostic**: it reads whatever a profile defines. To add "Accountant" or
"Telecom Analyst," you just create a new profile in the UI (there are starter
keyword templates built in). No code changes, ever.

---

## What it does today

- **Dashboard** — KPIs, quick actions, recently screened candidates, and the AI on/off status.
- **Screening Profiles** — create/edit roles. Each criterion has a label, keywords, a weight (1–5), and a required flag. One Sales profile is seeded to start.
- **Upload & Screen** — drag/drop resumes (or paste text), pick the role, and screen them. Each becomes a ranked candidate.
- **Results** — candidates ranked best-first, with matched/missing criteria chips and a plain-language explanation of the ranking.
- **Candidate detail** — score, detected contact info, status (screened / shortlisted / rejected), the full "why," and the raw resume text.

All data persists in your browser's **localStorage**.

---

## How scoring works (baseline)

The rule-based engine (`src/data/screener.js`):
1. Matches each criterion's keywords against the resume text.
2. Scores by **weighted** criteria met (earned ÷ possible).
3. Applies a **hard penalty** when a *required* criterion is missing.
4. Nudges for years of experience vs. the profile's minimum.
5. Builds a human-readable explanation from that structured result.

It's deliberately transparent so the ranking is explainable and defensible. The
AI engine (once wired) produces richer scoring and prose but returns the **same
shape**, so nothing else in the app changes.

---

## Architecture

```
vimenture-resume-screener/
├── serve.py              # Python dev server (port 3200)
├── package.json
├── index.html
├── public/               # logo
├── uploads/              # (reserved) stored resumes in the live phase
└── src/
    ├── main.js           # app shell: topbar, nav, routing
    ├── styles.css        # Vimenture branding + light/dark tokens
    ├── utils.js          # DOM + formatting helpers
    ├── data/
    │   ├── db.js         # data layer — the DB-ready seam (Profiles/Candidates/Settings)
    │   ├── screener.js   # scoring engine — rule-based now, AI seam marked
    │   └── parser.js     # PDF→text — baseline stub, real parser wired in IDE
    └── views/
        ├── dashboard.js
        ├── profiles.js
        ├── upload.js
        └── results.js    # ranked results + candidate detail
```

---

## The "localhost now, database later" plan

Going live is a **one-file change**. In `src/data/db.js` there's a `backend`
object with `read`/`write` (and async stubs). Today it uses `localStorage`. To go
live: implement those methods against a real DB/API (the tracker already uses
**Supabase** — reuse it), make the repository methods `async`, and `await` the
repo calls in the views. Every view talks only to `Profiles` / `Candidates` /
`Settings`, so the blast radius stays inside `db.js`.

---

## Responsible use

This is a **first-level screening assistant**, not a decision-maker. It surfaces
and explains candidates to save you time on a large stack; a human reviews and
decides. Keep criteria focused on **job requirements** — never protected
characteristics (age, gender, race, religion, national origin, disability, etc.).
The AI prompt in the handoff is written to reinforce this.

---

*Baseline scaffold. Localhost only — no data leaves this machine, and no AI calls
are made yet.*
