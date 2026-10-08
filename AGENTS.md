# GhostForge agent guide

This file is the mandatory entry point for a fresh AI/coding session.

## Read order — minimize context/quota
1. Read this file.
2. Read `ARCHITECTURE.md` and `CODEMAP.md`.
3. Read only the relevant section of `PIPELINES.md`.
4. Read `CURRENT_STATE.md` for handoff/risk context.
5. Read `VALIDATION.md` before running commands.
6. Read `AI_INTEGRATIONS.md` only if the task touches AI/STT/Python/FFmpeg integration.
7. Search the exact route/symbols named in `CODEMAP.md`; do **not** scan the whole repository by default.

## Repository map
- `ghostforge-server.js`: Express routes and remaining media/AI orchestration.
- `server/jobs.js`: shared job registry, cancellation and SSE subscriber/history lifecycle.
- `server/process.js`: generic child-process execution.
- `server/save-dir.js`: persisted output-folder preference.
- `server/editor-plan.js`: pure edit-plan/framing/speaker parsing and normalization.
- `server/local-listen-map.js`: diarization/speaker evidence mapping.
- `server/google-stt-retry.js`: STT retry/chunk helper.
- `server/ffmpeg-diagnostics.js`, `server/ffmpeg-expressions.js`: FFmpeg helpers.
- `src/ghostforge-app.tsx`: main React application state and screens.
- `src/components/`, `src/lib/`, `src/types.ts`: extracted frontend units.
- `local_listen_diarize.py`: local diarization.
- `pgd_clip.py`: PGD/OpenCLIP/PyTorch processing.
- `tests/`: cheap Node unit tests for extracted/shared logic.

## Change rules
- Identify the minimum functions/files involved before editing.
- Make the smallest patch that solves the requested task; do not refactor unrelated working code.
- Preserve existing HTTP paths, response shapes and SSE event shapes unless explicitly changing the API.
- Preserve SSE reconnect/history and cancellation semantics.
- Do not change FFmpeg filters/encoder selection during unrelated cleanup.
- Do not change Gemini/Vertex prompts, model behavior, STT/diarization behavior or quota scheduling unless explicitly requested.
- Prefer editing/testing an extracted module when the task maps to one.
- Current source code wins over old `.patch`/`investigate-*.txt` artifacts.
- Do not scan/edit `node_modules`, `.venv*`, `dist`, `uploads`, generated media, caches, or model weights unless explicitly required.
- Do not run expensive video/GPU/live API tests unless the task requires them. Never spend AI API quota merely to “validate” unrelated code.
- Stop once targeted validation passes; do not expand scope opportunistically.

## Framing fixes — one class, later videos, do not loosen a shared gate

A crop miss on one rendered part is not a reason to retune a threshold other videos already rely on. Fix that class of shot, or leave the part. The aim is that the next video of the same kind is right without another code change. A fix that makes the next video wrong is a failed fix.

Do this:
- Name the class (a still title card, a phone with one edge covered, the tail after the plan, a dark board with two objects). It has to show up more than once, or the new condition has to be one that cannot fire on shots the current rules already get right: a seated host, a fish close-up, a laptop, a gavel, a two-person desk.
- Add the narrowest new condition. Keep the old threshold for the old case. The covered-phone edge runs only when the strict pair found nothing. The still-card recenter runs only after a cut into a still frame with no face, person, panel, or side pair.
- Before calling it done, re-check the shots the old rule already framed. A later part that fails in a different way is a new class. It is not proof that the last rule broke.

Do not do this:
- Lower a shared number to catch one timestamp. That includes the two-face split gap 0.35, the panel score 100, `splitZoom` 0.6, the split-similarity gate 0.85, and the face-sharpness gates.
- Hard-code a time or a video name.
- Letterbox a person lying across the frame, drop the torso fallback, or pad a person half the way a phone panel is padded.
- Treat a QA score of 100 as proof the picture is right, or treat a new miss as proof the previous rule failed.
- Re-fix the same class on the next video. If the new picture is a different kind, write that down and stop, unless a second narrow condition has been measured.

