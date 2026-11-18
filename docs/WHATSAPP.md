# WhatsApp approval — setup + how it works (Phase 2)

Telegram Pakistan me blocked hai, is liye approval channel **WhatsApp Cloud API** (Meta ki official API) hai.
Koi unofficial bridge / browser automation / scraped session **nahi** — sirf official Cloud API.

> **Status: implemented aur tested** (`phase2.mjs`, 18 naye tests ke sath).
> Jo kaam Meta ki taraf se pending hai (number verification, webhook subscribe) wo aap ko ek baar karna
> hoga — jab tak wo nahi hota, email approval poora kaam karta rehta hai.

---

## 1. Free kaise rehta hai (2026 pricing)

| Cheez | Cost |
| --- | --- |
| Cloud API access, WABA, webhook | **Free** |
| Service messages (non-template replies inside the 24-hour customer window) | **1 000 free per business number per month** |
| Template messages (marketing / utility / authentication) | **Billed from the first message** |
| Messages jo aap (owner) bhejte hain | **Free** |
| Reactions | Free |

**Isliye design yeh hai — 100% free path:**

1. Post ready → **email** (Resend, free) jisme **“Approve on WhatsApp”** button hai:
   `https://wa.me/<business-number>?text=APR-XXXXXX`.
2. Button dabaayein → WhatsApp khulta hai, code pehle se typed → **Send**. Aapka inbound message
   24-ghante ka **customer service window** khol deta hai (inbound always free).
3. Usi window me bot **free-form reply** karta hai: post ka text + `✅ Approve` / `❌ Reject` buttons.
   Yeh service message hai → free tier ke andar (din me 1–2, mahine me ~60).
4. Button tap → webhook → wahi purana single-use approval system → publish + audit log.

**Templates jaan bujh kar implement nahi kiye:** har template billed hai, is liye code koi template
nahi bhejta. Bot sirf usi waqt reply karta hai jab **aap** pehle message bhejein — is tarah har message
free window ke andar rehta hai.

---

## 2. Meta side setup (ek baar)

### 2.1 Accounts

1. <https://business.facebook.com> par **Meta Business portfolio** banayein (free).
2. <https://developers.facebook.com> → **Create app** → type **Business** → portfolio select karein.
3. App dashboard → **Add product → WhatsApp → Set up**.

### 2.2 Number

- Ek number jo **currently WhatsApp par registered na ho** (spare SIM best; Cloud API se delete karne par
  dobara WhatsApp app me use ho sakta hai).
- Pakistan ke numbers supported hain; verification SMS/call se.
- Shuruat Meta ke free **test number** se kar sakte hain (5 verified recipients tak), baad me apna number.

### 2.3 IDs aur token

WhatsApp → **API Setup** se:

| Value | Kahaan milegi | Env var |
| --- | --- | --- |
| Phone number ID | API Setup → “Phone number ID” | `WHATSAPP_PHONE_NUMBER_ID` |
| Temporary token (24h) | API Setup | testing ke liye |

**Permanent token (production):** Business settings → **System users** → Add (role *Admin*) →
*Generate new token* → app select → permissions `whatsapp_business_messaging`,
`whatsapp_business_management` → `WHATSAPP_ACCESS_TOKEN`.

### 2.4 Webhook

App → WhatsApp → **Configuration → Webhook**:

- **Callback URL:** `https://<APP_BASE_URL host>/api/v1/integrations/whatsapp/webhook`
- **Verify token:** `openssl rand -hex 16` → same value `WHATSAPP_VERIFY_TOKEN`
- **Webhook fields:** `messages` subscribe karein
- App → Settings → Basic → **App secret** → `WHATSAPP_APP_SECRET` (signature verify ke liye)

### 2.5 Owner number

`WHATSAPP_OWNER_NUMBER` = aapka personal WhatsApp number, country code ke sath, digits only
(e.g. `923001234567` — `+` ya spaces ke baghair). **Sirf isi number se aane wale messages accept honge.**

---

## 3. Env vars

```bash
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_OWNER_NUMBER=923001234567
WHATSAPP_API_VERSION=v21.0
```

Worker par: `npx wrangler secret put WHATSAPP_ACCESS_TOKEN` (baaki keys bhi waise hi).
Local: `.env.local` me daal kar `npm run doctor` chalayein — WhatsApp ki state wahan dikhti hai.

Teeno (`PHONE_NUMBER_ID`, `ACCESS_TOKEN`, `OWNER_NUMBER`) set hone par channel on ho jata hai; warna
adapter disabled rehta hai aur dashboard “Connect” checklist dikhata hai.

---

## 4. Implemented surface (code map)

| File | Kya karta hai |
| --- | --- |
| `src/core/whatsapp.ts` | Code generation/normalisation, `wa.me` link, inbound handling (preview, buttons, decisions), webhook batching |
| `src/core/ports.ts` | `WhatsAppGateway` port + DB methods (`createWhatsAppCode`, `consumeWhatsAppCode`, `recordWhatsAppMessage`) |
| `src/adapters/services/whatsapp-cloud.ts` | Cloud API: `sendText`, `sendButtons`, `markRead`, HMAC verify, payload parsing, 429/5xx retry |
| `src/adapters/services/whatsapp.ts` | Disabled stub (jab credentials nahi hain) |
| `src/worker/routes/whatsapp.ts` | `GET/POST /webhook`, `GET /status`, `POST /test` |
| `src/core/generation.ts` | Approval email ke liye code issue karta hai (fail ho to email phir bhi jata hai) |
| `src/core/emails.ts` | “Approve on WhatsApp” button + text link |
| `supabase/migrations/0003_whatsapp.sql` | `whatsapp_approval_codes`, `whatsapp_messages`, `prune_whatsapp_artifacts()` |

