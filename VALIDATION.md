# Validation

## Post-compress clock and warm PGD (2026-10-01)

`server/harsh-scale.js` is covered by `tests/harsh-scale.test.js`. A live check is a short Unique job: the log must contain `[SYS] Sau nén (crf 30, cạnh dài ≤720)` and `done.stats` must include numeric `harshDistance`, `harshPHash` and `harshClipSim`. `uploads/<jobId>_harsh.mp4` must not remain. A 320x180 source stays 320x180. A 1280x720 source becomes 720x406.

PGD light must log `long-wave pool-4` and `wave pool4`. Two PGD jobs in one server run: the second logs `[PGD] nóng: dùng model đã nạp` and does not log `Loading CLIP` again. Reference on a 1280x720 2 s 15 fps test pattern, CPU encode, RTX 3050: first PGD-only stage 7.7 s, second 2.2 s. Harsh CLIP 0.9593 against file CLIP 0.9568.

Real-clip reference, 2026-10-01, 8 s from 15 s of `D:\Tiktok\family security\1.Goodman Quits The News!.mp4` (1080x1920), CPU, rotate off, adversarial on. Unique strong: harsh CLIP 0.8740, dHash 41.5%, pHash 28.6%, total 7.9 s. The same excerpt plus PGD light: harsh CLIP 0.8456, dHash 38.9%, pHash 21.2%, PGD 18.8 s, total 26.4 s. The grade is redrawn per job, so repeat the pair before treating a gap under about 0.03 CLIP as the PGD effect.

PGD-only on that excerpt, 2026-10-01: medium harsh CLIP 0.8772 / dHash 5.2% / pHash 1.6% / 15.8 s; strong harsh CLIP 0.8513 / dHash 7.3% / pHash 2.6% / 15.5 s. A harsh dHash under about 10% with no Unique pass means the picture still reads as the source.

Tempo curve inside Unique: `tests/tempo-curve.test.js`. Strong shape 1.15, 1.15, 1.12, 0.90, 0.88, 0.87, 1.00, 1.00. Curve-only FFmpeg on the 8 s excerpt: video 8.041 s, audio 8.006 s. A full Unique encode must log `curve` and keep the output streams within about one frame. The earlier outside-the-app check still stands: the frame at source 2.5 s sat near 2.20 s after the crf 30 proxy.

## Cheap checks
```bash
npm test
npm run check:server
```

`tests/unique-hold.test.js` covers the Unique unsaved-render list: a finished mp4 is remembered, a missing file is dropped, a path-like id is rejected, and rehydrate restores download state without replacing a live job or encoding again. No ffmpeg run is required for that check.

`tests/unique-presets.test.js` covers named Unique presets: the popup lines, a rejected duplicate name, an overwrite that keeps the same id, a rename onto another preset's name that is refused, and a PGD-only flag that cannot stay on when PGD is off. It does not start a job.
`tests/unique-extra.test.js` covers Smooth: a full HD frame stays at its size on the fast filter, AI or a smaller frame still uses the model (1080 long side 2×, smaller 3×), the Làm mịn percent moves with frames written, a YouTube handoff line names the preset chosen on that tab, the caption clock, and caption place (middle stays centred, bottom inset by 10%, a top value becomes middle). The Brazil word lists, when present under the local Temp folder, must change only `lindês` → `lindeza` and must keep every whisper time. This test must not call whisper, Google, or the ncnn model.

`tests/tempo-curve.test.js` checks that a 400 s tempo chain exceeds the Windows command budget and that `chunkTempoBranches` keeps every original atempo branch under that budget. `tests/jobs.test.js` checks `planUniquePause` without suspending a process.

`tests/edit-hold.test.js` covers the Edit unsaved-part list the same way: a finished mp4 is remembered, a missing file is dropped, a path-like id is rejected, rehydrate restores the cut without replacing a live job, and the list keeps the newest parts when it is over the cap. No ffmpeg run is required.

`npm run check:server` expands the module list in `scripts/check-server.mjs` (entry point plus every `server/*.js`) instead of relying on a shell glob, so it also works on Windows, where the npm shell (cmd.exe) does not expand globs. `npm run validate` is expected to be green: handoff check, unit tests, then this syntax check.

`tests/youtube-url.test.js`, `tests/youtube-import.test.js`, `tests/youtube-channel.test.js`, `tests/youtube-receipts.test.js`, and `tests/youtube-concat.test.js` are offline. The concat test checks newest-first local numbers, the `Ghep 2-1.mp4` name, a copy that leaves the originals, a re-encode after a failed copy, a hold copy whose delete leaves the saved file, a channel preset that wins over the chain, and a line that names a channel preset separately from a chain preset. It does not call yt-dlp. The receipt test checks that a saved row older than 7 days drops, an unsaved row stays, a saved row includes the folder of its mp4, a second save of the same video stays on one row and counts the repeat, a hold file inside the import root can be copied, and a known id returns its ledger date without calling yt-dlp. They use a fake `runProcess` and a localhost HTTP guard. The missing-yt-dlp test injects `ensureYtDlp` and must not download the release. The save test copies a fake import mp4 into a temp folder, rejects a destination inside the import directory, ignores a client filename, and removes the import directory only when `removeSource` is set. `npm test` must not call yt-dlp, open YouTube, or download a video. A real download is a manual smoke test: open the YouTube tab, let a missing yt-dlp install into `.youtube-bin/`, choose a save folder, add two videos to the download queue and confirm the second waits while the first runs, confirm each finished row shows a poster thumbnail, confirm the first mp4 is in the chosen folder, send one video to the Edit queue and see a `from disk` log, confirm the import directory is still present so Test lại can open it, then the same kind of file into Reframe and Unique is deleted after success while the folder copy remains, Unique logs `Unique from disk` rather than `Uploading`, a playlist URL is rejected, cancel skips the current video and the next queued URL starts, leaving the tab does not stop the queue, and a second POST returns 409 while one download is running. CI does not install or run yt-dlp.

## Local Unique smoke (no AI/GPU quota)

The Unique pipeline can be exercised end to end without Gemini/Vertex. Build a synthetic clip, then drive `POST /api/upload` plus `GET /api/stream/:jobId` and read the SSE `done` stats:

```bash
ffmpeg -y -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" -f lavfi -i "sine=frequency=440:duration=4" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest tmp/unique-smoke-input.mp4
```

Keep PGD and the adversarial layer off so no GPU or API work runs. Expect one `[SYS] Perceptual dHash 256-bit` log line that also carries the pHash and the worst 4x4 block, `perceptualFrames` 3, and `DELETE /api/job/:jobId` leaving no `<jobId>*` file in `uploads/`. A canvas/pad change should raise the reported distance (measured: 5.1% bit / 4.9% luma default vs 44.1% / 35.9% with TikTok canvas on a 640x360 test pattern).

