# Personal LinkedIn AI Automation

A personal (not SaaS) LinkedIn content automation system: plan topics in Google Sheets, let Gemini write
one professional post per publishing day, approve it from your phone by email, and publish it through the
official LinkedIn Posts API — running entirely in the cloud on free-tier services.

```
Google Sheet ──► Cloudflare Cron (5 min tick) ──► Gemini (agentic AI / automation topics)
                        │                                │
                        ▼                                ▼
                 Supabase Postgres  ◄──────────  draft saved + sheet updated
                        │                                │
                        │                                ▼
                        │                     Resend email with approve/reject link
                        │                                │
                        │                       you tap Approve (POST + single-use token)
                        ▼                                │
                publishing job (respects publish time) ──► LinkedIn Posts API (w_member_social)
                                                         │
                                       post id + URL saved to DB and Google Sheets
```

## What is in this repository

The repository started with a single 26-byte `README.md` and one initial commit — there was no existing
code, architecture or dependency set to reuse. Everything below was built from scratch against this spec.

### Stack

| Layer         | Choice                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- |
| Dashboard     | Next.js 15 (App Router, TypeScript, static export), Tailwind CSS, own `ui/` design system |
| API           | Hono on Cloudflare Workers (`/api/v1/*`, versioned, one Worker)                           |
| Database      | Supabase Postgres (PostgREST over fetch; service-role only, RLS locked down)              |
| AI            | Google Gemini through a provider-independent `AiProvider` port                            |
| Scheduler     | Single Cloudflare Cron `*/5 * * * *`; timezone/day logic lives in code                    |
| Email         | Resend                                                                                    |
| Google Sheets | Sheets API v4 + Google OAuth 2.0 (refresh token encrypted with AES-256-GCM)               |
| Publishing    | LinkedIn Posts API (`/rest/posts`) with `w_member_social`                                 |
| Auth          | Supabase Auth (owner email only) via a thin Worker proxy                                  |
| Deploy        | One Cloudflare Worker serving the API _and_ the exported dashboard                        |

No paid services, no trial-dependent services, no browser automation, no scraping.

## Feature summary

**Google Sheets integration** — reads `DATE, TOPIC, CONTENT TYPE, KEY POINTS, TARGET AUDIENCE, STATUS,
GENERATED POST, HASHTAGS, APPROVAL, PUBLISH TIME, PUBLISHED URL`; tolerant header matching; serial-date and
`YYYY-MM-DD` / `DD/MM/YYYY` / `16 Nov 2026` parsing; invalid rows reported per row instead of failing the
sync; already-generated/published/rejected rows skipped; status, draft, hashtags, approval and published URL
written back.

**AI generation** — brand voice and writing rules are editable in the dashboard; prompts include recent
hooks so openings do not repeat; output is schema-constrained JSON (hook/body/hashtags); drafts are validated
(length, hashtag count, placeholder text, generic AI phrasing) with one automatic retry, and a draft that
still fails blocks the run instead of publishing something broken.

**Daily scheduler** — one 5-minute cron tick that decides in code whether anything is due (timezone-aware,
DST-safe), with a database-level "one successful generation per local date" claim, a 15-minute run lock, three
attempts per day, retry backoff for publishing, and execution logs for every decision.

**Email approval** — every draft gets a 256-bit random token; only its HMAC is stored; a single-use,
expiry-checked `UPDATE … WHERE status='pending' AND expires_at > now()` consumes it. Emails contain the full
post and link to a mobile approval page. **Nothing publishes on GET** — the page only renders; approval and
rejection are explicit POSTs.

**WhatsApp approvals (free)** — the approval email also carries a `wa.me` link with a short code already
typed in. Sending it from your own number opens the free 24-hour service window, and the bot replies with the
post plus **Approve / Reject** buttons; the same single-use token logic runs either way. Codes live 12 hours,
are stored only as an HMAC, are claimed atomically, and inbound `message.id`s are deduped so webhook retries
cannot replay a decision. Official Cloud API only — no templates, so nothing is ever billed. Setup:
[docs/WHATSAPP.md](docs/WHATSAPP.md).

**LinkedIn publishing** — official API only. Duplicate protection is layered (atomic `approved → publishing`
claim, one job row per post, published-timestamp re-check). Failures map to actionable errors; `401/expired`
tokens switch the post to the **manual fallback** (full text + LinkedIn composer link + "record manual publish"
with URL validation). Nothing is ever marked published unless LinkedIn returned a post id.

**Design system (`ui/`)** — the interface is a separate layer: `ui/tokens.css` holds every colour, radius,
blur and gradient; `ui/primitives.tsx` the components; `ui/layout.tsx` the shell; `ui/icons.tsx` every icon
(named by meaning). No page contains a raw colour or imports an icon library, and `npm run check:ui` fails the
build if one sneaks in — so the look can be replaced from one folder. Current look: glassmorphism on a
cream/mint/peach mesh, frosted white surfaces, near-black pill actions. See [docs/UI.md](docs/UI.md).

