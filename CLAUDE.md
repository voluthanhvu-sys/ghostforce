# CLAUDE.md

The agent instructions for this repository live in `AGENTS.md`. Read it first — it is
the canonical entry point and it defines the read order, the change rules, and the
mandatory validation/handoff steps.

Then follow the read order `AGENTS.md` itself specifies: `ARCHITECTURE.md` and
`CODEMAP.md`, then only the relevant section of `PIPELINES.md`, then `CURRENT_STATE.md`,
then `VALIDATION.md` before running commands. Read `AI_INTEGRATIONS.md` only when the
task touches AI/STT/Python/FFmpeg integration.

Keep this file a pointer. Do not copy instructions here: duplicated rules drift apart,
and `AGENTS.md` is the single copy every other agent in this project already reads.
