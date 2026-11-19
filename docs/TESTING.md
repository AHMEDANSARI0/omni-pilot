# Testing: unit, database, and end-to-end

Teen layers hain, aur teenon ek command se chalte hain:

```bash
npm run check          # typecheck → UI guard → unit+coverage → e2e
```

Har layer ka apna kaam hai. Koi layer doosri ka kaam nahi karti, is liye failure ka matlab foran
samajh aata hai.

| Layer | Command | Kya pakadta hai | Kitna waqt |
| --- | --- | --- | --- |
| Unit + contract | `npm test` | 221 tests: business rules (`src/core`), API envelopes, adapter queries, migrations | ~8 s |
| Coverage gate | `npm run coverage` | `src/core` 85% se neeche gira | ~10 s |
| Database | `npm run db:contract` | asli SQL behaviour (single-use approvals, claims, locks) | ~1 s (stack chahiye) |
| End-to-end | `npm run e2e` | poori chain, asli browser, asli build | ~1.5 min |

---

## 1. Unit tests (`tests/`)

`vitest`, node environment, koi browser nahi. Har file ek behaviour par:

| File | Kya |
| --- | --- |
| `tests/api/*.test.ts` | HTTP surface: status codes, envelopes, auth, duplicate guard, planning |
| `tests/generation.test.ts` | draft validation, duplicate rejection, retry, failure paths |
| `tests/duplicate.test.ts` | trigram similarity, stemming, thresholds, windows |
| `tests/hooks.test.ts` | proven/waiting/rejected buckets, prompt block |
| `tests/migrations.test.ts` | har adapter query ka table/RPC migrations me maujood, RLS, grants, idempotency |
| `tests/prompt.test.ts` | prompt ki honesty rules, budget, hook-library block |
| `tests/variants.test.ts`, `approval`, `publishing`, `scheduler`, `whatsapp`, `crypto`, `format`… | baqi core rules |
| `tests/postgrest.test.ts` | har query string: operators, ranges, headers, retry, conflict mapping |

**Coverage gate** (`vitest.config.ts`): `src/core` **lines/functions/statements ≥ 85%**,
branches **≥ 75%**. Branches kam is liye ke retry-loop ke wo branches jo sirf live third-party failure
par chalte hain, behaviour ke through test hote hain — har branch ko zor se hit karwana test ko naazuk
banata hai. Aaj: **90.35% lines, 93.71% functions, 81.92% branches**.

## 2. Database contract (`scripts/verify-db-contract.ts`)

`npm run db:contract` — 32 assertions asli `PostgrestDatabase` ke through (Supabase ya local stack).
Yehi wo layer hai jisne Phase 8 me do production-breaking bugs pakde (NULL day-claim, missing
`service_role` grant) jo local database par kabhi nahi dikhte.

## 3. End-to-end (`e2e/`, Playwright)

```bash
npm run e2e            # next build + playwright test
npm run e2e:only       # build ke bagair (server khud uthta hai)
npm run e2e:ui         # interactive runner
```

**Kya chal raha hota hai:** asli Hono app (wahi jo Cloudflare par jata hai) + asli static export
(`out/`), port `8799` par. Google Sheets, Gemini, Resend aur LinkedIn **local stubs** hain, is liye
kuch bahar nahi jata — magar validation, database writes, approval tokens, publishing jobs sab asli
code path hain. Cron race na ho, is liye test khud tick chalata hai.

| Spec | Kya prove karta hai |
| --- | --- |
| `e2e/journey.spec.ts` | topic → generate (3 options, ek selected) → approval email → `/approve` par approve → publish (ya honest `manual_required` + URL record) → `/hooks` par proven hook + exact prompt block |
| `e2e/safety.spec.ts` | duplicate guard (warning + "Add anyway" ka sach), kisi doosri date par asli add, approval link single-use (dobara "already rejected") |
| `e2e/responsive.spec.ts` | 8 pages × 9 widths (320–1920): zero horizontal scroll, 44px tap targets, 16px inputs; phone drawer + desktop sidebar collapse/persist |

**Re-runs:** suite dev server ke against dobara chal sakti hai. Database singleton hai aur ek din ka ek
post product rule hai, is liye har spec apni date khud chunti hai (`pickFreeDate`) aur email apni date se
dhoondti hai — "last message in the outbox" kabhi nahi. Skip hona accept nahi: skip kuch prove nahi karta.

**Evidence:** koi bhi console error, uncaught page error ya failed request test fail karta hai —
`e2e/fixtures.ts` me. Do cheezein jaan bujh kar ignore hain, aur dono comment me likhi hain:
browser ka apna 4xx log (duplicate guard ka 409 product behaviour hai) aur Next.js ka aborted RSC/chunk
prefetch (navigation ke waqt cancel hota hai).

Failure par `e2e/artifacts/<test>/` me screenshot + trace + page snapshot milta hai; HTML report
`e2e/report/index.html`.

### Ek dafa ka setup

```bash
npm install
npx playwright install chromium      # browser binaries
```

Linux par agar browser libs missing hon: `npx playwright install-deps` (root), ya Debian par
`apt-get download libnspr4 libnss3 libatk1.0-0t64 … && dpkg-deb -x` aur `LD_LIBRARY_PATH` set karein.
Windows/macOS par ye step nahi chahiye.

## 4. Is phase me E2E ne kya pakda

Teen asli defects, teenon UI/API ke andar the — unit tests inko nahi pakad sakte the:

1. **Phone par tap targets chhote the.** Published post ka LinkedIn URL link 18px aur "View on LinkedIn"
   36px tha (contract: 44px se kam nahi, ≤390px par). `posts`, `history` aur `post-actions` me fix hua.
2. **`from .. to` date range ka lower bound silently drop ho raha tha.** PostgREST ek column par ek hi
   operator leta hai, aur adapter `topic_date=gte.x` ke baad `topic_date=lte.y` likh raha tha — doosri
   assignment pehli ko overwrite kar deti thi, is liye "1 se 31 tarikh" ka filter *sab kuch* laata tha.
   Ab `and=(topic_date.gte.x,topic_date.lte.y)` jata hai. `tests/postgrest.test.ts` isay pin karta hai
   (`listTopics` + `listPosts`).
3. **Retired harness ke scripts.** `qa:*` scripts us harness ko call karti thin jo ab exist nahi karta;
   patch unhe hata deta hai.

Ek false alarm bhi tha: `/calendar` ka "1440px overlap" reproduce nahi hua (1024/1280/1440 par 35 cells,
zero overlap) — Phase 6 me fix ho chuka tha, aur ab spec use har run par check karta hai.

## 5. Jo jaan bujh kar test nahi hota

- **Live Gemini/Resend/LinkedIn/Sheets calls.** Stubs hi chalte hain; asli credential flow Phase 0
  (aapke accounts) ka kaam hai. Is liye e2e me LinkedIn na hone par `manual_required` ek *valid*
  outcome hai, aur test usi honest path ko verify karta hai — jhoota "published" nahi.
- **Timing-dependent retries** (network backoff) — unit level par clock inject karke test hote hain,
  wall-clock se nahi.
- **Visual pixel diffs** — screenshots sirf failure evidence ke liye hain. Layout contract
  (overflow, tap targets, input size) measured assertions se enforce hota hai, image diff se nahi.
