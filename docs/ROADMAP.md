# Roadmap & phase backlog

Ye file **single source of truth** hai: pending kaam + aane wale features, phase-wise.
Har phase ka apna `phaseN.mjs` patch hoga (delivery rules neeche).

**Status key:** `⏳ pending` · `🟦 ready to start` · `✅ done` · `⛔ blocked externally` · `❌ not possible (closed API)`

---

## 0. Non-negotiables (har phase par lagu)

| Rule            | Matlab                                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free only**   | Koi paid/trial service nahi. Naya feature = free tier me fit ho, warna nahi.                                                                                                                        |
| **Simple code** | Koi nayi dependency sirf tab jab stdlib se 3x zyada code bache. Koi giant file/component nahi (>250 lines = todna). Koi "future ke liye" abstraction nahi.                                          |
| **Fast**        | First-load JS ≤ 130 KB gzip. Dashboard route ka static HTML + 1 API call. API p95 < 300 ms (external services ke ilawa). Koi CDN font/icon/image nahi.                                              |
| **Responsive**  | 320 px se **1920 px** tak (sweep 9 widths par measured). Horizontal scroll zero. Touch target ≥ 44 px. iOS par input zoom nahi (inputs 16 px). Bottom nav `safe-area-inset`. Tables ki jagah cards. |
| **Never fake**  | Integration fail = visible failure. Success sirf verified hone par.                                                                                                                                 |
| **Delivery**    | Main **push nahi karta**. Har phase = ek `phaseN.mjs` jo idempotent ho, `.bak` banaye, mismatch par exit 1 kare. Aap: `node phaseN.mjs && npm run typecheck && npm test`.                           |

---

## Phase 0 — Activation (sirf credentials + deploy) ⛔

Code ready hai; ye external kaam aapke account par hona hai (guide: `docs/SETUP.md`).

- [ ] Supabase project + `0001_schema.sql` + `0002_functions.sql` + `npm run db:verify` + owner Auth user
- [ ] Google Cloud: Sheets API enable, OAuth client, redirect URI `<APP_BASE_URL>/api/v1/integrations/google-sheets/callback`
- [ ] Gemini API key (AI Studio, free)
- [ ] Resend key + sender (domain verify = best; warna sirf apni email par jayega)
- [ ] LinkedIn app: _Share on LinkedIn_ + _Sign In with LinkedIn (OpenID)_; redirect `<APP_BASE_URL>/api/v1/integrations/linkedin/callback`
- [ ] `npx wrangler secret put …` (16 secrets) + `npm run deploy`
- [ ] Dashboard: Connect Sheets → Test read; Connect LinkedIn → Check status; Gemini test; Resend test email
- [ ] Pehla live post (generate → email → approve → published URL)
- [ ] Cloudflare → Workers → Logs me `[cron]` lines confirm
- [ ] **Jab koi live error aaye** → error text bhejein → main usi din `phase1.mjs`-type fix dunga

**Blocked/incomplete (sirf yahan tak):** ye 5 integrations live credentials ke bagair verify nahi ho sakte.

---

## Phase 1 — Professional portal design ✅ (delivered)

Reference-style SaaS look, same functionality, no new dependencies.

- Indigo/violet theme tokens (canvas, card, soft tones, semantic success/warning/danger/info)
- Desktop sidebar (logo, real post search, active states, mode card) + sticky topbar
  (page title/subtitle, New topic, approvals bell with live count, avatar menu)
- Mobile: 6-tab bottom nav with the active icon pill and `safe-area-inset` padding (sidebar hidden < 1024px)
- Overview rebuilt: 4 metric tiles with 7-day trend, SVG publishing chart (7/30/90d, hand-rolled, no CDN),
  next-run card, activity feed, integrations list
- New API: `GET /api/v1/overview/summary` (bell count) and `series`/`trend` on `/overview`
- Posts page: full-text search (`?q=`) synced with the sidebar search + filter chips
- Sign-in: split brand panel; approval page: branded mobile layout; modal = bottom sheet on mobile
- Inputs are 16 px under 640 px (no iOS zoom), skeletons sized to content (no layout shift)
- Budget respected: first-load JS 126 KB, CSS 29 KB, zero remote assets