Measured reference for the added numbers, `strong` on the synthetic 640x360/4s test pattern (2026-09-25): dHash 29.3% mean / 32.0% worst, pHash 5.3% / 6.3%, block mean 37.9% / worst cell 47.9%, luma 8.3%. Read them together, not as one score: a 5-13% zoom moves the local grid (block ~38-48%) while leaving the coarse layout nearly unchanged (pHash ~5%), and that combination is what the panel's two new rows are for. The pHash number is expected to be much lower than the dHash one - it only sees structure coarser than about 1/8 of the frame.

The run also log-lines the edge check and returns `seamIn` / `seamOut` / `seamFrames`. Two references measured 2026-09-26 on 10s excerpts, both `strong`:

- a clean 9:16 selfie clip: `seamIn` and `seamOut` both null over 5 frames, panel says `KHÔNG CÓ VẠCH`;
- an Edit contain/fill clip whose picture-layer edge is hard: `seamIn` 59.1 at y=65.8% in 5/5 frames and `seamOut` 78.4 at y=69.0%, panel says `FILE VÀO ĐÃ CÓ VẠCH` - the zoom shifts the boundary outward by the expected amount (0.5+(0.658-0.5)*1.13 = 67.9%).

`seamVerdict` returns `added` (and the log prints `QUALITY WARNING`) only when the output has a seam the input did not. That branch has not yet been produced by a genuine pipeline regression, but the whole chain is verified on real pixel data: burning a flat overlay band (`drawbox y=700 h=260`) into the clean clip makes the profile jump from `visible=false` (spike 0) to `visible=true` at y=36.5% with spikeStep 29.4 and spike ratio 6.9, and `seamVerdict` then returns `added` for (clean, seamed), `source` for (seamed, seamed) and `none` for (clean, clean). The detected row matches the injected band exactly (700/1920 = 36.5%). A steep but continuous edge is deliberately NOT a seam: the selfie clip ramps 10/13/11 luma per row for three rows at the top of the frame, which a plain threshold flags and the 3x spike ratio does not.

The perceptual pass now grabs two frames per side per moment (17x16 and 64x64) instead of one, so the measurement costs four ffmpeg spawns per sampled moment. It stays local: no GPU, no AI call, no quota.

To compare strengths, send `uniqueStrength` (`light` / `standard` / `strong`) in the upload form. On real 1080x1920 footage a `standard` pass reported 22.3% bit / 8.4% luma and a `strong` pass 38.3% / 13.6%; with Content-Aware on, the same file moved from 10.0% to 21.9% after the whole frame received the grade and the global reframe. Expect the FFmpeg log to show `dup=` or `drop=` counters because the tempo retime keeps the output CFR.

`uniqueStrength` also accepts `extreme` (measured on the same file: bit 39.5% / luma 19.0% versus `strong` 38.7% / 14.7%; the 256-bit dHash saturates near 40%).

For a source with blurred bars above and below the picture, send `featherTop` and `featherBottom` as percents of the frame height (both must be > 0). On the user's `1-1.mp4` the bars are 11% and 22%, which maps to rows y=210 and y=1498; the run logs `Blur-bar seam: entered bars ...` and the blend lands on exactly those rows. There is no auto-detect any more: with the switch on but both percents at 0 the run logs `Blur-bar seam ON but no percents entered - nothing done.`

## Unique audio measurement

The same Unique smoke job now also log-lines `[SYS] Audio đo được` and returns the audio numbers in the `done` stats, with no GPU/API use:

`audioMeasuredSec`, `audioSrcRmsDb`, `audioOutRmsDb`, `audioLevelDeltaDb`, `audioLevelDriftDb`, `audioBandLowDb` / `audioBandMidDb` / `audioBandHighDb` (mean change per band, dB), `audioBandDriftDb` (largest per-second movement in any band) and `audioClickRatio`.

Read it as: `*Db` = the fixed level/EQ change this pass applied; `*DriftDb` = how much that change moves from second to second. Measured noise floor on a 15 s real clip: the same file compared with itself gives ±0.00 dB, and a plain AAC re-encode gives -0.02 dB level with ±0.04 dB/s level drift and ±0.17 dB band drift (loudest sample jump ×1.02). Treat anything under ~0.5 dB as noise.

Reference readings on that clip (1080x1920, `strong`, CPU, no canvas change):

- static EQ + compressor chain only: level -3.61 dB, level drift ±1.61 dB/s, band drift ±1.63 dB, click ×0.75;
- the same chain plus the drifting EQ: level -3.65 dB, level drift ±2.34 dB/s, band drift ±2.56 dB, click ×0.93;
- a real Unique render of the same file: `audioSrcRmsDb` -15.93, `audioOutRmsDb` -20.01, `audioLevelDeltaDb` -3.79, `audioLevelDriftDb` 2.11, `audioBandDriftDb` 2.13, `audioClickRatio` 0.69;
- crossover only, every band at gain 1: -0.14 dB level, ±0.11 dB/s drift - the split itself is neutral;
- compressor only (`acompressor=threshold=0.12:ratio=2.4`): -3.83 dB level, ±1.47 dB/s drift. This is where the loudness drop of a Unique pass comes from; the EQ without it measured -0.00 dB / ±0.35 dB/s.

The A/B listening pair (same video, same static chain, only the drifting EQ differs) is `tmp/audio-e2e/eq-A-tinh.mp4` and `tmp/audio-e2e/eq-B-troi.mp4`; the harness that renders and measures them is `tmp/audio-e2e/run-audio-demo.mjs`. They are throwaway verification artifacts, not app code.

The same three measurements also run for a PGD-only job (`enablePgdOnly=true`): `measureUniqueOutput` and `uniqueMeasurementStats` in `ghostforge-server.js` are shared by both paths, with `speed` 1 for PGD-only. Reference run (4 s 1080x1920 clip, `pgdLevel=light`, CPU encode, RTX 3050 Laptop; PGD needs `python` with torch + open_clip + CUDA, see `CURRENT_STATE.md`): `[PGD] done · 120 frames · mean CLIP 0.9133 · EOT 4 (target 0.965)`, then `perceptualDistance` 0.0456 / `perceptualPHash` 0.0053 / `perceptualBlockWorst` 0.3208, `seamFrames` 5 with a seam only where the source had one, and `audioLevelDeltaDb` 0.00 / `audioBandDriftDb` 0.00 because PGD-only copies the source audio untouched. The picture staying close to the source (dHash 4.6%) is the intended PGD-only behaviour, not a measurement failure.