**Three drafts, one request** — each generation asks Gemini for three takes on the same topic
(angles like _failure story_, _short how-to_, _trade-off_). The `/posts` page compares them side by
side; "Use this" rewrites the post, so the approval email, the queue and the sheet keep working. The
rest are pruned 24 h later. One API call, so the free tier quota is spent once.

**Dashboard** — mobile-first, bottom navigation, thumb-sized controls, no horizontal overflow: Overview,
Content Queue, Generated Posts, Pending Approvals, Publishing History, Google Sheets + LinkedIn connections,
AI settings, scheduling settings, Activity Logs.

**Security** — all secrets are Worker secrets; OAuth tokens encrypted at rest; owner-only API (Supabase JWT +
`OWNER_EMAIL` allowlist); approval tokens hashed; input validation with zod; safe logging with redaction;
CSP-friendly static assets; `ALLOW_DEV_BYPASS` is rejected in production by the config loader.

## Quick start (local, no credentials)

```bash
npm install
cp .env.example .env.local        # then set the three generated secrets (see below)
npm run build                     # builds the static dashboard into ./out
npm run dev:api                   # API + dashboard on http://localhost:8787
```

`.env.local` for local mode (external services stubbed, nothing is really posted):

```bash
APP_ENV=development
APP_BASE_URL=http://localhost:8787
OWNER_EMAIL=you@example.com
APPROVAL_TOKEN_SECRET=$(openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
CRON_SECRET=$(openssl rand -hex 24)
SERVICES_MODE=local
ALLOW_DEV_BYPASS=true
DEV_CRON=true
```

In local mode the dashboard is seeded with a sample spreadsheet, the AI provider is a deterministic template
(clearly labelled `local-dev`), emails land in an in-app outbox (`GET /api/v1/integrations/dev/outbox`), and
the LinkedIn stub refuses to publish so the manual fallback path is what you see.

`npm run dev` instead runs `next dev` (hot reload on :3000) with `/api` proxied to :8787.

## Requirements (production)

- Node 20+ locally; Cloudflare account (free); Supabase project (free)
- Google Cloud project with the **Google Sheets API** enabled and an OAuth client (Web application)
- Google AI Studio key for Gemini (free tier)
- Resend account (free tier: 100 emails/day) and a verified sender
- LinkedIn developer app with **Share on LinkedIn** + **Sign In with LinkedIn using OpenID Connect**
- A Google Sheet using the columns above (sample: `docs/sample-content-plan.csv`)

Full step-by-step: **[docs/SETUP.md](docs/SETUP.md)**.

## Database setup

Two SQL migrations in `supabase/migrations/`:

1. `0001_schema.sql` — tables, constraints, indexes, `updated_at` triggers, RLS lockdown.
2. `0002_functions.sql` — the atomic operations the automation depends on
   (`claim_daily_topic`, `claim_publishing_jobs`, `consume_approval`, `expire_stale_approvals`,
   `claim_generation_day`, `claim_post_for_publish`, `recover_stuck_jobs`).

Apply them with the Supabase CLI or the SQL editor:

```bash
supabase link --project-ref <ref>
supabase db push          # or paste both files into the SQL editor, in order
```