Delivered as `phase1.mjs`. Screenshot-level verification pending (no browser in the build sandbox) —
`npm run build` + the checks below pass.

## Phase 1b — Smoothness polish ✅ (delivered)

- **Optimistic approvals** — tap Approve/Reject aur card turant update/hide ho jata hai; request fail ho to
  card wapas aata hai + error toast (koi jhoota success nahi)
- **Silent refresh** — `useApi` purana data screen par rakhta hai, background reload sirf `refreshing` flag
  set karta hai (no flicker, no layout jump); naya `mutate()` optimistic updates ke liye
- **`npm run doctor`** — Node version, project files, dependencies, `.env.local` keys, token lengths,
  production-safety checks, built dashboard, port availability; har problem ke sath exact fix command
- `post-actions` ko naye design tokens par le aaya (canvas panels, warning/danger soft tones)

Delivered as `phase1b.mjs`.

## Phase 2 — WhatsApp approval ✅ (delivered)

Telegram Pakistan me blocked hai, is liye **WhatsApp Cloud API** (Meta official). Poora setup guide:
[docs/WHATSAPP.md](./WHATSAPP.md). Koi unofficial bridge/automation nahi.

- `WhatsAppGateway` adapter (send text, interactive buttons, mark read) + disabled stub
- Webhook: `GET` verify (`hub.challenge`) + `POST` with `X-Hub-Signature-256` verification
- **Free path:** email me "Approve on WhatsApp" link → aapka inbound message 24h service window kholta hai →
  bot free-form reply me post + `✅ Approve` / `❌ Reject` buttons bhejta hai (1 000 free service
  messages / number / month)
- Sirf owner ke number se aane wale messages; buttons me short-lived code (12 h, single-use, hashed), raw token nahi
- Templates **kabhi nahi** bheje jate — is liye kuch bhi billed nahi hota
- Audit trail: `whatsapp.inbound`, `whatsapp.reply_sent`, `approval.approved` (channel: whatsapp)
- Tests: bad signature, wrong number, expired code, replay, approve/reject

**Delivered:** `phase2.mjs`. Phone par email → “Approve on WhatsApp” → code send → post + buttons →
approve/reject. Dashboard → Settings → Integrations me WhatsApp card (status, webhook URL, test message).
`supabase/migrations/0003_whatsapp.sql` (codes + inbound dedupe + prune RPC), 18 naye tests (120 total).

## Phase 3 — UI ko alag layer + glassmorphism redesign ✅ (delivered)

Design ab code se alag hai: poora interface `ui/` me, koi page raw colour/icon use nahi karta.
Details: [docs/UI.md](./UI.md).

- `ui/tokens.css` — colours, radius, blur, shadows, mesh gradient (theek yahan badlein)
- `ui/primitives.tsx` — Card, Button, Input, Badge, Alert, Modal, PageHeader… (glass style)
- `ui/layout.tsx` — floating glass sidebar, glass topbar, mobile glass tab bar (props only, koi data nahi)
- `ui/icons.tsx` — sirf yahan lucide import; icons meaning se (`IconApprove`, `IconPosts`, `IconWhatsapp`)
- Reference jaisa look: cream canvas + mint/peach mesh, white frosted surfaces, near-black pills,
  24–28 px radius, mint accents
- `npm run check:ui` + `tests/ui-separation.test.ts` — raw colour / stray icon / ui→app dependency
  ghusne par fail
- 6 naye tests (126 total), build 120–127 kB per route (shared 103 kB)

**Delivered:** `phase3.mjs` (fewer files, deletes `components/ui`, `components/layout`, `app/globals.css`).

## Phase 4 — 3 draft variants → aap choose karein ✅ (delivered)

Content quality ka sabse bada jump.

- Ek generation call me 3 variants (schema-constrained), same topic/brand voice — **ek hi API
  request**, free-tier quota safe
- Dashboard `/posts`: side-by-side compare (mobile par horizontal snap cards), "Use this"
- Jo select ho wahi `generated_posts` ka text bane; baqi options 24h baad prune (scheduler tick)
- Decision → `post.variant_selected` log entry (Phase 7 ki hook library ka data)

