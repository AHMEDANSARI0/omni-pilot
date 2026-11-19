# Database: schema, migrations and how they are proven

Ye file batati hai ke database me **kya** hai, **kaise** verify hota hai, aur kya cheez kya guard
karti hai. Supabase setup ke steps `docs/SETUP.md` me hain.

---

## 1. Files

| File                        | Kya banata hai                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| `0001_schema.sql`           | 9 tables + indexes + `updated_at` triggers + singleton rows + RLS/grants        |
| `0002_functions.sql`        | 8 RPCs (atomic claims, sweeps, prune)                                          |
| `0003_whatsapp.sql`         | `whatsapp_approval_codes`, `whatsapp_messages` + indexes + RLS                  |
| `0004_post_variants.sql`    | `post_variants` (3 draft options) + indexes + grants                            |

Charon files **idempotent** hain: `if not exists` / `create or replace` / `drop trigger if exists`.
Poora folder do baar chalane par bhi kuch nahi tootta — `npm run db:local` yehi karta hai aur wo
test ka hissa hai.

## 2. Tables (12)

| Table                     | Role                                                                  | Key guard                                        |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| `app_settings`            | Singleton settings (`id boolean primary key default true`)            | `check (id)` → doosri row insert hi nahi hoti     |
| `content_topics`          | Planning queue (sheet import + manual + AI suggestions)               | `unique (topic_date, topic)`                      |
| `generated_posts`         | Posts — approvals aur publishing ka single source of truth            | `unique (run_date)` → din me ek post              |
| `approval_requests`       | Ek row per approval email/WhatsApp message                            | `unique (token_hash)` + single-use RPC            |
| `publishing_jobs`         | Ek job per post                                                       | `unique (post_id)`                                |
| `integrations`            | Provider state (encrypted tokens)                                      | `primary key (provider)`                          |
| `oauth_states`            | Single-use OAuth CSRF state                                            | `primary key (state)`, read par delete            |
| `execution_logs`          | Append-only audit trail (redacted context)                             | `bigint identity`                                 |
| `scheduler_state`         | Singleton cron state                                                   | `check (id)`                                      |
| `whatsapp_approval_codes` | `APR-XXXXXX` codes (hashed, single-use, TTL)                           | `primary key (code_hash)`                         |
| `whatsapp_messages`       | Inbound message ids (webhook dedupe)                                   | `primary key (message_id)`                        |
| `post_variants`           | 3 draft options; exactly one `selected`                                | `unique (post_id, variant_index)`                 |

## 3. RPCs (8)

| Function                       | Kya karta hai                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `claim_generation_day`         | Aaj ka generation claim; `succeeded` din dobara claim nahi hota                   |
| `claim_daily_topic`            | Us din ka pehla claimable topic → `claimed` (`FOR UPDATE SKIP LOCKED`)            |
| `claim_post_for_publish`       | `approved → publishing` atomically                                                |
| `claim_publishing_jobs`        | Due + unlocked jobs → `processing`, 10 min lock                                   |
| `recover_stuck_jobs`           | Purane `processing` jobs wapas `queued`; atke hue posts `approved`                |
| `consume_approval`             | Pending + unexpired token ko ek dafa consume; replay par 0 rows                   |
| `expire_stale_approvals`       | TTL cross ho chuke approvals/posts → `expired`                                    |
| `prune_whatsapp_artifacts`     | Purane codes (7 din) aur message ids (30 din) delete                              |

Sab `security definer` + `search_path = ''`, aur `execute` sirf `service_role` ko.

## 4. Security model

- Har table par **RLS enabled**, aur **koi policy nahi** — matlab `anon`/`authenticated` ke liye table
  khali dikhta hai, likhna to door.
- `anon`/`authenticated` se **revoke all**; `service_role` ko **grant all** (ya `execute` for RPCs).
- Browser database se baat hi nahi karta: dashboard sirf Worker ke `/api/v1` se baat karta hai, Worker
  service-role key use karta hai (Cloudflare secret, bundle me kabhi nahi).

Ye teen baatein automated hain — `npm run db:local` RLS + grants + anon-read = 0 assert karta hai, aur
`tests/migrations.test.ts` SQL folder me `grant ... to anon` ghusne par fail ho jata hai.

## 5. Verification (teen layer)

| Command            | Kya prove karta hai                                                        | DB chahiye |
| ------------------ | -------------------------------------------------------------------------- | ---------- |
| `npm test`         | `tests/migrations.test.ts`: adapter ki har query ka table/RPC migration me maujood, RLS/grants/idempotency | nahi |
| `npm run db:verify`| Objects maujood hain (12 tables, 8 RPCs, singletons)                       | haan       |
| `npm run db:contract` | **Asli adapter** ke 32 behaviour assertions (single-use, claims, locks) | haan       |

### Bina Supabase account ke (local stack)

```bash
docker compose -f docker/compose.local.yml up -d   # Postgres 17 + PostgREST + nginx gateway
npm run db:local                                    # roles, migrations ×2, RLS/anon check, contract
docker compose -f docker/compose.local.yml down -v  # cleanup
```

Local stack Supabase jaisa hi shape deta hai (`<url>/rest/v1/<table>`), is liye product code me koi
`if (local)` branch nahi hai. `npm run db:local` `SUPABASE_URL` ko chhoota hi nahi — production par
galti se chalne ka sawal nahi.

## 6. Phase 8 me kya theek hua

Reconstruct karte waqt do asli bugs pakde gaye (dono sirf real Postgres par dikhte hain):

1. **`claim_generation_day` kabhi true nahi deta tha** — fresh row ki `last_generation_date` NULL hoti
   hai, aur `last_generation_date = p_date` NULL return karta hai, is liye poora `where` false ho jata
   tha. Ab `is not distinct from` use hota hai. Iska matlab tha: **live deploy par cron kabhi generation
   claim nahi kar pata.**
2. **`post_variants` par `service_role` grant missing tha** — table banti thi lekin Worker ko
   `permission denied for table post_variants` milta, matlab 3-draft feature live par chalta hi nahi.
   0004 me grants add ho gaye.

Dono ke liye ab test hai (`claimGenerationDay grants a fresh day`, `createVariants stores every option`
in `db:contract`).

## 7. Free tier

Sab kuch Supabase free tier me fit hai: 12 tables, 8 functions, koi storage bucket nahi, koi realtime
subscription nahi. Sirf row growth hai (`execution_logs`, `post_variants`, `whatsapp_messages`), aur
teenon ke liye prune path maujood hai.
