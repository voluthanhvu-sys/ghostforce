# GhostForge

GhostForge is a local React/Vite + Express video-processing application with three main workflows: Unique, Edit, and Auto Reframe. The backend coordinates local files, FFmpeg, Python processing, job/SSE progress, and optional Gemini/Vertex/Google STT integrations.

## For AI/coding agents
**Start with `AGENTS.md`. Do not begin by scanning the whole repository.**

Recommended reading order:
1. `AGENTS.md` — rules and minimum workflow.
2. `ARCHITECTURE.md` — high-level architecture.
3. `CODEMAP.md` — routes/symbols/files for fast navigation.
4. Relevant section of `PIPELINES.md` — feature flow.
5. `CURRENT_STATE.md` — current risks/handoff notes.
6. `VALIDATION.md` — safe validation commands/environment caveats.
7. `AI_INTEGRATIONS.md` only for AI/STT/Python/FFmpeg tasks.

## Development
See `DEVELOPMENT.md`. Existing setup/runtime details from the earlier project documentation remain in `README-FIXED.md`.

## Source of truth
Current source code is authoritative. Root-level `.patch` and `investigate-*.txt` files are historical/debug artifacts unless a task explicitly references them. Generated folders such as `dist` are not source of truth.