**Delivered:**

- `src/core/variants.ts` — `generateDraftOptions` (1 request, har draft validate, kharab option
  drop, sab fail ho to ek retry), `selectPostVariant`, `pruneDiscardedVariants`
- `post_variants` table (`0004_post_variants.sql`), memory + PostgREST adapters
- API: `GET /posts?variants=1`, `GET /posts/:id/variants`,
  `POST /posts/:id/variants/:variantId/select`
- Email: "option 1 of 3 — compare all" line (approval link same rehta hai)
- 7 naye tests (133 total), `/posts` 5.2 kB / 124 kB first load

**Done =** 3 options me se choose karke approve; ek hi API call, koi quota blow-up nahi.

---

## Phase 5 — Shell rebuild: pinned + collapsible sidebar, mobile drawer, 320–1440 sweep ✅ (delivered)

Aapka screenshot: sidebar screen ke beech me float karta lagta tha, aur chhoti screens par navigation
sirf bottom bar tak mehdood thi.

- **Shell full-width** — rail `fixed left-0 top-0 h-[100dvh]`; content `lg:pl-[var(--sidebar-w)]`. Sirf
  reading column cap hoti hai (`--content-max: 1180px`), poora shell nahi — is liye bara screen par rail
  edge par rehta hai (pehle `max-w-[1400px] mx-auto` ki wajah se 1920 px par rail `left: 260px` par tha)
- **Collapsible rail** 264 px ↔ 72 px — toggle sidebar header me, `aria-expanded`, `localStorage`
  (`postpilot.sidebar`), `<html data-sidebar>` par mirror, active item ka indicator bar, collapsed par
  CSS-only tooltip (`aria-describedby`, keyboard focus par bhi) + badge dot; `[` shortcut
- **Mobile drawer (< lg)** — topbar me menu button, overlay sheet (backdrop click + Esc + body scroll
  lock + focus trap), route change par khud band, `safe-area-inset` padding, bottom tab bar barqarar
- **Shell split** — `ui/layout.tsx` (371 lines) → `ui/shell/` me 5 files (`shell.tsx`, `sidebar.tsx`,
  `topbar.tsx`, `drawer.tsx`, `sidebar-state.ts`) + `ui/shell.ts` barrel same; `ui/decision-group.tsx`
  (approve/reject split button) `ui/` me
- **Responsive sweep 320 → 1920** — filter/tab rails ka bleed shell padding se match (2 px overflow @1280
  gaya), touch par ≥44 px tap targets (filter chips, segmented control, day chips, switch, overview CTAs,
  approvals "Show full post"/resend), inputs 16 px (pehle se tha), zero horizontal scroll
- Also: `overflow-x: clip` on body + `scrollbar-gutter: stable` (layout shift khatam), duplicate
  "Resend email" row approvals page se hataya

**Verified in a real browser** (Playwright/Chromium, 9 widths × 8 pages = 72 measurements + 49 interaction
assertions): rail left 0 / 264 px / full height at 1280–1920, collapse → 72 px + tooltip + persistence,
drawer open/close/Escape/backdrop/navigate at 320/390/768, `scrollWidth === innerWidth` everywhere.

Screenshots ne 3 cheezein pakdi jo assertions miss kar rahi thin aur patch me fix hui hain: collapsed rail me
tooltip nav ke `overflow-y-auto` se clip ho raha tha, toggle button rail ke header se bahar nikal raha tha
(ab separate row), aur drawer me koi visible close button nahi tha (ab hai; backdrop + Esc pehle se thay).
Reports + screenshots: `docs/qa/`.

**Delivered:** `phase5.mjs` + branch/zip. Docs updated (`ROADMAP`, `UI.md`, `ARCHITECTURE.md`, `README`).

---

## Phase 6 — Calendar + charts + AI topic suggestions ✅ (delivered)

- "Suggest next week": Gemini → 5 topics (angle + key points + audience) → preview → "Add to queue"
  (wahi path jo manual topic ka hai), 60 din ke topics ke against duplicate check
