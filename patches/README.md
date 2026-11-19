# Patch files (`phaseN.mjs`)

From now on every change to this project is delivered as a single self-applying Node script instead of a git
push. Workflow:

```bash
# put phaseN.mjs in the project root (next to package.json)
node phase1.mjs
```

The script prints every file it touched and fails loudly (exit code 1) if something does not match, so a
half-applied upgrade is never silently reported as success.

## Rules each phase file follows

- **Idempotent** — running it twice does nothing the second time (`already applied` message, exit 0).
- **Path-anchored** — resolves files relative to its own location, so it works from any `cwd`.
- **Backup first** — writes `*.pre-phaseN.bak` next to each file it modifies.
- **Verified** — after patching it re-reads each file and asserts the new content is present.
- **No silent skips** — if an anchor string is missing, it stops with the file name, the expected snippet and a
  short hint, instead of ignoring the file.
- **Chained checks** — optional flags:

  ```bash
  node phase2.mjs --dry-run   # show what would change, touch nothing
  node phase2.mjs --check     # run typecheck + tests at the end
  ```

## Order matters once

`phase1` → `phase1b` → `phase2` → `phase3` → `phase4` → `phase5` → `phase6` → `phase7` → `phase8`. Each
phase assumes the previous one is applied (`phase8.mjs` assumes Phase 7).

`phase8.mjs` also **removes** one path (`tests/api.test.ts`, split into `tests/api/*`). It only deletes the
file when it is byte-identical to the Phase 7 version; an edited copy is refused like any other
unrecognised state.

`phase8.mjs` does **not** overwrite `package.json`. It merges two scripts (`db:contract`, `db:local`) into
the existing `"scripts"` block, keeps every other key and the file's key order, and proves the result
parses before writing. That is why a `package.json` touched by phase1-3 (or by hand) cannot block it —
and an existing `db:local`/`db:contract` with a *different* command is reported instead of replaced.

## Applying a phase safely

```bash
git status --short           # make sure your tree is clean (optional but recommended)
node phase3.mjs --dry-run    # inspect
node phase3.mjs              # apply
npm run typecheck && npm test
```

If anything goes wrong, restore the `.bak` files the script left behind (or `git checkout -- .`).

## Phase log

| File          | Summary                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase8.mjs`  | Deploy-ready database: migrations 0001-0004 (12 tables, 8 RPCs, RLS, grants), Docker stack + contract check (`npm run db:contract`, 32 assertions), queue "Add anyway" fix, api/route file splits. |
| `phase1.mjs`  | Professional portal redesign (sidebar + topbar, mobile bottom nav, dashboard cards, charts).                                                                              |
| `phase1b.mjs` | Smoothness polish: optimistic approve/reject, silent refresh (`lib/hooks.ts`), `npm run doctor`.                                                                          |
| `phase2.mjs`  | WhatsApp approvals via the official Cloud API (wa.me code link, signed webhook, free service window).                                                                     |
| `phase3.mjs`  | UI layer split into `ui/` (tokens, primitives, icon registry) + glassmorphism + `npm run check:ui`.                                                                       |
| `phase4.mjs`  | Three draft options per run (one AI request), `post_variants` + `0004` migration, compare-and-pick on `/posts`, prune after 24 h.                                         |
| `phase7.mjs`  | **Current.** Duplicate protection (`src/core/duplicate.ts`, 409 on manual entry), hook library (`GET /content/hooks`, `/hooks` page), prompt carries what actually worked. |
| `phase6.mjs`  | (`bdeba2450`, 37 files). Calendar page + `GET /calendar`, "Suggest next week" (AI → review → accept), activity chart with failed series + approval-lag median, `tests/activity.test.ts`. |
| `phase5.mjs`  | Pinned + collapsible sidebar (264 ↔ 72 px), mobile drawer, shell split into `ui/shell/`, 320–1920 px responsive sweep, repo cleanup. No AI/dev-only changes. |
| next          | Phase 6 — calendar + charts + AI topic suggestions (`docs/ROADMAP.md`).                                                                                                   |

**No `.bak` files.** From `phase6.mjs` onward a patch keeps no `*.pre-phaseN.bak` copies: every write is
verified by sha256 instead (mismatch = exit 1), and `git diff`/`git checkout` is the rollback. Older scripts
still write them, which is why `.gitignore` keeps the pattern.

**Safe to re-run.** `phase6.mjs` compares every path it touches against the states it is allowed to start
from (the committed copy, the Phase 5 output, or "absent"), so:

| What it finds | What it does |
| --- | --- |
| a known start state | applies |
| Phase 6 content | skips - "already current" |
| anything else (your edit, a deleted file, a different patch) | **refuses the whole patch**, lists the paths, writes nothing, exit 1 |

It plans first, then writes, so a refusal can never leave the tree half-patched. Line endings are ignored
when comparing (a Windows CRLF checkout is the same version; the LF bytes are written) and
`scripts/check-ui.mjs` is rewritten with LF because Node's ESM loader rejects a CRLF shebang.

`--check` runs the tools through **Node itself** (`node node_modules/typescript/bin/tsc`,
`node node_modules/vitest/vitest.mjs run`), never through `npx` — on Windows `spawnSync('npx.cmd')`
throws `EINVAL` without `shell: true`. If `node_modules` is missing it says so and exits 1 instead of
crashing with a stack trace.

```bash
node phase6.mjs --version    # prints the build fingerprint, e.g. phase6 bdeba2450 · 37 files
node phase6.mjs --dry-run    # lists what would happen, writes nothing
node phase6.mjs              # apply
node phase6.mjs --check      # apply, then typecheck + ui guard + tests
```