Then verify the live project:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:verify
```

## Environment variables

| Variable                                                                          | Required   | Purpose                                                                           |
| --------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `APP_ENV`                                                                         | yes        | `production` enables strict config checks                                         |
| `APP_BASE_URL`                                                                    | yes        | Public URL used in approval links and OAuth redirects                             |
| `OWNER_EMAIL`                                                                     | yes        | The only account allowed to sign in / receive approvals                           |
| `APPROVAL_TOKEN_SECRET`                                                           | yes        | HMAC key for approval-token hashes (≥32 chars, rotating it invalidates old links) |
| `TOKEN_ENCRYPTION_KEY`                                                            | yes        | Base64 32-byte AES-GCM key for OAuth tokens at rest                               |
| `CRON_SECRET`                                                                     | production | Shared secret for `POST /api/v1/schedule/cron` (≥24 chars)                        |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`                | production | Database + Auth                                                                   |
| `GEMINI_API_KEY`, `AI_PROVIDER`, `GEMINI_MODEL`                                   | production | AI provider (default `gemini` / `gemini-2.5-flash`)                               |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB` | production | Sheets OAuth + target sheet                                                       |
| `GOOGLE_REFRESH_TOKEN`                                                            | optional   | Bootstrap Sheets access without the OAuth flow                                    |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL`                                             | production | Approval email delivery                                                           |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION`            | production | LinkedIn OAuth + Posts API version                                                |
| `SERVICES_MODE`                                                                   | yes        | `live` (production) or `local` (stubs; refused when `APP_ENV=production`)         |
| `ALLOW_DEV_BYPASS`, `DEV_OWNER_TOKEN`                                             | dev only   | Local unauthenticated access; rejected in production                              |
| `RATE_LIMIT_*`                                                                    | optional   | Best-effort per-isolate rate limits                                               |

## Deploy

```bash
npm run build                                         # static dashboard -> ./out
npx wrangler secret put SUPABASE_URL                  # repeat for every secret
npx wrangler deploy                                   # Worker + assets + cron trigger
```

The Worker serves `/api/v1/*` itself and the exported dashboard from `./out` (SPA fallback), so one
deployment covers everything. `wrangler.toml` already declares the `*/5 * * * *` cron and the assets binding.

## Tests

```bash
npm run doctor    # environment check with exact fix commands
npm test          # 133 tests
npm run typecheck # strict TypeScript, 0 errors
npm run build     # Next static export, 11 routes
npx wrangler deploy --dry-run --outdir=.wrangler-dist
```

Coverage highlights (all green): PostgREST adapter behaviour against a fake fetch (upsert resolution
headers, conflict mapping, retry, count parsing, RPC arguments, OAuth-state single use), timezone/DST scheduling maths, sheet parsing (serial dates, header
aliases, ineligible rows, invalid rows), hashtag/composition/validation, AES-GCM token encryption and
tamper detection, HMAC approval tokens, the full generation pipeline (duplicates, AI failure, email failure,
Sheets outage, sheet write failure, hook de-duplication), approval (single-use, expiry, reject path,
dashboard path, resend/rotation, queued publishing), publishing (idempotency, retry backoff, terminal
failure, manual fallback, manual recording, crash recovery), the scheduler tick (not-due, once-per-day,
attempt limit, publish sweep, expiry sweep, LinkedIn expiry warning) and the API surface (auth, validation,
cron secret, full generate→approve→publish flow, 404s, malformed JSON).

## Continuous integration

`docs/ci-workflow.yml` runs typecheck → tests → static build → `wrangler deploy --dry-run` on every push.
Copy it to `.github/workflows/ci.yml` to enable it (this workspace's GitHub App cannot create workflow files).

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — accounts, OAuth setup, secrets, deployment, production verification, troubleshooting
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — layers, state machines, idempotency, security model
- [docs/API.md](docs/API.md) — all `/api/v1` endpoints, [openapi.yaml](docs/openapi.yaml)
- [docs/LIMITATIONS.md](docs/LIMITATIONS.md) — free-tier limits, LinkedIn API facts, verified vs unverified
- [docs/ROADMAP.md](docs/ROADMAP.md) — phase backlog (3 draft variants next)
- [docs/UI.md](docs/UI.md) — the `ui/` design system: how to re-theme, icons, guardrails
- [docs/WHATSAPP.md](docs/WHATSAPP.md) — WhatsApp Cloud API approval setup + how it works (replaces Telegram)
- [docs/sample-content-plan.csv](docs/sample-content-plan.csv) — starter sheet

## Activating daily automated publishing (exact steps)

1. Create the Supabase project, apply both migrations, run `npm run db:verify`.
2. Create the Supabase Auth user for `OWNER_EMAIL` (email + password).
3. Create the Google Sheet from `docs/sample-content-plan.csv`, copy its ID.
4. Configure Google OAuth (Sheets scope) and the LinkedIn app (both self-serve products), add the redirect
   URIs from `docs/SETUP.md`.
5. Create the Gemini key and the Resend key + verified sender.
6. Set every secret: `npx wrangler secret put <NAME>` (list in `docs/SETUP.md`).
7. `npm run deploy`.
8. Open `https://<your-worker>/` → sign in → **Settings → Integrations** → _Connect_ Google Sheets,
   save the sheet ID/tab, _Test read_.
9. _Connect LinkedIn_ → approve the scopes → _Check status_ shows connected.
10. **Settings → Schedule**: timezone, generation time, publish time, publishing days → save.
11. Send yourself a test email (Integrations → Resend → _Send test email_) to confirm delivery.
12. Add a row to the sheet dated **tomorrow** with `STATUS=Pending`.
13. Optionally tap **Run now** (or `curl -X POST .../api/v1/schedule/run` authenticated) to see the whole
    pipeline immediately.
14. Verify in Cloudflare: _Workers → your worker → Triggers_ shows the cron, and _Logs_ shows
    `[cron] … generation=…` lines.

From then on the Worker generates, emails, waits for your approval and publishes at your publish time — with
no laptop, browser or local process involved.
