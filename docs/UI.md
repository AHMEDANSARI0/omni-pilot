# UI layer — glass design system

Poora interface ab **`ui/`** folder me hai. Jab bhi design, colour, radius, blur ya icon change karna ho,
sirf yahan hath lagana hai — pages, API, worker, tests ko chhune ki zaroorat nahi.

```
ui/
├─ tokens.css      ← colours, radius, blur, shadows, gradients (THE theme file)
├─ theme.ts        ← JS mirror (SVG charts ke liye)
├─ icons.tsx       ← sirf yahan lucide import hota hai; naam meaning se (IconApprove, IconPosts)
├─ primitives.tsx  ← Button, Card, Input, Badge, Alert, Modal, PageHeader, Segmented, Switch …
├─ layout.tsx      ← Shell, sidebar, topbar, mobile tab bar (sirf props, koi data nahi)
├─ nav.ts          ← navigation model + page titles
├─ index.ts        ← pages ke liye barrel (primitives + icons)
└─ shell.ts        ← app shell ke liye barrel (layout + nav)
```

**Rule:** `ui/` kabhi `@/lib`, `@/src`, `@/components` ya `@/app` import nahi karta. Data wiring
`components/app-shell.tsx` me hoti hai (wo `Shell` ko props deta hai). Isi wajah se design replaceable hai.

Do entry points jaan bujh kar rakhe gaye hain:

- `@/ui` → primitives + icons (har page isi se import karta hai)
- `@/ui/shell` → Shell + NAV (sirf `components/app-shell.tsx`)

Agar shell ko `@/ui` se bhi export kar dein to har page me poora navigation + nav icons chala jata hai
(bundle 5 kB barh jata hai) — is liye alag rakha hai.

---

## Ab ka look (glassmorphism)

Reference image se liya gaya direction:

| Element                  | Value                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Canvas                   | cream `hsl(40 38% 96%)` + fixed mesh: mint top-left, peach top-right, coral bottom-right |
| Surfaces                 | white 58% + `backdrop-blur(18px)` + 1px white hairline + soft shadow = `.glass`          |
| Sidebar / topbar / modal | `.glass-strong` (82% white, blur 28px)                                                   |
| Primary action           | near-black pill `hsl(220 22% 12%)` (`.ink-pill`), jaise reference ka “Create new chat”   |
| Accent                   | mint `hsl(155 52% 86%)` — success, active states, links                                  |
| Warm                     | peach `hsl(22 92% 84%)` — warnings, secondary highlights                                 |
| Radius                   | cards 24px (`rounded-3xl`), sidebar/modal 28px, inputs 14px, buttons/badges pill         |
| Type                     | system sans, tight tracking (`-0.022em` on headings)                                     |

Mobile par blur kam (`--blur: 10px`) ho jata hai taake scroll smooth rahe, aur
`prefers-reduced-transparency` par solid backgrounds aa jate hain.

---

## Design badalne ke 3 tareeqe

### 1. Sirf colours (recommended)

`ui/tokens.css` ke `:root` me values badal dein:

```css
--canvas: 220 30% 97%; /* cream → cool grey */
--accent: 210 70% 85%; /* mint → blue */
--ink: 222 47% 20%; /* near-black → navy */
--blur: 24px; /* zyada frosted */
```

Poora product (dashboard, forms, badges, charts axis) khud update ho jata hai — kyunki koi page raw
colour use nahi karta.

### 2. Flat / minimal theme chahiye

`ui/tokens.css` ke `.glass` block me `backdrop-filter` hata dein aur
`--glass-alpha: 1` kar dein. Bas — sab cards solid ho jayenge, layout same rahega.

### 3. Component shape

`ui/primitives.tsx` (cards, buttons, inputs) ya `ui/layout.tsx` (sidebar, topbar, mobile bar) edit karein.

---

## Icons

- Sab icons `ui/icons.tsx` se aate hain, **meaning** ke naam se: `IconApprove`, `IconReject`, `IconPosts`,
  `IconWhatsapp`, `IconSheets`, `IconExternal`…
- Kahin galat icon lage to ek line badalne se har jagah theek ho jata hai:
  ```tsx
  export const IconApprove = Check; // → ShieldCheck chahiye to yahan badlein
  ```
- Koi page/component `lucide-react` directly import nahi kar sakta (`npm run check:ui` rok deta hai).
- Named exports hain (map nahi), is liye har page sirf apne icons ship karta hai.

---

## Nav / page titles

`ui/nav.ts` → `NAV` array. Naya page add karna ho to yahan entry + `app/(dashboard)/<route>/page.tsx`.
Topbar title/subtitle isi array se aata hai.

---

## Naya page likhne ka tareeqa

```tsx
'use client';
import { Button, Card, CardContent, PageHeader, IconAdd } from '@/ui';

export default function Page() {
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Something"
        subtitle="What this page is for"
        actions={
          <Button size="sm">
            <IconAdd className="h-4 w-4" aria-hidden /> New
          </Button>
        }
      />
      <Card>
        <CardContent>…</CardContent>
      </Card>
    </>
  );
}
```

No `<div className="bg-white rounded-lg shadow">` — primitives use karein.

---

## Guardrail: `npm run check:ui`

Ye script (aur `tests/ui-separation.test.ts`) fail karta hai jab:

1. `ui/` ke bahar koi raw colour ho — `bg-slate-100`, `text-indigo-600`, `#fff`, `hsl(...)`, `rgb(...)`
2. `ui/icons.tsx` ke ilawa kahin `lucide-react` import ho
3. `ui/` ke andar se application code import ho

Yani design ka koi hissa chupke se pages me leak nahi kar sakta. Tests me bhi ye checks chalte hain
(`npm test`), is liye CI/`--check` me bhi pakra jayega.

---

## Responsive rules (still enforced)

- 320 px se 1440 px tak **koi horizontal scroll nahi**; har jagah `min-w-0` / `truncate`.
- Touch targets ≥44 px (buttons `h-11`, mobile tab bar 52 px).
- iOS inputs 16 px (base CSS), `env(safe-area-inset-bottom)` bottom bar par.
- Mobile: sidebar hidden, floating bottom glass bar; desktop: 258 px sticky glass sidebar.
- Blur mobile par kam — battery/scroll smoothness ke liye.

## Performance

- First-load JS budget ≤130 kB gzip: ab max 127 kB (settings), shared 103 kB.
- `.glass` = 1 blur layer per surface; nested blur nahi.
- Icons tree-shaken (named exports), chart hand-rolled SVG (koi chart library nahi).

## Troubleshooting

- **`components/ui` / `components/layout` folders khali reh gaye hain** — Windows par folder handle khula
  reh jata hai, is liye phase3 unhe delete nahi kar pata. Test sirf _files_ check karta hai, empty folder se
  koi farq nahi padta. Saaf karna ho to folder delete kar dein, ya `node phase3.mjs` dobara chalayein (ye
  pass har baar chalta hai aur backups ko `.pre-phase3-removed/` me le jata hai).
- **`npm run check:ui` fail** — error line pehle file:line dikhata hai; colour ko `ui/tokens.css` me token
  banayein, icon ko `ui/icons.tsx` me add karein.
- **Design change karna hai** — sirf `ui/tokens.css`; component ka shape `ui/primitives.tsx` / `ui/layout.tsx`.
