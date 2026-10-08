# Development and handoff workflow

## Cheap local commands
- `npm test` — Node unit tests.
- `npm run check:server` — syntax-check backend files.
- `npm run build` — Vite production build (run in an environment with compatible installed dependencies).
- `npm start` — starts through `launch.mjs`.

## Agent workflow
1. Read `AGENTS.md`.
2. Locate the feature in `CODEMAP.md`; read only its pipeline section.
3. Search symbols/routes named there before broad repository search.
4. State the minimum files/functions that need modification.
5. Make the smallest behavior-preserving patch possible.
6. Add/update focused unit coverage when logic can be isolated.
7. Run cheap validation first. Run media/GPU/live-API validation only when necessary.
8. Record a meaningful completed change in `CHANGELOG_AI.md`.

## Repository hygiene
Do not package or inspect generated/heavy folders unless a task requires them: `node_modules`, virtual environments, `uploads`, caches, generated media, and build output. `dist` is generated and is not the source of truth.

Historical root-level `.patch` and `investigate-*.txt` files can be useful for regressions but should not be loaded by default.

## Good task prompt for a coding agent
“Read `AGENTS.md` first. Task: <specific bug/change>. Use `CODEMAP.md` to locate the smallest relevant area. Do not refactor unrelated code, do not run live AI/GPU/full-video tests unless required, preserve API/SSE contracts, run targeted tests plus the cheap checks, and summarize files changed and validation performed.”
