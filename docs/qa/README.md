# Responsive verification (Phase 5)

Phase 1–4 ke docs kehte the "visual verification nahi hui — koi headless browser nahi tha". Phase 5 me wo
gap band ho gaya: ye numbers **real Chromium** se aaye hain, guess nahi.

## Kaise chalana hai

```bash
# terminal 1
node scripts/init-env.mjs you@gmail.com     # agar .env.local nahi hai
npm run build
npm run start                               # http://localhost:8787

# terminal 2 (repo ke bahar, taake node_modules heavy na ho)
npm i playwright && npx playwright install chromium
node docs/qa/audit.mjs after                # 9 widths × 8 pages = 72 measurements
node docs/qa/interactions.mjs               # 49 interaction assertions
```

`audit.mjs` har page par measure karta hai: horizontal overflow (`documentElement.scrollWidth` vs
`innerWidth`), kaun se elements viewport ke bahar nikal rahe hain, 44 px se chhote tap targets, 16 px se
chhote inputs, aur sidebar ka geometry (left/width/height). Screenshots `after/` folder me girte hain.

> **Note:** `body { overflow-x: clip }` overflow ko chhupata hai, is liye audit `scrollWidth` par
> karta hai — sirf nazar ka dhoka nahi. Agar scrollWidth > innerWidth hua to report me `**+Npx**` aata hai.

## Before → after (measured)

| Cheez                    | Before (phase 4)                                             | After (phase 5)                                      |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| Sidebar @1920 px         | `left: 260`, floats in the middle (`max-w-[1400px] mx-auto`) | `left: 0`, 264 px, `100dvh`, pinned                  |
| Sidebar @1024 px         | `width: 517` (stretched), top 12                             | 264 px, top 0                                        |
| Sidebar below lg         | koi menu button nahi, drawer nahi                            | drawer + menu button + bottom bar                    |
| Horizontal overflow      | `settings` @1280 **+2 px**                                   | 0 px at all 72 page/width combinations               |
| Tap targets < 44 px @320 | 13 (overview), 18 (posts), 10 (settings)                     | 0 in the shell chrome; page-level controls 44 px par |
| Inputs < 16 px (phones)  | none                                                         | none (unchanged)                                     |
| Collapse                 | —                                                            | 264 ↔ 72 px, tooltip, `localStorage`, `[` shortcut   |

Full tables: [`responsive-before.md`](./responsive-before.md) · [`responsive-after.md`](./responsive-after.md).

Screenshots (320 · 390 · 768 · 1024 · 1440 · 1920, three pages): [`screenshots/`](./screenshots) —

| Desktop 1920        | Desktop 1440 (collapsed rail) | Phone 390          | Phone 390 (drawer) |
| ------------------- | ----------------------------- | ------------------ | ------------------ |
| `overview-1920.png` | `posts-1440.png`              | `overview-390.png` | `settings-390.png` |

## Interaction assertions (`interactions.mjs`, 49/49)

- rail left edge = 0, width 264, height = viewport, does not move on scroll
- collapse → 72 px, `data-sidebar="collapsed"`, `aria-expanded="false"`, `localStorage` set, tooltip visible
  on hover, main column reflows, survives navigation, `[` expands again
- 320 / 390 / 768: menu button visible, drawer absent from DOM while closed, opens, body scroll locked,
  focus moves inside, hugs the left edge, fits the screen, Escape closes, backdrop closes, navigating closes,
  bottom tab bar still present, zero horizontal overflow

## Jo browser se pakda gaya par pehle kisi doc me nahi tha

1. `settings` @1280 px par **2 px** ka real horizontal overflow (filter rail ka `-mx-4` content padding se
   bara tha).
2. `signin` @1024–1440 par ek decorative orb `left: -51` par nikal raha hai — design ke mutabiq hai
   (`pointer-events-none`, page par scroll nahi deta), is liye chhoda gaya.
3. `/posts` ka filter rail 320 px par viewport se 494 px chaura hai — internal horizontal snap rail hai
   (page scroll zero), filter chips 44 px tap height ke sath scroll karte hain.