- Month calendar (mobile par list, desktop par grid), slot change drag-drop (Phase 9 ke baad)
- Charts: last 30 din generated/published/failed + approval lag — **hand-rolled SVG**, koi chart lib/CDN nahi
- Manual analytics entry (LinkedIn read API closed hai): likes/comments paste → best time/topic type

**Delivered:**
- `GET /api/v1/calendar?month=YYYY-MM` + `/calendar` page (month nav, 7×5/6 grid, day detail, publishing-day
  and today markers, gaps list). Server resolves `kind/title/isPublishingDay/isToday` — the UI does no date maths.
- `POST /api/v1/content/suggestions` + `/suggestions/accept`: one AI call → dated ideas → owner keeps/drops →
  accepted rows go through the same `createTopic` path as a manual topic. Nothing is stored before accept.
  Local provider answers deterministically and says so in the UI (`local/<model>`).
- Duplicate guard (trigram Jaccard ≥ 0.55 against the last 60 days) drops an idea and shows *why* — it never renames it.
- Charts: `src/core/activity.ts` buckets generated / published / **failed** per local date over 90 days;
  approval lag = median `usedAt − emailSentAt` on decided approvals (`null` + "not measured yet" until the
  first decision — never a fake zero).
- Overview page is read-only now; every action lives on the queue (bundle stayed inside the 130 kB budget).

**Manual analytics entry (Meta/read API) is not in this phase** — LinkedIn's read API is closed, so
per-post likes/comments would have to be typed in by hand. Deferred (Phase 7 shipped the library itself
without it); nothing fake is shown in the meantime.

---

## Phase 7 — Duplicate protection + hook library ✅ (delivered)

- Near-duplicate detection: last 180 din ke hooks/bodies se trigram similarity > 0.75 = warn/skip
- Hook library: approved vs rejected patterns, top-performing hooks (manual metrics se)
- Prompt me top hooks inject (already recent hooks jaate hain — isko smarter karna)

**Delivered:**
- `src/core/duplicate.ts` — one word-trigram Jaccard implementation used by **both** entry points:
  AI suggestions (threshold 0.55) and generated drafts (hook 0.62, then body 0.55), over the last
  180 days. Stop words removed, light stemming so "retries"/"retry" compare equal.
- Generation drops a draft that repeats recent work, retries with the reason ("Repeats earlier work: …"),
  and **fails loudly** if every attempt repeats — a duplicate is never published quietly.
- Manual topic entry is guarded too: `POST /content/topics` returns **409 `DUPLICATE_TOPIC`** naming the
  earlier topic and date. `allowDuplicate: true` keeps it deliberately; the queue dialog shows an
  "Add anyway" confirmation instead of a toast nobody reads.
- `src/core/hooks.ts` + `GET /content/hooks` + `/hooks` page: proven / waiting / rejected buckets,
  pattern counts, and the **exact** `promptBlock` the generator receives (shown verbatim).
- A hook is "proven" only when its post actually published (or "rejected" when the owner said no).
  Nothing is scored by a model; an empty library says so instead of inventing a section.

**Still open:** manual analytics entry (likes/comments) — the input side of Phase 8's "top-performing
hooks". Deferred until there is a real read API or a paste form the owner actually uses.

---

## Phase 8 — Deploy-ready database + honesty fixes ✅ (delivered)

Language **skip** (user decision, 18 Nov): multi-language abhi nahi chahiye. Phase 8 wo kaam karta hai
jo deploy rok raha tha, plus Phase 7 ke do adhoore items.

- **Migrations 0001–0003 + 0004 grants**, Docker par proven (dekhein Phase 12b upar)
- `npm run db:contract` (32 assertions), `npm run db:local`, `tests/migrations.test.ts`
- **Queue "Add anyway" fix**: exact same topic + same date ab `200 { alreadyExists: true }` deta hai aur
  UI kehti hai "Already in the queue for <date> — nothing added" (pehle raw `CONFLICT` aata tha);
  jo topic already generate ho chuka ho uske liye `DUPLICATE_TOPIC` status ke sath
- **Debt**: `tests/api.test.ts` (480) → `tests/api/{surface,planning,protection}.test.ts` + `request.ts`;
  `src/worker/routes/content.ts` (370) → `content-topics/content-posts/content-runs` + `content.ts` barrel.
  Sab files 250 lines se neeche
