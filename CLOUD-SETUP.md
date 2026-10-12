# Cloud Setup — Supabase (auth) + Railway (hosting)

Goal: run the Resume Screener Tool live with logins. Two roles: **admin** and
**user**. The only thing an admin can do that a user can't is **add / manage
users**. Everything else is identical.

User management is 100% in-app (no email, no Supabase dashboard for day-to-day).

---

## Part 1 — Supabase (one-time)

### 1. Create the project + database
1. Create a free project at https://supabase.com
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**.
   (Creates `profiles` with the admin/user role, RLS, the auto-profile trigger,
   and the app data tables.)

### 2. Auth settings (no email)
**Authentication → Providers → Email:**
- Turn **OFF** "Confirm email" (accounts work instantly).
- Turn **OFF** "Enable sign ups" (only admins create accounts — in-app).

### 3. Deploy the admin-users function
Enables in-app user management. **Edge Functions → Create function → name it
`admin-users`** → paste `supabase/functions/admin-users/index.ts` → Deploy.
(Supabase provides `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`
to the function automatically — no secrets in the browser.)

### 4. Grab your keys
**Project Settings → API** → copy the **Project URL** and the **anon public** key.
These go into Railway as env vars (safe to expose; RLS enforces real security).

### 5. Bootstrap the first admin — spencermsharp@gmail.com
Because there are no users yet, create the first admin once from the dashboard:
- **Authentication → Users → Add user** → email `spencermsharp@gmail.com` + a
  password → check **Auto Confirm User**.
- **SQL Editor:**
  ```sql
  update public.profiles set role = 'admin'
  where id = (select id from auth.users where email = 'spencermsharp@gmail.com');
  ```
From then on, add everyone else **inside the app** (Team tab).

---

## Part 2 — Railway (hosting)

1. Push to GitHub (already done: `spencermsharp/Resume-Screener-Tool-`).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Python (Nixpacks) and uses the start command in
   `Procfile` / `railway.json` (gunicorn).
4. **Variables** tab — add:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your anon public key
   - `SECRET_KEY` = any long random string
   - (`ANTHROPIC_MODEL` optional; defaults to `claude-sonnet-4-5`)
   - `PORT` is provided by Railway automatically.
5. Deploy. Open the generated URL → you'll see the **login screen**.
6. Sign in as `spencermsharp@gmail.com`. The **Team** tab appears (admin only) —
   add users from there.

---

## How roles work
- **Local dev** (no Supabase env): no login wall; the operator is treated as a
  local admin so development stays frictionless. The Team tab shows a note.
- **Cloud** (env set): real login required. `admin` sees the **Team** tab and can
  create users, reset passwords, change roles, and remove users. `user` sees an
  **Account** tab to change only their own password.

## Security notes
- The **service_role** key lives ONLY in the Edge Function (server-side).
- The browser only ever gets the **anon** key (+ URL), which is safe to expose.
- Real access control is enforced by Postgres **RLS**, not just the UI.
- Keep `ANTHROPIC_API_KEY` in Railway variables — never in the repo.
