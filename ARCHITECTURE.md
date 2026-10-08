# GhostForge architecture map

GhostForge is a local React/Vite UI plus an Express backend. The backend owns filesystem access, FFmpeg work, job lifecycle, AI planning/reframe calls, and export/download endpoints.

## Fast navigation
| Area | Start here | Then inspect |
|---|---|---|
| Job cancel / SSE / reconnect | `server/jobs.js` | relevant stream route in `ghostforge-server.js` |
| Saved output folder | `server/save-dir.js` | `/api/save-dir`, folder routes. `server/export-copy.js` decides whether `/api/export-copy` skips a file that is already in the folder. `groupFolder` adds one subfolder named from the source video. A missing in-memory job can still copy `uploads/<id>_output.mp4` for a 16- or 32-hex id |
| Unique unsaved renders | `server/unique-hold.js` | `uploads/unique-hold.json`. A finished Unique job is recorded before `done`. Restart reloads that list so Save still works. Save and Remove drop the record |
| Unsaved Edit parts | `server/edit-hold.js` | `uploads/edit-hold.json`. Each finished part is recorded before `part-done`. Restart puts those parts back on the cut list. Save and Clear drop that part. Reframe is not included |
| Generic subprocess execution | `server/process.js` | caller in `ghostforge-server.js`; YouTube import passes stream hooks and `killTree`. Unique pause uses `planUniquePause` and `setProcessSuspended` (`POST /api/unique/pause/:jobId`) |
| YouTube import (source file only) | `server/youtube-import.js`, `server/youtube-channel.js`, `server/youtube-channels.js`, `server/youtube-receipts.js` | Own tab in `src/components/YoutubeImportBox.tsx` and `YoutubeChannelPanel.tsx`. The panel keeps a session queue and downloads one video at a time. A channel scan does not take that slot. The ledger is `uploads/youtube-channels.json`. The download list is `uploads/youtube-receipts.json`: an unsaved row stays, a saved row leaves the list after 7 days, and the list on screen shows only the selected channel. A second save of the same video on that channel updates the row and counts redownloads. A saved row includes the folder of that mp4. Official yt-dlp binary in `.youtube-bin/` when the tool is missing. Copies the original mp4 into the shared folder, or into that channel's own folder when one is set. A pasted video link can move that tab's anchor; an already saved id asks first and is not downloaded by that action. After an anchor exists, the count walks older or newer from that video. Unique, Edit, or Reframe is optional and starts immediately when that tab is idle. Does not change those filters. Ghép joins mp4s already saved for the selected tab. The joined file goes to the channel folder when one is set, and to the shared folder when it is not. Unique or Edit then starts on its own. A missing Unique preset starts the open panel. Tải lại on a receipt downloads that video again as save-only and skips the date question. `POST /api/youtube-import/hold` copies it first so Unique can delete the copy. The anchor, a receipt row, and “mở” open the watch URL. `server/youtube-concat.js` is the pure concat helper. |
| Edit plan parsing / segment normalization | `server/editor-plan.js` | edit AI generation in `ghostforge-server.js` |
| Edit 9:16 framing graph (default `focus` path) | `server/ffmpeg-expressions.js` (`focusFrameGraph`) | `composeFocusClip` in `ghostforge-server.js`; SML keeps `mixFrameClip` |
| Gemini Detail daily request quota | `server/gemini-detail-quota.js` | `geminiDetailAcrossModels` in `ghostforge-server.js` |
| Global automatic content coverage | `server/edit-content-coverage.js` | pre-Detail reconciliation in `ghostforge-server.js`; no manual review routes |
| Edit timing / diagnostic summary | `server/edit-run-report.js` | Edit stream; per-video UI timers and session log export in `src/ghostforge-app.tsx` / `src/components/LogViewer.tsx` |
| Experimental Local Detail TEST | `server/local-detail.js` | existing Edit TEST controls and stream in `ghostforge-server.js`; private `.local-ai/` Ollama runtime/model |
| Unique/video processing | `ghostforge-server.js` | `/api/upload`, `/api/stream/:jobId`. Optional Smooth and word captions are `server/unique-extra.js` plus `caption_words.py`. Each switch skips its own step |
| Unique measurement + quality guard (shared) | `server/perceptual-hash.js` | called from the Unique handler and imported by `src/ghostforge-app.tsx`; pure functions only, no fs/ffmpeg/job access |
| Edit API / cutting | `ghostforge-server.js` | `/api/edit/*`, `cutEditClip` |
| Auto Reframe | `ghostforge-server.js` | `/api/reframe/*`, reframe helpers near end of file |
| PGD/OpenCLIP | `pgd_clip.py`, `pgd_server.py` | `runPgdClip` in backend. One PGD or CLIP measurement uses the GPU at a time (`withGpuExclusive`). The server process keeps ViT-B-32 loaded. The attack writes the pool-4 residual it trained on. Decode and encode still overlap that pass |
| Unique audio measurement (shared) | `server/audio-profile.js` | PCM samples in, loudness/three-band drift out; pure functions only, no fs/ffmpeg/job access |
| TikTok trend finder | `server/tiktok-trends.js` | `/api/trends*` routes in `ghostforge-server.js`; `src/components/TrendsPanel.tsx` |
| Optional direct TikTokApi lookup | `server/tiktok-hashtag-search.js` | Python `tiktok_hashtag_search.py`; `/api/videos/hashtag`; independent of Trends panel |
| Frontend log UI | `src/components/LogViewer.tsx` | one panel per function in `src/ghostforge-app.tsx`; `src/lib/log-channels.js` routes the line |
| Frontend formatting | `src/lib/format.ts` | main app |
| Frontend filenames | `src/lib/files.ts` | main app |
| Named Unique presets | `src/lib/unique-presets.js` | browser snapshot of the Unique switches; Sửa overwrites the same id; no seed, no filesystem |
| Browser save-folder handle | `src/lib/directory-store.ts` | main app |
| Frontend state/screens | `src/ghostforge-app.tsx` | extracted helpers/components first |

## Runtime flow
Browser UI -> Express API -> in-memory job -> FFmpeg / Python / Gemini or Vertex -> SSE progress -> browser -> local export/download.

## Refactor boundary
This pass intentionally extracts low-risk, reusable units while leaving tightly coupled FFmpeg, edit execution, AI transport and reframe orchestration in `ghostforge-server.js`. Splitting those further should be done feature-by-feature with regression coverage, not as a blind file-size refactor.