The 134 s Law By Mike part is the pattern to copy. The tail face, the covered phone, and the centred Paqui card each got their own condition. Host close-ups, phone ads, the fish, the laptop, the gavel, and the two-person desk stayed. Part 1 of "I Tried Illegal Foods" (68 s, Denmark Buldak, 2026-10-04) was not one patch. The cut-off second card, two people who lean between samples, two bowls, and a light-page diagram each got their own condition. A close-up with one face and two body boxes stays one crop; body boxes count as two people only when the frame has no face. The 0.2 drift still applies to two faces. Three people spread across the frame stay one centred crop. Part 2 of the same source (66 s, Kinder Surprise, source 275–341 s, retested 2026-10-04) added three classes. One real face beside a wide dark board on a bright page is a side pair aimed at the face and the board. A wide product card beside one person that lasts just under a second still splits when the next sample is the cut, and the same close-up one sample earlier starts that split. Two body boxes whose tops sit in the top fifth are arms on a table and are their own split, separate from the seated pair, and a face drawn on a hand does not extend that pair. Exactly two real faces at least 0.30 apart open their own split, so a 9:16 half of a 16:9 frame keeps each face. A face pair at least 0.29 apart only continues a split that already opened, and only when each face has barely moved. Body boxes still need 0.35. A gap of about 0.285, three faces, and a scoreboard with extra speck faces stay one crop. The shared 0.35 gap is not lowered. Those two splits, and two round objects, skip the 0.85 look-alike drop. Phones and side pairs do not. A face narrower than 0.06 does not keep a model split. Do not loosen side-pair, face aim, or the 0.35 gap to sweep a new miss up.

## Validation expectation
Backend/helper changes: run `npm test` and `npm run check:server`.
Frontend changes: also run `npm run build` on a dependency-compatible installation. See `VALIDATION.md` for the Windows/Linux package caveat.

## Handoff after changes
Summarize: files changed, behavior changed, validation run, and any unresolved risk. Add a concise dated entry to `CHANGELOG_AI.md` for meaningful changes. Update architecture/codemap/pipeline docs only when the code structure or contract actually changed.

## Repository continuity contract
This repository must remain understandable and safely maintainable by a fresh AI/coding session that has **no access to previous chat history**.

### Source-of-truth hierarchy
When sources disagree, use this order:
1. Current executable source and tests (`.js`, `.tsx`, `.py`, current config).
2. Current handoff documentation (`AGENTS.md`, `CURRENT_STATE.md`, `CODEMAP.md`, `ARCHITECTURE.md`, `PIPELINES.md`, `AI_INTEGRATIONS.md`, `VALIDATION.md`).
3. `CHANGELOG_AI.md` for the reason/history behind prior decisions.
4. Old `.patch`, `investigate-*.txt`, generated output and other historical/debug artifacts.

Never rely on chat history as project documentation. If a decision, invariant, known risk, unfinished migration, or operational requirement is necessary for the next maintainer, record it in the repository before considering the task complete.

### Documentation impact check — mandatory after every code patch
After changing code, explicitly decide whether each handoff document is affected. Update only documents whose facts changed; do not create documentation churn.
- `CODEMAP.md`: file/module/route/symbol ownership or navigation changed.
- `ARCHITECTURE.md`: boundaries, responsibilities, dependencies, or runtime architecture changed.
- `PIPELINES.md`: processing order, fallback, timing, framing, rendering, or job flow changed.
- `AI_INTEGRATIONS.md`: provider/model/prompt/API/STT/diarization/retry/quota behavior changed.
- `CURRENT_STATE.md`: active risk, incomplete work, current focus, or stable architectural state changed.
- `VALIDATION.md`: validation commands, environment requirements, fixtures, or smoke-test expectations changed.
- `CHANGELOG_AI.md`: add a concise dated entry for every meaningful code or handoff-system change.

A patch is not complete until this documentation impact check and the relevant validation have been performed.

### Patch handoff record
For meaningful changes, the `CHANGELOG_AI.md` entry should capture enough context to prevent regression without requiring old chats:
- problem/goal;
- behavior or decision changed;
- main files changed;
- validation performed;
- remaining limitation/risk, when relevant.

Do not use the changelog as a substitute for current-state documentation: current facts belong in the current docs; the changelog explains why/how they changed.

### Automated handoff guard
Run `npm run validate:handoff` after documentation/structure changes. For normal backend/helper patches, prefer `npm run validate`, which runs handoff validation, unit tests, and server syntax checks. This validator is a drift guard, not proof that every prose statement is semantically correct; maintainers must still perform the documentation impact check above.
