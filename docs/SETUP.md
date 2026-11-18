# Deployment and configuration guide

Everything below is free-tier. No credit card is required for Cloudflare Workers, Supabase, Google AI Studio,
Resend or the LinkedIn self-serve API. **YouTube/laptop-free**: the scheduler runs in Cloudflare Cron.

---

## 0. Accounts and cost

| Service                   | Free tier                               | What we use                    | Notes                                                                             |
| ------------------------- | --------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| Cloudflare Workers        | 100k requests/day, 5 cron triggers      | 1 Worker + 1 cron (`*/5`)      | Cron ticks: 288/day. Dashboard traffic is negligible.                             |
| Supabase                  | 500 MB DB, 2 projects, 50k MAU          | 1 project, ~1 MB/year          | Free projects pause after 7 days of **inactivity**; the cron keeps the DB active. |
| Google Sheets API         | 300 req/min/project                     | ~6 calls/day                   | No billing account needed.                                                        |
| Google AI Studio (Gemini) | Free tier, per-model daily request caps | 1–2 calls/day (+ retries)      | Free-tier quotas change; if you hit them the run fails loudly and retries later.  |
| Resend                    | 100 emails/day, 3 000/month             | 1–3 emails/day                 | Without a verified domain you can only send to your own Resend account email.     |
| LinkedIn Posts API        | Free, self-serve                        | 1 post/day                     | Token lasts 60 days; no refresh token on the self-serve tier.                     |
| Cloudflare static assets  | Free                                    | Dashboard bundle (~90 KB gzip) | Served by the same Worker.                                                        |

---

## 1. Supabase (database + auth)

1. Create a project at <https://supabase.com/dashboard> (region closest to you).
2. Apply the migrations — either:
   - CLI: `supabase link --project-ref <ref> && supabase db push`, or
   - Dashboard → SQL Editor → paste and run, in order: `0001_schema.sql`, `0002_functions.sql`,
     `0003_whatsapp.sql` (optional WhatsApp channel), `0004_post_variants.sql`.
3. Verify from your machine:

   ```bash
   SUPABASE_URL=https://<ref>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
   npm run db:verify
   ```

   Expected: every table and RPC prints `ok`, and the singleton settings/scheduler rows exist.

4. Create the owner user: **Authentication → Users → Add user** with the email you will use as `OWNER_EMAIL`
   and a strong password (email confirmation can stay disabled since only you use it).
5. Copy from **Project settings → API**: `Project URL`, `anon public` key, `service_role` key.

> Security notes: RLS is enabled on every table and `anon`/`authenticated` privileges are revoked. The browser
> never talks to Postgres or PostgREST — all access goes through the Worker with the service-role key.

---

## 2. Google Sheet

1. Create a spreadsheet and add a tab named `Content` (or set `GOOGLE_SHEET_TAB`).
2. Header row (order matters only for humans — columns are matched by name):

   ```
   DATE | TOPIC | CONTENT TYPE | KEY POINTS | TARGET AUDIENCE | STATUS | GENERATED POST | HASHTAGS | APPROVAL | PUBLISH TIME | PUBLISHED URL
   ```

   A ready-made starter is `docs/sample-content-plan.csv` (File → Import).

3. Dates: `YYYY-MM-DD` is safest; `DD/MM/YYYY`, `16 Nov 2026` and Google Sheets date cells also work.
4. Copy the sheet id from the URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.

Rules the automation applies to rows:

- eligible: `STATUS` blank/`Pending`/`Ready`/`Planned`/`Todo`/`Queued`, no `PUBLISHED URL`, `APPROVAL` not
  `Approved`/`Rejected`.
- skipped (never re-processed): `STATUS` = `Generated`/`Approved`/`Published`/`Rejected`/`Skipped`/`Expired`/
  `Failed`, or `APPROVAL` = `Approved`/`Rejected`.
- rows with unparsable dates or a missing topic are reported in the sync result and in the logs.

---

## 3. Google OAuth (Sheets access)

1. <https://console.cloud.google.com> → create/choose a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **OAuth consent screen**:
   - User type: **External** (or Internal if you have Workspace).
   - Add your own Google account under **Test users** while the app is in "Testing".
   - Scopes: add `https://www.googleapis.com/auth/spreadsheets`.
4. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized redirect URI: `https://<APP_BASE_URL host>/api/v1/integrations/google-sheets/callback`
     (for local dev also add `http://localhost:8787/api/v1/integrations/google-sheets/callback`).
5. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB`.

Notes:

- The connect flow requests `access_type=offline&prompt=consent`, so a refresh token is always returned and
  stored encrypted (AES-256-GCM) in the `integrations` table.
- If you prefer not to use the flow, generate a refresh token yourself and set `GOOGLE_REFRESH_TOKEN`.
  Rotating `TOKEN_ENCRYPTION_KEY` invalidates stored tokens → just reconnect.
- While the consent screen stays in "Testing", refresh tokens expire after 7 days. Publish the app or use
  "Internal" to avoid weekly reconnects.

---

## 4. Gemini

1. <https://aistudio.google.com/app/apikey> → create an API key.
2. Set `GEMINI_API_KEY`. Optionally set `GEMINI_MODEL` (default `gemini-2.5-flash`).
3. Verify from the dashboard: **Settings → Integrations → AI provider → Test generation**.

The AI layer is a port (`src/core/ports.ts` → `AiProvider`). To use another provider, implement
`generatePost()` and register it in `src/server/services.ts`; nothing else changes.

---

## 5. Resend (approval email)

1. Create an account at <https://resend.com> and an API key.
2. Sender:
   - Quick start (no domain): `RESEND_FROM_EMAIL="LinkedIn Automation <onboarding@resend.dev>"` — Resend only
     allows this to send **to the email address that owns the Resend account**.
   - Production: verify your domain (DNS records) and use e.g. `posts@yourdomain.com`.
3. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`.
4. Dashboard → **Settings → Integrations → Email → Send test email**.

---

## 6. LinkedIn developer app (personal profile publishing)

Verified facts (2026) about the self-serve route:

- Posting to **your own personal profile** requires the **Share on LinkedIn** product and scope
  `w_member_social`. It is self-serve, free, and needs **no partner review**.
- Reading your own posts back (`r_member_social`) is a **closed** permission — this system therefore stores the
  post id/URL returned at publish time instead of reading the feed.
- Self-serve access tokens last **60 days** and **no refresh token is issued** to self-serve apps. Reconnect
  before expiry; the app emails you 7 days ahead and refuses to publish with an expired token (manual fallback).
- Rate limit on Share on LinkedIn: ~150 requests per member per day. One post/day is far below it.

Setup:

1. <https://developer.linkedin.com/developers/apps> → **Create app** (an associated LinkedIn Page is required by
   the portal; the profile posting itself does not need Page admin rights).
2. **Products** → request/add:
   - **Share on LinkedIn** (self-serve, grants `w_member_social`)
   - **Sign In with LinkedIn using OpenID Connect** (self-serve, grants `openid profile`)
3. **Auth** tab → Authorized redirect URLs for your app:
   - `https://<APP_BASE_URL host>/api/v1/integrations/linkedin/callback`
4. Copy **Client ID** and **Client Secret** → `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.
5. Optional: `LINKEDIN_API_VERSION` (default `202506`) — must be a version LinkedIn still supports. If LinkedIn
   returns a version error, set it to the current one from the Posts API docs and redeploy.

**If the products cannot be enabled** (for example the portal refuses a personal app), the system is still fully
usable: approved posts go through the manual fallback — the email and dashboard show the exact text plus a
LinkedIn composer link, and you record the published URL so history stays accurate. No fake success.

---

## 7. Cloudflare deployment

```bash
npm install
npm run build                                  # static dashboard -> ./out
npx wrangler login

# secrets (repeat for each; values never go into git)
npx wrangler secret put APP_BASE_URL           # https://<worker>.<subdomain>.workers.dev
npx wrangler secret put OWNER_EMAIL
npx wrangler secret put APPROVAL_TOKEN_SECRET  # openssl rand -hex 32
npx wrangler secret put TOKEN_ENCRYPTION_KEY   # openssl rand -base64 32
npx wrangler secret put CRON_SECRET            # openssl rand -hex 24
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_SHEET_ID
npx wrangler secret put GOOGLE_SHEET_TAB       # plain var is fine too
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
npx wrangler secret put LINKEDIN_CLIENT_ID
npx wrangler secret put LINKEDIN_CLIENT_SECRET

npm run deploy
```

`wrangler.toml` already contains:

```toml
[assets]
directory = "./out"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = ["/api/*"]

[triggers]
crons = ["*/5 * * * *"]
```

`run_worker_first` as an array requires **Wrangler v4** (pinned in `package.json`). `APP_ENV=production` is set in
`[vars]`, which makes the config loader enforce every production secret and reject `ALLOW_DEV_BYPASS`.

Optional custom domain: **Workers → your worker → Settings → Domains & Routes → Add custom domain**, then set
`APP_BASE_URL` to that domain (it must match the OAuth redirect URIs exactly) and redeploy.

### Scheduler semantics

The cron fires every 5 minutes; the Worker decides what to do:

1. recover interrupted publishing jobs
2. expire stale approval links
3. if today is a publishing day and local time ≥ generation time and today has not succeeded yet →
   claim the day atomically and run the pipeline (max 3 attempts/day)
4. publish any queued job whose `run_at` is due (max 5 per tick)
5. warn by email when the LinkedIn token is within 7 days of expiry

---

## 8. Production verification checklist

```bash
BASE=https://<your-worker-host>