PGD write-out encoder check: run the same PGD-only job twice on one short clip, changing only `encoderMode` (`cpu` vs `nvidia`/`auto`). Expect `[SYS] PGD encode: CPU libx264 veryfast crf 16` and `[SYS] PGD encode: NVIDIA NVENC p5 constqp 18 (GPU)`, the same `[PGD] done ... mean CLIP` figure, and roughly the same output size - the PGD file size is set by the frame-varying perturbation, not by the encoder. Reference (4 s, 1080x1920, `pgdLevel=light`, RTX 3050): 22.3 s / 6.25 MB with x264 crf16 versus 22.2 s / 6.35 MB with NVENC qp18, both 0.9119 mean cosine between the decoded output and the source (`tmp/pgd-sim-check.py` decodes 12 frames per file and embeds them with CLIP ViT-B-32). NVENC qp21/qp24 stay at 6.21/6.25 MB; only a much lower quality (x264 crf28 over the finished file) drops to 1.49 MB, and the attack weakens to 0.9212.

No-stripe check (pseudo-adversarial layer): run one Unique job with `enablePgd=true` and `enableAdversarial=true` on a 4 s clip and read the log - it must say `[SYS] Pseudo-adversarial ON: fast unique (no geq) · chroma ±1 · hue ±x°` (any `geq mid ... amp ...` text means the removed stripe layer is back). Reference (4 s, `pgdLevel=light`, CPU encode): 26.2 s end to end and a clean frame at 2 s, versus 33.7 s and visible vertical banding before the fix (`tmp/geq-before.png` / `tmp/geq-after.png`).

CLIP row check: any Unique job (PGD on or off) must log `[SYS] CLIP sim nội dung (file ra vs gốc): 0.xxxx (12 khung · ... · cuda)` and return `clipSimOut` / `clipSimOutWorst` / `clipSimOutFrames` / `clipSimOutDevice`. If Python, torch or open_clip is missing the line says `bỏ qua` and the job still finishes - that is the intended fallback. References measured with this exact method on a 4 s 1080x1920 clip (RTX 3050): Unique `light` 0.9454, Unique `strong` 0.8798, PGD-only `light` 0.9121; identity would be 1.0000. A full `strong` job took 11.8 s including the extra ~4-8 s of measurement.

ETA check: stream a Unique job and look at `progress` events - the unique phase must omit `etaMs` on the first few percent and then send a value that shrinks as `value` grows; the PGD phase carries `etaMs` from the moment the frame counter appears. Reference on a 30 s 1080x1920 clip (`strong`, CPU, `pgdLevel=light`): unique 16% -> 18970 ms, 47.1% -> 11035 ms, 95.2% -> 953 ms; PGD 14% -> 131567 ms, 97% -> 2861 ms; whole job 153 s. An inflated first value (e.g. 133 s at 0.4%) means the 3% guard was removed.

Audio anti-repeat check: run two Unique jobs back to back on the same clip and compare the `EQ trôi 3 dải ±a/b/c% chu kỳ X/Y/Zs` part of `[SYS] Audio unique`. With the real tolerance (periods within 0.8 s AND all three depths within 0.02) the two runs normally differ on their own; to prove the branch is reachable, temporarily set `AUDIO_SIGNATURE_TOLERANCE` to `[0.2, 0.2, 0.2, 4, 4, 4]`, restart, and the second job must log `[SYS] Anti-repeat: re-drew audio drift 6x`. Restore the tolerance afterwards (`rg AUDIO_SIGNATURE_TOLERANCE ghostforge-server.js`).

Stage timing check: every Unique job (PGD or not) must log `[SYS] Thời gian: chuẩn bị ... · encode ... · PGD ... · metadata ... · đo đạc ... · tổng ...` and return `stagePrepMs` / `stageEncodeMs` / `stagePgdMs` / `stageMetadataMs` / `stageMeasureMs`. The stages must add up to just under `processingTimeMs` (the small tail - compare frames, SHA-256, re-probe - is not counted). Reference on a 6 s 1080x1920 clip, CPU encode, `pgdLevel=light`: Unique + PGD total 40.9 s (prep 0.0 / encode 4.9 / PGD 27.7 / metadata 0.0 / measure 8.2) with `processingTimeMs` 40969; PGD-only 34.8 s (PGD 27.0 / measure 7.7).

Parallel-measurement check: the measurement stage should now be close to the CLIP step alone. Reference on an 8 s clip (CPU encode, no PGD): `đo đạc 6.1s` while `python clip_sim.py --a <src> --b <render>` on the same pair measured 5.3 s by hand - so the other three measurements add ~0.8 s rather than ~2 s. The values themselves must match a sequential run (dHash 25.9%, pHash 19.6%, block worst 54.6%, `clipSimOut` 0.9083 on that clip). Note the log lines now arrive in completion order, which is not a bug.

Warm CLIP helper check: run two Unique jobs in a row without PGD. The first (helper cold) should show a measurement stage of ~6.5 s; the second (helper warm) ~1.8 s, with the same `clipSimOut` shape (`12 khung · ... · cuda`). Reference on an 8 s clip: job 1 `đo đạc 6.5s` / total 13.0 s, job 2 `đo đạc 1.8s` / total 6.6 s. With PGD the log must contain `CLIP helper stopped to free VRAM for PGD` before the attack and the measurement stage pays a restart afterwards (7.5 s in the reference run). If the helper cannot start, the log simply shows the one-shot result and no error - do not treat a cold reading as a failure.

PGD batch check: run `python pgd_clip.py --input <clip> --output <out> --eps 3.5 --steps 3 --alpha 1.2 --eot-views 4 --batch N --enc-args '["-c:v","libx264","-preset","veryfast","-crf","16","-pix_fmt","yuv420p"]' --enc-label test` for N = 1 and N = 8 and compare. Reference (8 s 1080x1920 clip, 240 frames): 35.4 s vs 28.2 s wall; the printed mean CLIP must be within ~0.001 (0.9202 vs 0.9205) and `python clip_sim.py --a <src> --b <out>` within ~0.001 as well (0.9112 vs 0.9118). Inside the app the PGD stage should drop from ~38 s to ~29 s on that clip, and the log must contain `[PGD] batch 8 frames per pass`. On a smaller GPU expect `VRAM ran out — batch size N frame(s) per pass` instead - that is the fallback working, not an error.

CLIP-helper-vs-PGD check: run one PGD job after any job that started the helper. The log must show `[SYS] CLIP helper giữ nguyên trong lúc PGD (còn X/Y MB VRAM trống)` when X >= 2000, or `CLIP helper nhả model cho PGD ... sẽ nạp lại khi đo` when it is lower; both paths must finish the job. Reference (8 s clip, `pgdLevel=light`, NVENC): resident -> `PGD 28.4s` + `đo đạc 2.3s` + total 35.0 s with 2580/4096 MB free; unloaded (threshold forced to 3500 so the branch triggers) -> `PGD 28.3s` + `đo đạc 3.3s` + total 35.9 s. A missing helper log means `prepareClipWorkerForPgd` fell back to stopping it - check the VRAM control request.