### Endpoints

| Method | Path | Auth | Kya |
| --- | --- | --- | --- |
| `GET` | `/api/v1/integrations/whatsapp/webhook` | verify token | Meta ka `hub.challenge` handshake |
| `POST` | `/api/v1/integrations/whatsapp/webhook` | `X-Hub-Signature-256` | Inbound messages (200 hamesha, taake Meta retry loop na kare) |
| `GET` | `/api/v1/whatsapp/status` | owner | Connected? masked number, webhook URL, secrets set? |
| `POST` | `/api/v1/whatsapp/test` | owner | “PostPilot is connected ✅” message owner number par |

### Message flow

| Aap bhejein | Bot ka reply |
| --- | --- |
| `APR-XXXXXX` | post ka preview + `✅ Approve` / `❌ Reject` buttons |
| `approve APR-XXXXXX` (ya `reject …`) | decision apply + receipt (`Published ✅ <url>` / `Rejected ❌`) |
| Button tap (`approve:APR-XXXXXX`) | same decision path |
| Koi aur text | chhota help message |
| Ghair-mutasir number | ignore (sirf log) |
| Duplicate webhook delivery | ignore (`message_id` already recorded) |

### Audit events

`whatsapp.inbound`, `whatsapp.preview_sent`, `whatsapp.reply_sent`, `whatsapp.reply_failed`,
`whatsapp.duplicate`, `whatsapp.sender_rejected`, `whatsapp.signature_invalid`, `whatsapp.code_failed`,
`whatsapp.test_sent`, plus `approval.approved` / `approval.rejected` with `channel: 'whatsapp'`.
Dashboard → Settings → Logs me sab kuch nazar aata hai.

---

## 5. Security model (as implemented)

- Webhook par **HMAC-SHA256 verify** (`X-Hub-Signature-256`, app secret); mismatch → 401 + log.
- Sirf `WHATSAPP_OWNER_NUMBER` se aane wale messages process hote hain (normalised digits compare).
- Buttons me **raw approval token nahi** jata — 12-ghante ka single-use **code** (`APR-XXXXXX`,
  32-character alphabet se ~1 billion combinations), DB me sirf uska HMAC.
- Code claim **atomic** hai: Postgres me conditional `PATCH ... where used_at is null and expires_at > now()`
  (memory DB me bhi same semantics) — do button taps ek post ko do dafa publish nahi kar sakte.
- Decision phir bhi wahi purana path: `decideApproval()` → single-use, expiry-checked, POST-only, audited.
- Replay protection: har inbound `message.id` store hota hai; Meta ke retries no-op hain.
- Code 12 ghante me expire, aur email aane ke baad purana code reuse nahi hota.

---

## 6. Tests (verified, `npm test`)

`tests/whatsapp.test.ts` (16) + `tests/postgrest.test.ts` (2 naye) cover karte hain:

- code normalisation (`APR-K7M2QX`, `apr k7m2qx`, `…APPROVE APR-K7M2QX…`), mask, `wa.me` link
- email me link + DB me sirf hash
- inbound code → preview + buttons (exact button ids lagaye gaye hain)
- approve → publish + receipt + **code burn** + second tap reject
- reject → post `rejected`, koi publish nahi
- duplicate `message_id`, ghair-mutasir number, missing/bad signature
- expired code message, stale button message, help reply
- disabled channel → webhook 503, status honest
- Cloud adapter: parsing (statuses ignore), HMAC verify, Graph URL + bearer token, permanent error
  (131030) par retry nahi
- API routes: Meta handshake, signed/unsigned POST, owner auth, test message

Adapter HTTP fake fetch se test hota hai (real Meta call tests me nahi hoti — wahi ek cheez
**verified nahi** hai jab tak aap apna number add karke `POST /api/v1/whatsapp/test` na chalayein).

---

## 7. Troubleshooting

| Nazar aa raha hai | Matlab / hal |
| --- | --- |
| `131030 Recipient phone number not in allowed list` | Test number sirf 5 verified recipients ko message kar sakta hai — apna number verify karein ya production number use karein |
| `131047 Re-engagement message` | 24-ghante ka window band ho gaya — email se dobara code bhejein (bot pehle message nahi karta) |
| `401` webhook logs me | `WHATSAPP_APP_SECRET` galat / set nahi |
| Meta webhook verify fail | `WHATSAPP_VERIFY_TOKEN` aur Meta dashboard ki value same nahi |
| Status card “disconnected” | teen keys me se koi missing — card ke checklist ke mutabiq set karein |
| Bot reply nahi aaya | number `WHATSAPP_OWNER_NUMBER` se match nahi kar raha, ya window band — Logs dekhein |

---

## 8. Free-tier limits (honest)

| Limit | Value | Hamara use |
| --- | --- | --- |
| Service messages | 1 000 / number / month free | ~60–90 / month |
| 24-hour window | Aapke message ke baad khulta hai | Email link se message bhejte hain |
| Templates | Billed per message | Kabhi nahi bhejte |
| Numbers | 1 enough | 1 |
| Verification | SMS/call (business verification sirf higher limits ke liye) | chhote use ke liye nahi |

Agar kabhi bot ko **bina aapke message** ke pehle message bhejna ho (e.g. daily reminder), to utility
template + payment method chahiye hoga — wo paid hai, is liye deliberately out of scope.
