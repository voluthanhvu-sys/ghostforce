# Refactor notes

This refactor is deliberately behavior-preserving and quota-oriented. It extracts code that future agents can reason about independently without forcing a risky rewrite of the FFmpeg/AI pipelines.

Extracted backend modules: job/SSE lifecycle, process runner, saved-directory persistence, and pure editor-plan parsing/normalization. Extracted frontend modules: shared types, formatting helpers, filename helpers, browser directory persistence, and LogViewer.

Added `AGENTS.md`, `ARCHITECTURE.md`, `VALIDATION.md`, `.gitignore`, and basic Node tests. The remaining large backend/frontend files are documented so future work can be targeted. Further decomposition should follow actual feature work and add tests around each boundary before moving code.
