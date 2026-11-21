# `npm run db:contract` — aur do bugs jo usne pakde

`db:verify` sirf poochta hai "ye object maujood hai?". `db:contract` **behaviour** prove karta hai: asli
`PostgrestDatabase` adapter ko asli PostgREST ke against chalata hai. 47 assertions.

Pehla run do cheezon par ruka, aur dono asli the.

---

## 1. `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required` — keys wahin thi

`db:verify` `.env.local` khud load karta tha; `db:contract` nahi karta tha. Do script, do behaviour.

**Fix:** dono ab `scripts/lib/env.ts` se guzarte hain — ek jagah se `.env.local` load, key ka **role**
check, aur galat key par ek saaf message (31 `permission denied` lines nahi).

```bat
:: keys .env.local se aati hain, koi set karna nahi padta
npm run db:verify
npm run db:contract
```

---

## 2. `a second slot of the same day is a different post — refused`

Ye asli schema bug tha, aur serious: **ek din me doosra post kabhi ban hi nahi sakta tha.**

`0001` me `generated_posts` par `unique (run_date)` tha — "din me ek post". `0005` ne `unique (run_date,
slot_index)` add kiya, par purana constraint **drop nahi kiya**. Purana apni jagah khada tha, is liye naya
index bekaar tha: slot 1 ki insert `run_date` par hi takra jati thi.

Do publish times configure karte hi ye dikhta — aur tab tak sab kuch theek lagta hai.

**Saboot** (plain SQL, PostgREST ke bina):

| | pehle | ab |
|---|---|---|
| slot 0 insert | ok | ok |
| **slot 1, wahi din** | `duplicate key … (run_date) already exists` | **ok** |
| wahi slot dobara | refused | refused |

**Fix** — `0005` me:

```sql
alter table public.generated_posts drop constraint if exists generated_posts_run_date_key;
drop index if exists public.generated_posts_run_date_key;

create unique index if not exists generated_posts_date_slot_key
  on public.generated_posts (run_date, slot_index);
```

`docs/DATABASE.md` me bhi `unique (run_date)` galat likha tha — ab `unique (run_date, slot_index)`.

---

## 3. Contract apne fixtures chhod raha tha

Ek run ke baad database me `generation_claims` ke 2 rows aur `whatsapp_messages` ka 1 row bache hue the.
`cleanup()` un do tables ko bhool raha tha. Ab dono saaf hote hain — aur run ke baad ginti karke dekha gaya
hai ke kuch nahi bachta.

---

## Kaise verify hua

Bina Supabase account: Postgres 17.11 + ek chhota PostgREST shim (GET/POST/PATCH/DELETE + `/rpc`, `on_conflict`,
`eq`/`in`/`like`/`neq` filters, asli PostgREST ke response shapes).

| | result |
|---|---|
| assertions | **47 / 47 pass** |
| run ke baad leftovers | **0 rows** (13 tables check kiye) |
| do slots, ek din | dono insert hote hain |
| wahi slot dobara | database refuse karta hai |
| `db:verify` | 11/11 RPCs + 18 tables |
| unit tests | 291 / 27 files |
| `tsc`, `next build` | clean |

Shim workspace me nahi hai — wo sirf sandbox me proof ke liye tha. Aap ke paas asli Supabase hai, jo isse
behtar hai.