- 201 tests green, `tsc` 0, `check:ui` clean, build 12 routes

**Language (EN + Urdu/Roman Urdu) abhi bhi open hai** — jab aap kahein, settings me per-language voice +
sheet ka `LANGUAGE` column + ek topic se do posts (slots ke sath natural).

---

## Phase 9 — E2E + quality gate ⏳ (next)

- Playwright E2E repo ke andar (`docs/qa/` harness abhi repo ke bahar hai): sign-in → topic → generate
  → approve (email/WhatsApp code) → publish (fake services) — 320 px aur 1440 px dono par
- `npm run e2e` ek command; CI-ready, koi flaky wait nahi
- `src/core` coverage ≥ 85% (abhi measured nahi)
- Bug sweep: `/calendar` 1440 px overlap, `PHASE6-DELIVERED.md` ka purana fingerprint

---

## Phase 10 — Slots + PWA + OmniFlow API ⏳

- Migration: `run_date` unique → `(run_date, slot)` unique; settings me slots (e.g. 09:30, 17:00) +
  per-slot topic mapping; scheduler me per-slot claim + publish time; purana data safe (default slot `am`)
- `manifest.webmanifest` + service worker (static export ke sath) → phone home screen
- Web Push (VAPID, free) jab approval pending ho ya publish fail ho
- Offline shell: "no connection" screen, data cached nahi (privacy)

---

## Phase 11 — Doosra platform (Threads ya Dev.to) ⏳

`PublishTarget` port already maujood hai.

- Threads API (free, self-serve, text) **ya** Dev.to API (free, markdown) — ek se shuru
- Settings: per-platform on/off + separate brand voice
- Publishing job me `target` column; idempotency per target
- OmniFlow ke liye pehla concrete step

---

## Phase 11b — OmniFlow integration (API keys + webhooks) ⏳

- Read-only API keys (hashed) + `post.published`, `approval.pending`, `publish.failed` webhooks
- HMAC-signed payloads, retry with backoff, delivery log
- Multi-workspace ke liye `workspace_id` column (schema ready, UI baad me)

---

## Phase 12 — Load + coverage deepening ⏳

- Playwright E2E: sign-in → generate → approve → publish (fake services) on 320 px + desktop
  (Phase 5 ne shell ke liye harness bana diya — `docs/qa/`, usko repo ke andar move karna hai)
- Coverage threshold (core `src/core` ≥ 85%)
- Load check: 1000 posts par list query < 100 ms (indexes verify)

---

## Phase 12b — Migration recovery (0001–0003) ✅ (delivered in Phase 8)

`supabase/migrations/` me sirf `0004_post_variants.sql` tha — `0001_schema.sql`, `0002_functions.sql`,
`0003_whatsapp.sql` repo me nahi thay. `npm run db:verify` 12 tables + 8 RPCs expect karta hai, aur
0004 unhi par depend karta hai. Is liye **real deploy possible nahi tha**.

**Delivered:**
- `0001_schema.sql` — 9 tables (settings, topics, posts, approvals, jobs, integrations, oauth states,
  logs, scheduler state), indexes, `updated_at` triggers, singleton rows, RLS + grants
- `0002_functions.sql` — 8 RPCs (claims, sweeps, prune), `security definer` + `search_path = ''`
- `0003_whatsapp.sql` — codes + inbound dedupe, RLS + grants
- `0004_post_variants.sql` — service-role grants add kiye (pehle table banti thi, likhna fail hota tha)
- **Docker par asli verification**: `docker/compose.local.yml` (Postgres 17 + PostgREST + gateway),
  `npm run db:local` → roles, migrations ×2 (idempotency), RLS/anon check, contract check
- `npm run db:contract` — **32 assertions** asli `PostgrestDatabase` ke through (single-use approvals,
  day claim, one post per day, locked jobs, WhatsApp dedupe). Local Postgres 17.12 + PostgREST 12.2.3
  par green; fixtures `2038-04-05/06` par, end me delete.
