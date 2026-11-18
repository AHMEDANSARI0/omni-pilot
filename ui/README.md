# `ui/` — the design system

The interface is deliberately isolated from the application. Everything visual lives here; **nothing in
this folder imports from `lib/`, `src/` or `components/`**, and nothing here fetches data.

```
ui/
├─ tokens.css     ← the ONLY file with colours, radii, blur, shadows, gradients
├─ theme.ts       ← JS mirror of the palette (SVG charts, gradients)
├─ icons.tsx      ← the only place lucide icons are imported; named by meaning
├─ primitives.tsx ← Card, Button, Input, Badge, Alert, Modal, PageHeader, …
├─ layout.tsx     ← Shell, sidebar, topbar, mobile tab bar (props only)
├─ nav.ts         ← navigation model
└─ index.ts       ← single barrel: `import { Card, Icons, Shell } from '@/ui'`
```

## Changing the design

1. **Colours / blur / radius / shadows** → edit `ui/tokens.css`. Every surface reads those variables, so a
   single edit re-skins the whole product (glass → flat, mint → blue, dark mode, …).
2. **Component shape or spacing** → edit `ui/primitives.tsx` (or `ui/layout.tsx` for the frame).
3. **Icons** → edit the map in `ui/icons.tsx`. Icons are addressed by meaning (`Icons.approve`,
   `Icons.posts`, `Icons.whatsapp`), so every screen that renders that meaning updates together.
4. **Navigation / page titles** → `ui/nav.ts`.

## Rules (enforced by `npm run check:ui`)

- No raw colour utilities (`bg-slate-100`, `text-indigo-600`, `#fff`, `hsl(…)`) outside `ui/tokens.css`
  and `ui/theme.ts`.
- No direct `lucide-react` import outside `ui/icons.tsx`.
- `ui/` may import only `react`, `next/link`, `lucide-react`, `clsx`, `tailwind-merge`.

`npm run check:ui` fails the build if any of those slips in, which is what keeps the design replaceable.