PGD encoder regression check (do this whenever the write-out changes): the log line from the script must carry the codec read from the parsed args, e.g. `[PGD] encode NVIDIA NVENC p5 constqp 18 (GPU) [codec h264_nvenc]` or `[PGD] encode CPU libx264 veryfast crf 16 [codec libx264]`, and it must match the Encoder chosen in the UI. The decisive test is a deliberately impossible encoder: `node -e "const {spawnSync}=require('child_process');const r=spawnSync('python',['pgd_clip.py','--input','<clip>','--output','<out>','--eps','3.5','--steps','1','--eot-views','4','--batch','8','--enc-args',JSON.stringify(['-c:v','khong_co_encoder_nay']),'--enc-label','test invalid'],{encoding:'utf8'});console.log(r.status, r.stdout)"` - it must exit non-zero with `ERROR: [Errno 32] Broken pipe` (the encoder died). A `status 0` with `[PGD] done` means `--enc-args` is being ignored again. Reference measurements after the fix (8 s clip, light, batch 8): NVENC qp18 vs x264 crf16 = 31.5 s vs 31.5 s, 11.51 MB vs 11.50 MB, decoded CLIP sim 0.9124 vs 0.9116 - identical, so the encoder choice only changes CPU load.

PGD stripe + loop-speed check: render any clip at `--eps 10 --steps 8` (strong) and scan a flat band for a periodic texture - `node tmp/tech-tests/stripe-scan.mjs <render> <source>` prints the column-profile spectral peaks; a 16 px peak above ~0.2 levels means the visible plaid is back (the capped backstops measured 0.12, the old uncapped ones 0.34, a clean source 0.03). Quality reference on an 8 s 1080x1920 clip: in-attack CLIP 0.8613 and decoded output vs source 0.9201 with the cap (0.8601 / 0.8895 before) - if a stronger attack is wanted, the documented middle setting (floor 1.6/255, face 3.0/255) measured 0.9077 with a peak of 0.18. Loop speed reference: 240 frames in 28.8 s with the current code (32.2 s before removing the per-step `.item()` sync); if a run suddenly reports long PGD times, check `nvidia-smi` for another job sharing the GPU before blaming the loop.

PGD colour-space check (do this after any change to the pipe): `ffprobe -v error -select_streams v:0 -show_entries stream=color_range,color_space -of default=nw=1 <render>` must print `tv` and `bt709`. Then compare with the source: `ffprobe` on both and `ffmpeg -i <render> -i <source> -lavfi psnr -f null -` should read y-PSNR around 49-50 dB for a near-no-attack run (a plain re-encode of the same clip at the same quality reads ~54 dB; if you see ~34 dB the colour tags are missing and later conversions are picking a different range). `node tmp/tech-tests/measure-hash.mjs <source> 8 <render>` must stay near dHash 1%, luma 0.1% for the `--eps 0.1 --steps 1` round trip - it measured 3.3% / 2.8% without the tags. Speed reference with the yuv420p pipe: 24.6 s per 240 frames at strong (28.8 s with rgb24).

Chroma-grain cap: run a Unique job at `uniqueStrength=extreme` and read the `[SYS] Grain:` line - it must end in `C2` (it was `C3` before the cap). Luma (`L..`) still scales with the strength.

PGD-switch responsiveness: `curl -s -o NUL -w "%{time_total}" http://127.0.0.1:<port>/api/pgd-status` must read ~4 s the first time (Python imports torch + open_clip) and ~0.01 s right after (60 s cache); `?fresh=1` forces the slow path again. In the UI the switch must flip on the click itself - the status check runs behind it and only writes a log line (turning the switch back off) when the environment is missing.

Carrier-visibility check (after any change to the backstop textures): render the same clip and run `node tmp/tech-tests/temporal-scan.mjs <source> <render>`. The render's frame-to-frame texture correlation must stay well below the source's own value - references: source 0.755, the old slow-phase (0.21 rad/frame) render 0.829 (trackable = looks like stripes), the current fast-phase (1.9 rad/frame) render -0.139, and a live `extreme` + PGD `strong` app job -0.110. `node tmp/tech-tests/stripe-scan.mjs <render>` should stay around a 16 px peak of 0.12 levels (0.34 was the visible plaid). EOT views must read `[PGD] EOT ON · 3 views`; the A/B against 4 views measured decoded distance 0.9196 vs 0.9228 and harsh-re-encode 0.9381 vs 0.9408, so 3 is the current choice.

Audio-fingerprint check (the real one - do not use a hand-rolled proxy, one was measured scoring an unrelated clip at 97%): `node tmp/tech-tests/fp-real.mjs <source> <candidate...>` uses `tmp/tools/chromaprint-fpcalc-1.5.1-windows-x86_64/fpcalc.exe` (download it again if `tmp/` was cleaned; ffmpeg here has no chromaprint). References on an 8 s clip (43 reference sub-fingerprints): unrelated clip 0.0% (control), plain AAC 96k re-encode 60.5%, EQ only 41.9%, EQ+allpass+compressor+stereo 11.6%, `atempo=0.9885` alone 11.6%, the full Unique audio chain 0.0%, that chain plus another AAC 96k 2.3%. If a future change makes the candidate share more than ~20% with the source, the audio side has become easier to match.

Frame-step dial check (only if someone turns `--frame-step` on): run the same clip at step 1 and 2 and compare wall time, decoded distance, and the distance that survives a harsh re-encode (`ffmpeg -c:v libx264 -crf 30`). Reference on an 8 s clip, strong, 3 EOT views: 21.7 s / 0.9164 / 0.9323 (step 1) versus 17.7 s / 0.9170 / 0.9351 (step 2) - 18% faster for ~4% of the surviving effect. Also confirm the picture did not change: stripe peak 0.11 -> 0.10 and frame-to-frame texture correlation -0.141 -> -0.102 with `tmp/tech-tests/temporal-scan.mjs`. Flow-warp prototype (`tmp/tech-tests/flow-warp.py`) is kept only as a record: 47 ms/frame, dHash 2.5-5.1% at alpha 0.15-1.0, not worth using.

## Edit contain/fill seam check

The 9:16 mix graph can be checked without any AI call by rendering the same source twice, once with the plain `overlay` and once with the 48px alpha ramp on both picture layers, then comparing the row where the contain (1080x608) or fill (1080x1080) window meets the blurred bar. At 48px the old graph shows a hard step and the new one a gradient; a 10s render went from 1.8s to 2.3s. Use a 16:9 source such as `D:\Tiktok\family security\SML Movie Jeffy The News Anchor _1080p.mp4`. The `enable=` switch that chooses contain or fill must be identical in both renders - only the layer edge alpha changes.