curl -s $BASE/api/v1/health | jq
# -> {"ok":true,"data":{"status":"ok","servicesMode":"live","database":{"ok":true}}}
```

| Step            | Action                                                                                        | Expected                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Auth            | open `$BASE`                                                                                  | sign-in page; unauthorised API calls return 401                                                |
| Sheets          | Settings → Integrations → Connect Google Sheets → save sheet id → _Test read_                 | "Read N eligible topic row(s)"                                                                 |
| AI              | Integrations → AI provider → _Test generation_                                                | a sample hook from Gemini                                                                      |
| Email           | Integrations → Email → _Send test email_                                                      | email arrives                                                                                  |
| LinkedIn        | Integrations → Connect LinkedIn → _Check status_                                              | connected, token expiry shown                                                                  |
| Pipeline        | add a sheet row for tomorrow, then `POST /api/v1/schedule/run` from the dashboard ("Run now") | post generated, sheet updated to `Generated`, approval email received                          |
| Approval        | open the email link, tap Approve                                                              | published at publish time (or immediately if passed); DB + sheet show published URL            |
| Duplicate guard | tap Approve again from the same link                                                          | "This post was already approved"                                                               |
| Cron            | Cloudflare dashboard → Workers → Logs                                                         | `[cron] */5 * * * * generation=… published=…`                                                  |
| Failure path    | temporarily set a wrong `RESEND_API_KEY`                                                      | run still saves the draft; dashboard shows "approval email was not delivered"; error log entry |

Manual cron trigger (needs the secret, cannot be called by a browser):

```bash
curl -X POST $BASE/api/v1/schedule/cron -H "x-cron-secret: $CRON_SECRET"
```

---

## 9. Troubleshooting

| Symptom                                                        | Cause / fix                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Missing or invalid environment variables: …`                  | A secret is absent. `npx wrangler secret list` and compare with the list above.                                  |
| `ALLOW_DEV_BYPASS must not be enabled when APP_ENV=production` | Remove the variable; it is dev-only by design.                                                                   |
| `Google authorization expired. Reconnect…`                     | Refresh token revoked/expired (Testing consent screen = 7 days). Reconnect.                                      |
| `Could not find required DATE and TOPIC headers`               | The header row was not detected; ensure a row with `DATE` and `TOPIC` in the first five rows.                    |
| `No topic found for <date>`                                    | No eligible row for that date, or the row's `STATUS`/`APPROVAL` marks it as handled.                             |
| Approval email never arrives                                   | Check `RESEND_FROM_EMAIL` (unverified domain can only email the Resend account owner), then Resend → Logs.       |
| `LinkedIn access token expired` / `needs_reauth`               | 60-day self-serve token lapsed. Reconnect LinkedIn.                                                              |
| `LinkedIn returned 403`                                        | `w_member_social` missing → add the _Share on LinkedIn_ product.                                                 |
| `LinkedIn rejected the post content (422)`                     | Content violates LinkedIn rules (length/characters). Edit the post and retry.                                    |
| Cron never runs                                                | `wrangler.toml` `[triggers]` deployed? Check Workers → Triggers; redeploy if changed.                            |
| Dashboard shows "Cannot reach the automation API"              | `APP_BASE_URL`/Worker route wrong, or the Worker failed to boot (check `wrangler tail`).                         |
| Supabase project paused                                        | Free projects pause after 7 days without activity; the cron normally prevents this — restore from the dashboard. |

---

## 10. Operations

- **Rotate `APPROVAL_TOKEN_SECRET`** → outstanding email links stop working (by design). Pending posts can be
  re-sent from the Approvals tab.
- **Rotate `TOKEN_ENCRYPTION_KEY`** → stored Google/LinkedIn tokens become unreadable; reconnect both.
- **Logs** live in `execution_logs` (redacted; no tokens). Prune with
  `delete from execution_logs where created_at < now() - interval '90 days';`.
- **Backups**: Supabase free tier includes daily backups for 7 days. The Google Sheet is your content backup.
- **Updating**: `git pull && npm ci && npm test && npm run deploy`.

## 9. Optional: WhatsApp approvals

Free, official Meta Cloud API — follow [WHATSAPP.md](./WHATSAPP.md). Set `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_OWNER_NUMBER` as Worker
secrets, subscribe the webhook to the `messages` field, then use **Settings → Integrations → WhatsApp →
Send test message**. Without these keys nothing changes: approvals keep working by email and in the dashboard.
