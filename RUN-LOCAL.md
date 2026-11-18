# Local run guide (VS Code)

> Ye file sirf local setup ke liye hai. Production deployment ke liye `docs/SETUP.md` dekhein.

## Requirements

- **Node.js 20 or newer** (`node -v`) — Node 22 is what this was built and tested on
- npm (comes with Node)

## 1. Install

```bash
npm ci          # or: npm install
```

## 2. Create your local env file

```bash
node scripts/init-env.mjs you@gmail.com
```

This writes `.env.local` with random secrets and local mode (`SERVICES_MODE=local`).
In local mode Google Sheets, Gemini, Resend and LinkedIn are **stubs** — nothing leaves your machine
and nothing is really published. That is intentional, so you can click through the whole system safely.

## 3. Build the dashboard and start everything

```bash
npm run build      # static dashboard -> ./out  (about 30s, first time a bit longer)
npm run dev:api    # API + dashboard together on http://localhost:8787
```

Open <http://localhost:8787> — no login needed locally (`ALLOW_DEV_BYPASS=true`).

Hot-reload dev instead (dashboard on :3000, API proxied):

```bash
npm run dev
```

## 4. Click through the pipeline (all local, no credentials)

| Where                             | What happens                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------ |
| **Queue → Sync sheet**            | imports 3 demo rows from the fake spreadsheet and shows a sample AI post       |
| **Queue → Generate now**          | draft created, "email" captured, approval row created                          |
| **Approve** tab → _Resend_        | re-sends the approval mail                                                     |
| **Approve** → open link           | `http://localhost:8787/approve/?token=…` — the exact page from the email       |
| Token                             | read it from `http://localhost:8787/api/v1/integrations/dev/outbox` (dev only) |
| **Approve → Approve**             | post becomes `approved`, publishing queued for your publish time               |
| **Posts → Record manual publish** | because the LinkedIn stub refuses to publish — paste any LinkedIn post URL     |
| **History**                       | the recorded post with its URL                                                 |
| **Settings → Logs**               | the full audit trail of everything above                                       |

> Local data lives in memory: restarting `npm run dev:api` resets everything. That is by design — no
> mock data is ever written to a real database by this path.

## 5. Run the checks

```bash
npm run doctor      # Node, env keys, build, port - sab check + fix commands
npm run typecheck   # 0 errors
npm run check:ui    # design leak guard (raw colours / stray icons)
npm test            # 133 tests
npm run build       # static export, 11 routes
```

## 6. When you want real integrations

Follow `docs/SETUP.md` §1–7. Short version:

1. Supabase project → apply `supabase/migrations/0001_schema.sql`, `0002_functions.sql`, `0003_whatsapp.sql`
   (in that order, then `npm run db:verify`)
2. Google Cloud → enable Sheets API + OAuth client (redirect `<host>/api/v1/integrations/google-sheets/callback`)
3. AI Studio → Gemini key
4. Resend → API key + sender
5. LinkedIn developer app → **Share on LinkedIn** + **Sign In with LinkedIn using OpenID Connect**
6. Put the values in `.env.local`, set `SERVICES_MODE=live` (and `ALLOW_DEV_BYPASS=false`)
7. Optional WhatsApp approvals → `docs/WHATSAPP.md` (§2 Meta setup, then **Settings → Integrations → WhatsApp → Send test message**)
8. Restart `npm run dev:api`, then **Settings → Integrations → Connect / Test**

## Troubleshooting

| Problem                                           | Fix                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE :8787`                                | something else uses the port: `PORT=8790 npm run dev:api` (or stop the other process)                       |
| Dashboard shows "Cannot reach the automation API" | you opened :3000 without running the API, or the build was skipped — use `npm run dev` or `npm run dev:api` |
| Blank page after `npm run dev:api`                | `npm run build` was not run yet (the node server serves `./out`)                                            |
| `Missing or invalid environment variables`        | `.env.local` missing → `node scripts/init-env.mjs --force`                                                  |
| kuch bhi samajh na aaye                           | `npm run doctor` chalayein — exact masla + fix command print karega                                         |
| design/colour change karna hai                    | sirf `ui/tokens.css` edit karein — `docs/UI.md` dekhein                                                     |
| `npm run check:ui` fail                           | koi page me raw colour ya `lucide-react` import aa gaya — error line follow karein                          |
| Node version error                                | upgrade to Node 20+ (`nvm install 22`)                                                                      |
