# `ui/` — the design system

The interface is deliberately isolated from the application. Everything visual lives here; **nothing in
this folder imports from `lib/`, `src/` or `components/`**, and nothing here fetches data.

```
ui/
├─ tokens.css     ← the ONLY file with colours, radii, blur, shadows, gradients
├─ theme.ts       ← JS mirror of the palette (SVG charts, gradients)
├─ icons.tsx      ← the only place lucide icons are imported; named by meaning
├─ primitives.tsx ← Card, Button, Input, Badge, Alert, Modal, PageHeader, …
├─ shell/         ← the frame: Shell, sidebar, topbar, drawer, sidebar state (props only)
├─ nav.ts         ← navigation model
├─ index.ts       ← pages barrel: `import { Card, Button, IconApprove } from '@/ui'`
└─ shell.ts       ← shell barrel: `import { Shell, NAV } from '@/ui/shell'`
```

## Shell geometry (Phase 5)

The rail is pinned to the window, full height, and collapsible. Three numbers drive it and all three
live in `ui/tokens.css`:

| Token                   | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `--sidebar-w-expanded`  | 264 px - the rail with labels                                             |
| `--sidebar-w-collapsed` | 72 px - the icon rail (hover tooltip, active bar, badge dot)              |
| `--content-max`         | 1180 px - the reading column. Only the content is capped, never the shell |
| `--tap`                 | 44 px - the minimum touch target                                          |

`<html data-sidebar="expanded|collapsed">` is mirrored by `ui/shell/sidebar-state.ts`, so CSS (not JS)
does the layout swap. The rail is `position: fixed; left: 0` from `lg` up; below `lg` it becomes the
drawer and `--sidebar-w` is `0px`.

## Changing the design

1. **Colours / blur / radius / shadows** → edit `ui/tokens.css`. Every surface reads those variables, so a
   single edit re-skins the whole product (glass → flat, mint → blue, dark mode, …).
2. **Component shape or spacing** → edit `ui/primitives.tsx` (or `ui/shell/` for the frame).
3. **Icons** → edit the named exports in `ui/icons.tsx`. Icons are addressed by meaning
   (`IconApprove`, `IconPosts`, `IconWhatsapp`), so every screen that renders that meaning updates
   together. Named exports (never a map) keep the bundle tree-shaken.
4. **Navigation / page titles** → `ui/nav.ts`.

## Rules (enforced by `npm run check:ui`)

- No raw colour utilities (`bg-slate-100`, `text-indigo-600`, `#fff`, `hsl(…)`) outside `ui/tokens.css`
  and `ui/theme.ts`.
- No direct `lucide-react` import outside `ui/icons.tsx`.
- `ui/` may import only `react`, `next/link`, `lucide-react`, `clsx`, `tailwind-merge`.

`npm run check:ui` fails the build if any of those slips in, which is what keeps the design replaceable.