For the 0.25s cross-fade, render a timeline that alternates contain and fill (e.g. fill 0-2, contain 2-4, fill 4-6) with the plain `enable` switch and with the ramp mask. Sample a frame in the middle of a ramp (t = window start - 0.125): the hard version shows one framing, the cross-fade version shows both framings ghosted. Watch the clip rather than a still - at 0.25s the dissolve reads as a smooth change of framing.

## Edit focus 9:16 framing check (no AI)

Gemini key persistence (no AI): `node tmp/tech-tests/gemini-secrets-smoke.mjs` boots the app with `GHOSTFORGE_SECRETS_FILE` pointed at a temp file, POSTs two fake keys (plus one blank), re-reads them over `GET /api/gemini-keys`, checks the file on disk and that a fresh store instance (an app restart) reads the same values, then deletes the temp file. Expected: `SECRET STORE OK`, the blank secret dropped, and the operator's real `uploads/gemini-keys.json` untouched. In the UI, typing a key and reloading the page must show it again with the log line `Nạp N Gemini key đã lưu trên máy`, and `uploads/gemini-keys.json` must be updated within a second of the change (it is written on every change, not only when a run starts).

Detail per part on the focus path (costs AI, unconditional): every full focus run must log `Detail PLAN n/N: … local Xs`, `detail AI n/N`, `Detail PLAN n/N modes: raw … other=…` (all windows in the `focus/pip/split` vocabulary when the focus prompt is used) and `Detail PLAN complete: n/N enriched · 0 fallback`, and the render must then log more windows than the global plan alone. Measured 2026-10-01 on `San Diego Officers Shoot Fleeing Suspect…` (276 s): global plan 5-6 windows; with Detail 11 windows (`other=10`), 84 hold points, `focus render 19.4 s` for a 136 s part, stage times plan 50.4 s / detail proxy 7.3 s / detail AI 45.1 s. That run had no API key, so `detail AI` went through Vertex (`vertexGeneratePlan`) - with a Gemini key entered the same stage must instead log `Detail n/N: Gemini API (gemini-3.5-flash-lite) key 1/1` from `geminiDetailAcrossModels`, which is the normal path. Check `[EDIT] RUN … geminiKeys=N` to know which one to expect.

Verified both Detail transports on 2026-10-01: without a key (`geminiKeys=0`) the stage logs `Detail 1/1 failed — using global PLAN fallback (…)`-style Vertex work and the timing line comes from `vertexGeneratePlan`; with the operator's own key (`geminiKeys=1`) the log reads `[EDIT] Detail 1/1: Gemini API (gemini-3.5-flash-lite) key 1/1`, `detail AI 1/1: 17.5 s`, `Detail PLAN 1/1 modes: raw contain=0 fill=0 other=3` then `Detail window 1/2: 0.0-9.7 focus` / `Detail window 2/2: 9.7-63.9 pip · "Tracking the leopard below while keeping the lioness stalking above visible"` and `Detail PLAN complete: 1/1 enriched · 0 fallback`. So Global = Vertex and Detail = Gemini API key (Vertex only as the no-key fallback).

Camera-2 tracking check (no AI): `node tmp/tech-tests/focus-real-layouts.mjs <clip> 10 12 0.20 0.55 0.55 move` renders a pip window whose second camera walks across the frame and writes `real-pip.png` (t=3.6 s) and `real-pip-late.png` (t=6.4 s). The inset content must differ between the two - a frozen inset means the `track[]` cx2/cy2 path or `secSnapAt` regressed. Unit cover: `holdSnapExpr` with `snapAt` 0.35 vs 0.10, and `focusFrameGraph` keeping the inset's own lerp.

