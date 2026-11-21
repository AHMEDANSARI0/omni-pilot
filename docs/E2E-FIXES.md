# e2e: do failures, aur unme se ek asli bug

`npm run e2e` par 21 me se 2 fail hue. Ek asli product bug tha, ek stale build.

---

## 1. `a second slot gets its own topic` — asli bug (slot collision)

**Kya dikha:** spec ne slot 1 ka topic banaya, par response me `slotIndex: 0` aaya. Test `201` expect kar raha
tha, mila `200`.

**Kyun:** `content_topics` par `unique (topic_date, topic)` hai. Slot 1 ka topic jab slot 0 ke wording se
milta hai (template, "part 2", ya wahi idea), to insert collide karta hai. Collision ka recovery
(`handleAllowedDuplicate`) row ko **date + wording** se dhoondta tha, **slot ko chhod kar** — is liye slot 0
ka row wapas kar deta tha `alreadyExists: true` ke saath, HTTP 200 me.

Yani: **do publish times, aur dono ka wording same → doosra slot kabhi queue hi nahi hota.** Product ke
liye bilkul ghalat, aur UI me "already queued" dikhta (jo technically sach tha, par galat slot ka).

**Fix — do jagah, dono zaroori:**

| file | change |
|---|---|
| `src/worker/routes/content-topic-input.ts` | collision lookup ab `candidate.slotIndex === slotIndex` |
| `src/adapters/db/memory.ts` | memory adapter bhi slot ke saath unique karta hai — asli index jaisa |

Doosra fix is liye zaroori tha: memory adapter slot ignore kar raha tha, is liye unit test pass hota aur
live app `409` deta. Dono jagah same rule hona chahiye, warna test jhoot bolta hai.

**Proof:**

```
pehle:  slot 0 -> 201 (slotIndex 0)   slot 1 -> 200 (slotIndex 0, alreadyExists)   ← galat
ab:     slot 0 -> 201 (slotIndex 0)   slot 1 -> 201 (slotIndex 1)                  ← theek
```

Naya test `tests/api/topics-slot.test.ts` (3 cases) ye behaviour pin karta hai: alag slots alag rows,
wahi slot dobara `alreadyExists`, aur decided slot par doosri row kabhi nahi.

---

## 2. `overview: no horizontal scroll` — stale build, code sahi hai

`a:View all=18px` — tap target 44px chahiye tha.

Code me `min-h-[44px]` maujood hai, aur sandbox me wahi element **44px** nikalta hai (Playwright se measure
kiya). Aap ke run me purana `out/` serve hua, jisme wo CSS class nahi thi — yaani `next build` us waqt chala
hi nahi tha (ya `out/` purana reh gaya).

**Fix:** kuch nahi. `npm run e2e` khud `next build && playwright test` chalata hai; poora suite dobara chalane
par ye pass hua.

---

## Verified (sandbox, real app + Chromium)

| | result |
|---|---|
| `e2e/phase10.spec.ts` | **7 / 7 pass** (pehle 1 fail) |
| `e2e/responsive.spec.ts --grep overview` | **pass** (pehle fail) |
| poora `playwright test` | **21 / 21 pass** |
| unit tests | **294 / 28 files** (3 naye) |
| `tsc` | clean |
| `next build` | clean |
| `check:ui` (design system separation) | clean |

---

## Aap ke liye

```bat
cd /d D:\Social-media-automation

:: 1. patch
node phase10-finish.mjs

:: 2. e2e (khud next build karta hai)
npm run e2e
```

Agar `View all` wala failure phir bhi aaye, to `out/` purana hai:

```bat
rmdir /s /q out
npm run e2e
```