- `tests/migrations.test.ts` (8 tests) — adapter ki har query ka table/RPC migrations me maujood hai,
  RLS + grants + idempotency; SQL me `grant ... to anon` ghusne par fail
- Load check 1000 posts: newest-100 `3.6 ms`, deep page `3.6 ms`, topics `3.0 ms`, logs `2.4 ms`
  (target < 100 ms)

**Do asli bugs pakde gaye** (dono sirf real Postgres par dikhte hain, aur dono production-breaking thay):
1. `claim_generation_day` fresh row par **kabhi true nahi** deta tha (NULL comparison) → live par cron
   generation claim hi nahi kar pata
2. `post_variants` par service-role **grant missing** → 3-draft feature live par `permission denied`

**Still open:** free-tier Supabase project par ek dafa `npm run db:verify` + `npm run db:contract`
chalana aapke account se (mere paas credentials nahi). Baqi sab local stack par proven hai.

---

## Deferred / closed doors (honest)

| Cheez                                           | Status                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Post performance read karna (likes/impressions) | ❌ `r_member_social` closed — manual entry hi option                          |
| Comments par auto-reply                         | ❌ read permission closed                                                     |
| Company page publishing                         | ⛔ partner-gated (LinkedIn review)                                            |
| Image/carousel posts                            | ⏳ possible (Documents API + media upload), effort zyada — Phase 13 candidate |
| Paid analytics SaaS, multi-tenant billing       | ⛔ scope se bahar (personal tool)                                             |

---

## Status tracker

| Phase | Feature                                | Status                | Patch file     |
| ----- | -------------------------------------- | --------------------- | -------------- |
| 0     | Activation (creds + deploy)            | ⛔ aapke accounts par | —              |
| 1     | Professional portal design             | ✅ done               | `phase1.mjs`   |
| 1b    | Smoothness polish + doctor             | ✅ done               | `phase1b.mjs`  |
| 2     | WhatsApp approval                      | ✅ done               | `phase2.mjs`   |
| 3     | UI layer + glass redesign              | ✅ done               | `phase3.mjs`   |
| 4     | 3 draft variants                       | ✅ done               | `phase4.mjs`   |
| 5     | Responsive shell + collapsible sidebar | ✅ done               | `phase5.mjs`   |
| 6     | Calendar + charts + AI suggestions     | ✅ done               | `phase6.mjs`   |
| 7     | Duplicate guard + hook library         | ✅ done               | `phase7.mjs`   |
| 8     | Multi-language                         | 🟦 next               | `phase8.mjs`   |
| 9     | Multi-post slots + PWA                 | ⏳                    | `phase9.mjs`   |
| 10    | Second platform                        | ⏳                    | `phase10.mjs`  |
| 11    | OmniFlow API + webhooks                | ⏳                    | `phase11.mjs`  |
| 12    | E2E + coverage                         | ⏳                    | `phase12.mjs`  |
| 12b   | Migration recovery (0001–0003)         | ✅ done (in phase8)   | `phase8.mjs`   |

> Order badal sakta hai — aap jo kahein wo phase pehle. Har phase ke baad: `npm run typecheck && npm test` green hona chahiye.
> File names delivery order se chalte hain: phase1 = design, phase1b = polish, phase2 = WhatsApp,
> phase3 = UI layer, phase4 = 3 drafts, phase5 = responsive shell ...
> Phase 12b (migrations) kisi bhi waqt pehle uthaya ja sakta hai — wo deploy ka blocker hai, feature nahi.
## Phase 9 — delivered

- `e2e/` (Playwright, 14 tests): the whole chain, both safety guards, 8 pages x 9 widths (320-1920).
- Coverage gate in `vitest.config.ts`: `src/core` >= 85% lines/functions/statements, branches >= 75%.
  Today: 90.35% / 93.71% / 81.92% across 221 tests.
- `npm run check`: typecheck -> UI guard -> coverage -> e2e in one command.
- Found and fixed: published-link tap targets on phones (18px/36px -> 44px), and a "from .. to" date
  filter that silently dropped its lower bound (PostgREST takes one operator per column).
- `docs/TESTING.md`: the three layers, the re-run rules, and what is deliberately not tested.
- Multi-language stays skipped, as you asked.