Detail model order on the API-key path (2026-10-02): `tests/detail-models.test.js` covers the ordering (safe starts at `gemini-3.5-flash-lite`; quality puts the chosen model first without duplicating it; only returns just that model) and the overload cache TTL. Live check with a real key (`GF_TEST_API_KEY`), one full focus job per mode: `safe` must log `[EDIT] Detail 1/1: Gemini API (gemini-3.5-flash-lite) key 1/1`; `quality` must log the MODEL box value first (`… Gemini API (gemini-3.8-flash) …`) and, when that model is busy, `… quá tải — bỏ qua model này 10 phút, hạ xuống <next>` followed by a successful lower model - never a long wait and never a fall-back to the global plan while a lower model is available. The RUN line carries `detailModelMode=` so a log can be read without guessing. Measured on the 66 s lioness clip: `safe` 3.5-flash-lite 19.4 s, `quality` 3.8-flash 18.5 s, both `HTTP429=0`. `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` lists what a key can use (the operator's key returned 61 models including 3.8/3.7/3.6/3.5-flash and 3.1-pro-preview) - model availability is not the limit, per-model load is.

Long-video / multi-part check (2026-10-02): run the focus path on a source longer than ~10 minutes and confirm the plan itself decides the part count (`Global PLAN segments: raw=N parsed=N`, and parts that are not worth keeping are simply absent). Measured on a 622.9 s 1920x1080 police video: 2 parts (0-76 s, 332-460 s), both `Detail PLAN complete: 2/2 enriched · 0 fallback`, both 1080x1920, `HTTP429=0`, backend 424.5 s (~0.68x realtime). In the same run, check the two coverage log lines: `Focus 9:16: AI phủ thiếu …s toạ độ — bù … điểm bám bằng mẫu RGB local` and `Focus 9:16: phủ toạ độ X/Ys`. A part whose Detail plan covers only its opening seconds must still come out with a moving crop - if the second line shows a small X/Y without the repair line, the local re-aim regressed. Replay a single part without re-running the video with `node tmp/tech-tests/focus-part-replay.mjs <source> <start> <end> "<title>"` (it goes through `/api/edit/part-test`, so it also covers the targeted-replay route).

Part quality score (2026-10-02): `tests/edit-qa.test.js` covers the scoring (clean moving crop = 100; a frozen crop loses up to 20 points; a crop with no subject at all lands at/below 60; empty/edge/coverage warnings fire). Live check: every focus render must log `[QA] Chất lượng part: X/100 (grade) · <warnings> · N mẫu/ Ys`, each part row in the Edit cut table must show the same line, and `uploads/edit-qa-history.json` must gain one entry per part (check with `GET /api/edit/qa-history`; it also returns per-mode averages). Measured 2026-10-02: the 128 s police part the AI covered for only 37 s scored 67/100 with `crop không có chủ thể trong 26s/128s · AI chỉ phủ 59% thời lượng (đã bù 53s bằng mẫu RGB)`; a 60 s wildlife part scored 68/100 with `crop không có chủ thể trong 20s/60s`. Treat a low score as "watch this part", not as proof - the heuristic is wrong on footage where the subject is small or the shot is genuinely empty.

Automatic second pass (2026-10-02): `tests/edit-qa.test.js` also covers `pickQaFocusPoints` (bad moments only, spread apart, capped) and `applyAimOverrides` (only the corrected moment is replaced, clamped to the part). Live check on a part that scores under 80: the log must show `[QA] AI soi lại khung bằng gemini-3.5-flash-lite` (never the 3.8-class UI model first - that returned HTTP 503 on the first live attempt), then `[QA] AI soi lại N mẫu: M chỗ cần chỉnh khung · <t>→<cx>`, then either `[QA] Sửa lại khung bằng AI: <before> → <after>/100 (giữ bản tốt hơn)` with `[QA] sau khi sửa: …`, or `[QA] Bản sửa của AI không tốt hơn (…) — giữ bản gốc`. Only the better file may survive, and a part already scoring >= 80 must not make the extra call at all. Measured: a 60/100 police part → critic on 4 stills → 2 corrections → re-render → 63/100 kept; an 82/100 wildlife part → no extra call.

Frontend render check (no AI): `node tmp/tech-tests/ui-render-check.mjs` boots `launch.mjs` on port 8099 against the built `dist/`, opens it in headless Chrome over CDP and prints the rendered body text, the `#root` child count and any `Runtime.exceptionThrown`. Expected: the app text (`GhostForge AI`, the tab names, `BACKEND: READY`), `root children: 1`, `exceptions: 0`, and `UI RENDER OK`. A blank page with an exception here is a broken hook (a `useEffect` placed above the declaration of something in its dependency array throws in the temporal dead zone and React paints nothing); `vite build` does not catch it, so run this after touching hooks. On this host the default port cannot be used: Windows reserves TCP 8039-8138 (`netsh interface ipv4 show excludedportrange protocol=tcp`), so `launch.mjs` prints `Port 8099 unavailable; choosing a free port` and the harness times out waiting for `:8099`. Run it as `CHECK_PORT=8188 CHECK_CDP_PORT=9344 node tmp/tech-tests/ui-render-check.mjs` (PowerShell: `$env:CHECK_PORT=8188; $env:CHECK_CDP_PORT=9344; node tmp/tech-tests/ui-render-check.mjs`).

The focus path is the default Edit framing (`framingStyle=focus`): the canvas stays 1080×1920, a focus window is a 3:4 crop centred on a blurred copy of the frame, plus an optional corner window (`pip`) and an optional top/bottom split (`split`) that still covers the canvas. Static contracts live in `tests/ffmpeg-expressions.test.js` (`fitCropBox`, `zoomCropBox`, `holdSnapExpr`, `enableExpr`, `focusFrameGraph`, a narrow `panelW` half padded beside the shared zoom box), `tests/editor-plan.test.js` (mode names, `cx2/cy2` on frames and track, `focusEditorPrompt` / `focusDetailPrompt` / `generalGlancePrompt`) and `tests/focus-layout.test.js` (portrait panel beside one person, two people, a video wall including a slightly larger tile, a lone phone, a model split trimmed until the second subject appears, one sharp face moving a focus window off centre, a soft side face leaving the crop alone, one sharp side sample kept, a full-frame torso followed when the face is out of shot, two dark-canvas objects becoming a split, a short pair and a video wall staying one crop, samples past the end of the plan still aiming at the face, a still empty card recentred after a cut, a frame-cut card staying one crop on the object that is inside, two people who drift by 0.15 still sharing a split, a side pair that jumps 0.16 staying broken, two round objects named as their own split, one face beside two body boxes staying one crop, a face beside a wide board staying a split, two arms at the top becoming their own split, a face on an arm not extending the two-person split, two real faces at least 0.30 apart opening a split, a 0.285 face gap and a three-face row and a speck-face scoreboard staying one crop, a two-face sample just under 0.35 still held to the cut, a short panel extended only to the following cut, a wide product card starting on the previous close-up sample, a speck face not keeping a model split). The layout scan itself is local (`local_layout_scan.py` via `.venv-diar`); `GHOSTFORGE_LOCAL_LAYOUT=0` skips it and the plan is rendered unchanged. It does not call Gemini.

Two local smokes, both no AI / no GPU (harnesses in gitignored `tmp/tech-tests/`):

- `node tmp/tech-tests/focus-frame-smoke.mjs` builds a synthetic 1280x720 clip, renders through `focusFrameGraph` and writes `tmp/focus-smoke/frame-focus.png`, `frame-pip.png`, `frame-split.png`. Expected: 1080x1920. The focus frame is a 3:4 picture (1080x1440) centred on a blurred frame. The pip frame shows a bordered 420x236 window at the bottom-right (bottom-left when the mean main-subject cx is > 0.5). The split frame shows two 1080x960 halves with a 6px dark divider and no letterbox. Main crop is 540x720 for 1280x720 (810x1080 for 1920x1080).
- `node tmp/tech-tests/focus-edit-smoke.mjs` boots the real Express app on a free port and drives `mode=even` + `framingStyle=focus` through `POST /api/edit/job-local` and `GET /api/edit/stream/:jobId`. Expected: 2 parts, each 1080x1920, log lines `After Gemini: cut, then FOCUS 9:16 (focus 3:4 trên nền mờ, split phủ kín)`, `Focus 9:16 (no framing plan)`, `Focus 3:4 trên nền mờ`, and **no** `General glance`, `STT`, `Detail` or Vertex line. Delete the part jobs afterwards with `DELETE /api/job/:jobId`.

A real focus run (`mode=ai`) spends a Vertex call, so it is never a routine check - run it only when the operator authorises quota. Ready-made driver: `node tmp/tech-tests/focus-ai-smoke.mjs <source.mp4> full` (or `test 60`) boots the real app, runs the focus path, prints every log line and the parsed plan, and saves the part's frames plus `tmp/focus-smoke/last-ai-run.log`. Two rules for a clean result: put the source INSIDE the repo (diarization/STT write `<source>.diar.wav` / `<source>.stt.wav` beside it, so a read-only folder silently gives `Google STT skip` and 0 speech lines), and keep the audio track (a clip trimmed with `-an` has nothing to diarize).

Measured 2026-10-01 on Vertex ADC (RTX 3050 host, ~2-3 minute parts, NVENC):

| source | result |
|---|---|
| police bodycam 1920x1080 276 s, TEST 60 s | 1 part 58.9 s, 3 focus windows, 1080x1920 |
| same file, full run | 1 part 117-243 s, 5 focus windows, 1080x1920; a later run 6 windows (cx 0.58/0.28/0.72/0.55/0.72/0.52), part 162.6 s |
| lioness/leopard 1280x720 66 s | 3 focus windows; both animals fit the tall crop, no pip (correct) |
| reaction video 1920x1080 90 s (streamer facecam in a corner) | `pip` on 2 of 3 windows, camera 2 on the facecam (`cx2` 0.12, `cy2` 0.20); rendered frame shows the content filling 9:16 and the face in the bottom-left bordered window |

Stage times on the 276 s police clip: plan proxy 6.8 s, plan AI 33.8-120.2 s (one run hit the Vertex inline timeout and retried: 348 s), pyannote 26.8-51.1 s, Google STT 59.4-84.4 s, focus render 10.5-14.4 s. Expect `General glance: N part giữ framing Global PLAN · M part phải xem stills` and M = 0 whenever the plan framed the part itself.

SML stays the control: switch `framingStyle` to `sml` and the contain/fill checks below must still pass unchanged.

## Unique rotation check

Send `uniqueRotate` (0 / 0.5 / 1 / 2 / 3) in the upload form. The run logs `[SYS] Rotate: N deg · corner-fill zoom X×`. After a tilted render, crop a 24x24 patch at each of the four corners and compare its mean luma with the same patch on the input: they should be close. A near-black patch that the input does not have means the corner-fill zoom is too small; keep the 0.012 margin in `rotateScale`. A 9:16 test source is `D:\Tiktok\Brazil\Alecsandra Souza\1.mp4`.

## TikTok trend finder (no AI/GPU quota)

Hashtag lookup: run `npm test`, `npm run check:server`, and `npm run build` for structural validation. A live lookup requires TikTokApi, Playwright Chromium, a TikTok.com `msToken` from `scripts/tiktok-api-session.py` (or `TIKTOK_MS_TOKEN`), and working TikTok network access; it is not part of automated validation. Use `GET /api/videos/hashtag?tag=cops` to smoke-test when a session is saved. Missing/blocked sessions return a clear HTTP 502 message. Do not copy cookie values into tests or logs.
The panel's primary hashtag form filters the Creative Center video pool already loaded for the selected region, period, view band, and duration; it also links to `https://www.tiktok.com/tag/<hashtag>` for full browsing. An empty local match does not imply that TikTok has no videos for the tag. The optional direct TikTokApi route remains separate and is blocked on this host despite a saved `msToken`.
The session helper also accepts `--manual-token` for a token from a browser profile that can reach TikTok.com when Playwright Chromium is denied. It writes the token only to ignored `.tiktok-api-session/storage-state.json`; the bridge must pass cookie name/value mappings to TikTokApi, not raw Playwright cookie records. Never put a real token in a test or transcript. A successful request is still not guaranteed by a valid token.

The Trends tab (`Xu hướng`) is read-only: it calls `/api/trends*`, never touches FFmpeg, jobs, uploads or the local filesystem, and its provider caches results for ~10 minutes.

```bash
npm test                                  # includes tests/tiktok-trends.test.js (parsing, keyword aggregation, cache)
node tmp/tech-tests/trends-api-smoke.mjs  # boots the real Express app on a free port and calls /api/trends (needs npm install)
```

Live provider check (network, no API key needed):

```bash
node tmp/tech-tests/trends-smoke.mjs
```

Expected shape for `region=VN&period=30`: 3 hashtags, 4 videos, keyword chips, and a `limitations` line saying the free source returns only 3 hashtags / 4 videos. `period=120` is NOT a valid choice — Creative Center silently answers with the 7-day data, so the UI and `TREND_PERIODS` only offer 7 and 30.

Source quirks verified 2026-09-29 from this machine:

- The Creative Center pages return their data in `#__MODERN_ROUTER_DATA__` and only to browser-like request headers (a bare `curl` gets a shell page with no data).
- The full "View more" list needs a TikTok One login; the internal `creative_radar_api` endpoints reject unsigned calls with `code 40101 no permission`.
- The video tab only covers US, JP, VN, TH, ID. For some of those (observed with US) the server-rendered payload carries no video list at all; the response then adds a "thử lại sau" limitation instead of failing.
- `https://www.tiktok.com/tag/<name>` no longer embeds video data, so it is not a usable fallback.

Manual smoke: open the `Xu hướng` tab, pick Việt Nam + 30 ngày, press `Lấy lại`; expect the hashtag table, the video table and the amber limit banner. Try `minViews = 1 tr` to confirm the video list shrinks while the hashtag list stays.

### Video length filter (ffprobe)

Creative Center does not publish a video length, so `server/tiktok-trends.js` probes the signed CDN mp4 link the payload embeds (`itemInfo.videoURL`) with `ffprobe -show_entries format=duration`. Results are cached per video id inside the country+period cache entry, so changing the filters does not re-probe a clip. `GHOSTFORGE_FFPROBE` overrides the binary.

Expected on VN / 30 ngày (measured 2026-09-29): the four videos probe to 60.9 / 12.7 / 5 / 36 seconds, and `minDuration = 60` returns exactly the 60.9 s clip. A video whose length cannot be read is **not** shown under a length filter; the response adds a "không đọc được thời lượng" line to `limitations` with the count.

### Session helper (login for longer lists)

```bash
node scripts/tiktok-session.mjs login   # mở Chrome, đăng nhập, rồi đóng cửa sổ
node scripts/tiktok-session.mjs check   # headless: báo cáo phiên đăng nhập mở khoá được gì
```

`login` opens Chrome on a profile that belongs to this repo (`<repo>/.tiktok-session/chrome-profile`, gitignored because it holds a live session cookie). `check` loads the Trends page with that profile and prints whether the "Log in or sign up" call-to-action is gone, how many rows render, and what a plain HTTP request carrying the profile's cookies returns.

Measured 2026-09-29 after a real login: the CTA disappears, the profile holds 27 `ads.tiktok.com` cookies (including `sessionid_ads`, `sid_guard_ads`), and plain HTTP with that cookie header returns **20 hashtags and 20 videos** for VN/30 ngày instead of the logged-out 3 and 4. So the backend reads the longer list over HTTP; it does not need to drive the browser for data.

At runtime `server/tiktok-session.js` launches Chrome once (headless) to read the cookie header, caches it for 6 hours, and `server/tiktok-trends.js` sends it on the trends requests. If the source answers with the 3-hashtag teaser while a session exists, the provider refreshes the cookies once and retries, then reports "cookie có thể đã hết hạn" in `limitations`. The response carries `sessionActive` so the UI can show `đã đăng nhập` or `khách (bản xem thử)`. Closing the login window is required before the server can read the profile - a running Chrome holds the profile lock.

Signing in requires a TikTok account that can use Creative Center / TikTok One; without one the teaser limits stay in place. Automating Creative Center access is the operator's call with respect to TikTok's terms.

### Region quirk: US video list

The US video tab does not server-render its list (55 KB shell, 0 `itemID`, no `popular/videos` payload) - the page fetches it afterwards from `ads.us.tiktok.com/CreativeOne/Report/CreativeCenterGetTopContentsList?...&countryCode=US&limit=20&orderByMetric=1&page=1&periodDimension=5&periodEndTimestamp=...`. `captureTrendVideoList` loads that page in the session browser and keeps the response body, so the moving `periodEndTimestamp` stays TikTok's concern. It runs only when the server-rendered video list is empty and the region is US/JP/VN/TH/ID.

Check: `node tmp/tech-tests/trends-api-smoke.mjs` boots the app and queries VN, US and JP. Expected after the fix (measured 2026-09-29 in `D:\tool`): US 20 hashtags + 20 videos in ~12.7 s cold with `limitations: []`; JP 20 + 20 in ~3 s; the other regions keep returning 20 + 20.

### Longer video list (100 rows)

The page embeds at most 20 videos, but the list API behind it returns up to 100 with a session. `server/tiktok-trends.js` calls it directly (`CreativeCenterGetTopContentsList`) with `limit=100`, `periodDimension` 3 for 7 days / 5 for 30, and `periodEndTimestamp` taken from the page's `videoOverview` payload. Host routing is per region: US answers on `ads.us.tiktok.com`, VN/JP/TH/ID on `ads.tiktok.com`; both are tried and the winner is cached. Anonymous calls return only 4 rows, so this path requires the login.

US has no `videoOverview` on its own page, so the timestamp learned from another region (VN/JP) is reused - it is a global "data as of" date.

Measured in `D:\tool` (2026-09-29): US 100 videos, filter `1 phút trở lên` -> 19 videos; JP 100 videos -> 30 videos. The unfiltered request probes only the top 25 clips for their length; a length filter probes the whole pool. Durations are cached in `cache/trend-durations.json` (gitignored) so a second server run answers in ~2 s instead of ~16 s. US cold start ~10 s, warm ~2-3 s.

### Watch links (the "video không khả dụng" fix)

The list API returns `itemID` as an **unquoted JSON number**, and a 19-digit id cannot survive `JSON.parse` (7673371213716262165 becomes 7673371213716262000), so every watch URL was a dead link. `quoteBigIds` quotes long `*ID` fields before parsing, in both the list API and the page payload.

Check with `node tmp/tech-tests/cc-url-probe.mjs`: it builds `https://www.tiktok.com/@handle/video/<id>` from the live list and asks TikTok's oEmbed. Expected after the fix: **oEmbed 200** with the video title for VN and US; before the fix every URL returned `400 {"message":"Something went wrong"}`. A 404 from oEmbed instead would mean the clip was deleted or region-locked, which is not something the app can repair.

### View range and paging

`minViews` and `maxViews` bound the band (`?minViews=100000&maxViews=1000000` keeps only videos inside it; an empty or 0 `maxViews` means no upper bound). The panel has `View thấp nhất` / `View cao nhất` selects and pages the video list 20 rows at a time; the API always returns up to 100 filtered rows and the pager works on that array.

The list is ranked by views and has only **one page** of 100 rows (`page=2` returns 0 from the list API), so its view floor is already in the millions - measured 2026-09-29: US 7.8M-39.3M, VN 2.3M-11.9M for the 7-day window. A band below that floor legitimately returns nothing; the response then says so and prints the range the source offered instead of the misleading "nguồn không trả danh sách video" line (that message is now reserved for a genuinely empty pool). `TREND_MIN_VIEWS` / `TREND_MAX_VIEWS` use steps inside that range.

The response carries `poolViewsMin` / `poolViewsMax` (the range of the unfiltered pool), and the video card prints it next to the filters plus the line "Đây là N video view cao nhất của nước này, không phải tìm kiếm toàn bộ TikTok". This is the answer to "TikTok has millions of videos in that range, why is nothing found": the source is a top-N leaderboard, not a search index, so it can never return a video below its own floor.

Detail-mode tuning (2026-10-02, self-test removed 2026-10-04): `tests/qa-tune.test.js` covers the decision rules (a suggestion needs >= 12 parts per mode AND a >= 5 point gap; a topic with too few parts does not borrow another topic). Live check: with `detailModelAuto` on, the RUN line must show `detailModelMode=<mode> (auto từ <mode>)` plus `[QA] Tự chọn chế độ Detail theo số đo: …` (or the "chưa đủ dữ liệu" line). An empty history must not switch the mode. There is no self-test button and no `/api/edit/self-test` route.

## Frontend build
```bash
npm run build
```

The supplied ZIP contains Windows-installed `node_modules`. In the Linux ChatGPT sandbox, Vite/Rollup cannot load its Linux optional native package, so the production Vite build cannot be completed here without reinstalling dependencies. This is an environment/package-platform mismatch, not a source-code build error. On the target Windows machine, run `npm install` (if needed) and then `npm run build`.

## Runtime smoke test on Windows
1. Start GhostForge normally.
2. Verify `/health`.
3. Open each UI tab.
4. Test one small local video for the feature changed.
5. Verify progress SSE and cancel if the change touches jobs.

Avoid GPU/API/full-video tests for unrelated changes.

Local Detail TEST acceptance: choose TEST, 30/60s and “Detail Local”. First run stores a random range; a second run on the same source must report `repeat saved range` and use identical timestamps. “Đổi đoạn ngẫu nhiên” must select/store a new range once. Verify no Vertex/Gemini/Google STT/Local Listen logs/calls, inspect Local Detail window logs and rendered 9:16 output. Missing runtime/model or invalid local JSON must fail clearly without cloud fallback. This test is local GPU work and must be user-authorized.

Coverage/batch manual acceptance (only with user authorization for real jobs): missing/conflicting exclusion evidence keeps footage without a pause; valid unrelated-ad/outro evidence cuts only recorded ranges. Verify multi-piece alignment, restored ending, per-video elapsed card/log, complete log export after >500 lines, and next queued source starting automatically. Check ordinary STOP/reconnect. TEST random-60/even/targeted modes remain excluded from Global coverage changes. No automatic video/API smoke test is part of unit validation.

## Handoff continuity check

```bash
npm run validate:handoff
```
This cheap check verifies that the required handoff documents/core source files still exist and that a small set of documented backend routes/symbols still match the current server. Run it whenever files, routes, symbols, or handoff documentation move/change.

## Combined cheap backend/handoff validation
```bash
npm run validate
```
This runs `validate:handoff`, `npm test`, and `npm run check:server`. It deliberately does not call Gemini/Vertex/STT, run GPU workloads, or perform full-video rendering.
