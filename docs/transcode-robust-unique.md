# Unique chống nén lại của nền tảng (transcode robustness)

| | |
|---|---|
| Author | Placeholder — operator review |
| Date | 2026-10-01 |
| Status | Proposal only. Chưa thực hiện. Không đổi hành vi Unique/PGD cho đến khi operator nói **thực hiện**. |
| Scope | Đề xuất phương án + công cụ để lớp đã xử lý của Unique (đặc biệt PGD) không bị xoá sau khi nền tảng nén lại. |

## Overview

Video upload lên TikTok/YouTube luôn bị nền tảng giải mã rồi mã hoá lại (transcode) theo thang chất
lượng của họ. Không có cách nào trong app ngăn được việc đó. Thứ duy nhất kiểm soát được là **file lúc
upload** và **độ bền của lớp đã xử lý**, cộng thêm **đo lường đúng** để biết lớp nào còn.

Số đo hiện có trong repo đã trả lời một nửa câu hỏi này. Lớp hình học / màu / tempo / audio của Unique
còn nguyên sau proxy nén (harsh dHash 41.5%, pHash 28.6%, fingerprint audio 0.0%). Lớp PGD gần như
biến mất theo thước đo hash (harsh dHash 5.2–7.3%, pHash 1.6–2.6%), dù CLIP còn giữ được một phần.

Tài liệu này đề xuất 6 nhóm phương án, xếp theo thứ tự "đo được → rẻ → đắt", và ghi rõ cái nào đã bị đo
và loại từ trước (để không đề xuất lại).

## 1. Vấn đề, bằng số đã có

### 1.1 Nền tảng luôn nén lại

TikTok phát H.264 theo thang 540/720/1080 tuỳ thiết bị và băng thông. YouTube Shorts dùng thang
H.264/VP9/AV1. Cả hai đều giải mã file upload và mã hoá lại. Kết luận: **"không bị nén lại" là mục tiêu
không thể đạt tuyệt đối**; mục tiêu đạt được là "lớp đã xử lý còn lại sau khi bị nén".

### 1.2 Lớp nào còn, lớp nào mất

Số đo sau lấy từ `CURRENT_STATE.md` (2026-10-01) và `PIPELINES.md` §1, đo bằng proxy `libx264 crf 30,
cạnh dài ≤ 720` trong `measureHarshProxy` (`server/harsh-scale.js`).

| Lớp của Unique | Cơ chế | Sống sót qua proxy? | Số đo |
|---|---|---|---|
| Hình học (zoom / crop / rotate) | biên độ lớn, tần số thấp | Có | Unique strong: harsh dHash 41.5%, pHash 28.6% |
| Tempo curve (setpts + atempo) | thay đổi theo thời gian | Có | dịch chuyển mô hình còn đúng, motion correlation 0.999 qua proxy |
| Màu / grade / grain | biên độ vừa | Có | nằm trong con số dHash 41.5% |
| Audio (EQ + allpass + compressor + stereo + drift) | phổ | Có | AcoustID sub-fingerprint 0.0% (thêm AAC 96k: 2.3%) |
| **PGD perturbation** | biên độ 3.5–16/255, blob ~34 px ở 1080 | **Yếu** | PGD medium: harsh dHash 5.2%, pHash 1.6%, CLIP 0.8772 (file 0.8806). PGD strong: harsh CLIP 0.8513 (file 0.8113) |

Đọc thêm: `CURRENT_STATE.md` kết luận "Do not raise eps to chase this gap" — tăng `eps` không lấy lại
được con số hash này.

### 1.3 Vì sao lớp PGD mất (cơ chế)

1. Attack tính ở 224x224 (`pgd_clip.py`: `small = F.interpolate(t, size=(224, 224))`).
2. `project_delta` lấy trung bình 4x4 (`F.avg_pool2d(delta, kernel_size=4, stride=4)`) rồi nối lại 224 →
   residual là blob ~4 px ở khung 224, tương đương ~34 px ở khung 1080x1920. Tần số thấp (tốt cho nén),
   nhưng biên độ chỉ 1.2–6.3% toàn thang.
3. Lần nén thứ hai (DCT quant + hạ 1080 → 720 + chroma 4:2:0) ăn phần còn lại.
4. dHash 17x16 gần như mù với thay đổi trơn (smooth), nên "mất" trên thước đo hash không có nghĩa là mất
   hết trên thước đo khác: CLIP còn giữ khoảng 20–40% khoảng cách (bảng trên).

### 1.4 File rời GhostForge vẫn còn nguyên lớp

`remuxWithMetadata` trong `ghostforge-server.js` chạy `-c copy`, tức không re-encode sau PGD. Kiểm
chứng: `_enc.mp4` → PGD ghi `_pgd.mp4` (qp18/crf16) → remux copy sang `_output.mp4`. Vậy mọi mất mát
xảy ra ở **phía nền tảng sau khi upload**, không phải trong app. Hệ quả: tối ưu phải nằm ở (a) độ bền
của perturbation, và (b) chất lượng/định dạng file upload.

## 2. Nguyên tắc

- **P1.** Không thể chặn transcode. Chỉ có thể làm lớp xử lý bền hơn hoặc làm file upload "dễ nén" hơn.
- **P2.** Đo trên nhiều rung chất lượng, không đo 1 proxy. Một proxy crf30/720 là một rung, không phải kết luận.
- **P3.** Không tăng `eps` để bù (đã đo, vô ích và hại hình).
- **P4.** Mọi con số là proxy nội bộ, không phải verdict dedup của nền tảng (`PIPELINES.md` nói rõ).
- **P5.** Giả định operator có quyền với nội dung nguồn. Tài liệu này không bàn về việc lấy nội dung của người khác.

## 3. Phương án A — làm perturbation bền hơn (`pgd_clip.py`)

### Hiện trạng EOT

`eot_stack` hiện có 4 view: identity; fake-jpeg(16) sau 112 down/up; fake-jpeg(24) sau 160 down/up; crop
224–256 + fake-jpeg(20). `jpeg_ste` là straight-through quantize đều, không phải DCT. Loss hiện tính
trên các view này.

Ba thứ **còn thiếu** so với transcode thật:

1. Lượng tử DCT khối 8x8 kiểu H.264 (không phải quantize đều từng pixel).
2. Chroma 4:2:0 subsample **trong đường loss** (write path `rgb_to_yuv` có `avg_pool2d` chroma, loss thì không).
3. Đúng rung mà nền tảng hạ xuống (1080 → 720), và nén **hai lần**.

### A1 (rẻ, làm trước) — view "codec-like"

Thêm 1–2 view: DCT 8x8 + ma trận lượng tử kiểu x264 crf ~30 + chroma 4:2:0 + deblock nhẹ, dùng
straight-through như `jpeg_ste`. Không cần thư viện mới (torch đủ). `kornia` là tuỳ chọn nếu muốn bản
JPEG chuẩn.

### A2 (rẻ) — view "ladder"

Thêm view hạ rồi lên đúng tỉ lệ thang chất lượng: 224 → 149 → 224 (~0.667, tương ứng 1080 → 720) và
tuỳ chọn 224 → 112 → 224. EOT hiện có 112/160 nhưng chỉ một chiều và không dùng tỉ lệ này.

### A3 (đắt, flagship) — BPDA với FFmpeg thật

Mỗi K bước, encode batch adversarial bằng FFmpeg thật (`-c:v libx264 -crf 30 -vf scale=-2:720`),
decode lại, tính loss trên **ảnh đã bị nén**, gradient truyền qua bằng identity (Backward Pass
Differentiable Approximation). Đây là cách duy nhất "học đúng cái nén thật" thay vì mô phỏng.
Chi phí: round-trip FFmpeg mỗi K bước rất tốn (ước tính +1–3 s/lần trên clip 8 s) → chỉ nên chạy K=4–8
hoặc chỉ ở giai đoạn cuối. Xem §8 PR3.

### A4 — projection khớp rung

Ngoài `pool-4` đang dùng, thêm một thành phần `pool-8` (tần số thấp hơn nữa) với hệ số nhỏ, để phần biên
độ nằm lại ở dải mà cả DCT quant lẫn downscale đều giữ.

### A5 (đắt, chỉ khi cần) — ensemble surrogate

Dedup của nền tảng không dùng CLIP. Có thể thêm embedding thứ hai (DINOv2 ViT-S qua `timm`, hoặc
soft-pHash 32x32 có trọng số) làm surrogate. Cần cài `timm`/`transformers` (chưa có trên máy) → đắt,
chỉ làm khi A1–A3 không đủ.

### A6 — giữ backstop hiện có

`midband_carrier` (bước sóng 32/28/36 px, biên độ 0.35*eps và `floor ≤ 1.2/255`) đang được giữ. **Không**
quay lại lớp sọc `geq` (đã đo: nhìn thấy, 3–5x thời gian render).

### Đã đo và loại — không đề xuất lại

`--frame-step` (chỉ giảm 18% thời gian, mất ~4% hiệu quả), optical-flow warp (chỉ đổi dHash 2.5–5.1%),
`--hash-loss` ở 17x16 (không đổi gì vì perturbation trơn bị trung bình hoá), tăng `eps`, scale backstop
theo `eps`.

## 4. Phương án B — phía file upload (không cần GPU)

- **B1. Khớp rung đích.** Nền tảng giữ nhiều chi tiết nhất khi file đã ở đúng rung họ phát (TikTok:
  1080x1920). App đã xuất đúng khi bật canvas TikTok. Nguồn < 1080p là câu hỏi riêng, xem
  `docs/unique-enhance-design.md` (không tự ý upscale; proxy hiện tại "never upscale").
- **B2. fps / GOP.** Giữ fps nguồn (app đang làm), GOP 30–60 (~1–2 s @30fps). fps lẻ (25, 29.97, 59.94)
  khiến bộ nén nền tảng phải chuẩn hoá nhiều hơn.
- **B3. Chất lượng đích.** Nhánh encode Unique hiện dùng crf 20–25 (CPU, ngẫu nhiên) / qp23 (NVENC). Một
  tuỳ chọn "chất lượng cao" (crf 16–18) sẽ giữ lớp hình học/màu tốt hơn, đổi lại file to hơn. Lưu ý:
  nhánh PGD đã ghi ở qp18/crf16 nên B3 chỉ ảnh hưởng phần trước PGD.
- **B4. Container.** mp4 + `+faststart` — đã có.
- **B5. Không re-encode sau PGD.** Đã đúng (`-c copy`), giữ nguyên.

## 5. Phương án C — đo lường trước khi tối ưu (khuyến nghị làm đầu tiên)

Đây là phần nên làm trước mọi thay đổi khác, vì không có nó thì không biết thay đổi có giúp hay không.

- **C1. Ladder proxy 3–4 rung** trong `server/harsh-scale.js` + `measureUniqueOutput` / `measureHarshProxy`:

| Rung | Cấu hình | Ý nghĩa |
|---|---|---|
| L1 | 1080p crf 23 | nền tảng giữ 1080, nén nhẹ |
| L2 | 720p crf 28 | rung phổ biến |
| L3 | 720p crf 30, hai lần liên tiếp | nén kép (giống bị nén lại lần hai) |
| L4 (tuỳ chọn) | 540p crf 33 | rung thấp / mạng yếu |

  Mỗi rung báo dHash / pHash / CLIP so với source. Chi phí ước tính ~0.5–2 s mỗi proxy trên clip 8 s
  (đo lại khi làm).
- **C2. Chỉ số "sống sót".** Ví dụ `survClip = 1 - harshClipSim` (khoảng cách CLIP còn lại sau nén) và
  `survHash = harshDistance`. Phải định nghĩa rõ đây là tỉ lệ còn lại so với bản không nén, không phải
  tỉ lệ "qua được dedup".
- **C3. Panel + log.** Thêm dòng `[SYS] Sống sót` và một bảng trong kết quả Unique (theo mẫu các dòng
  `[SYS] Sau nén` đã có).
- **C4. Test đơn vị** cho bộ filter ladder (hàm thuần, không I/O) theo mẫu `tests/harsh-scale.test.js`.

## 6. Phương án D — công cụ: cài gì, không cần gì

Kiểm tra thực tế trên máy này (2026-10-01, `ffmpeg -encoders`):

- FFmpeg 9.0.1 essentials (gyan.dev) **đã có** `libx264`, `libx265`, `libaom-av1`, `libvpx-vp9`,
  `h264_nvenc`, `hevc_nvenc`, `av1_nvenc`, `h264_qsv`. → Mô phỏng thang nén của YouTube (VP9/AV1) hay
  TikTok (H.264) **không cần cài encoder mới**.
- Đã có sẵn: `torch 2.11.0+cu128` (RTX 3050), `open_clip`, `fpcalc`/chromaprint ở `tmp/tools/`,
  `flow-warp.py` (OpenCV) ở `tmp/tech-tests/`.
- Cân nhắc cài thêm (chỉ khi làm A1/A5): `kornia` (JPEG/DCT khả vi "chuẩn"), `timm` hoặc
  `transformers` (surrogate embedding thứ hai). Cả hai là pip, cần mạng.
- **Không cần**: Real-ESRGAN / TensorRT / Video2X — đó là pre-pass chất lượng hình ảnh, không liên quan
  độ bền transcode (xem `docs/unique-enhance-design.md`).

## 7. Phương án E — con đường rẻ hơn: lớp "nhìn thấy được" nhưng bền

Vì perturbation biên độ nhỏ là thứ dễ mất nhất, hướng ngược lại là làm lớp unique lớn hơn nhưng vẫn chấp
nhận được về hình. Số đo hiện có cho thấy các đòn này hiệu quả hơn PGD rất nhiều **theo thước đo hash**:

- Đổi canvas / pad: dHash 44.1% (đo trên clip 640x360 synthetic, 2026-09-24).
- Tăng strength hình học/màu: strong 38.7–39.5% dHash, luma 14.7–19.0% (clip có bar).
- (Đã có) zoom/crop, rotate 1–3 độ, tempo curve, grade, audio chain.

Đánh đổi: nhìn rõ hơn. Không đề xuất quay lại sọc `geq`; nếu muốn một lớp carrier thật, phải đo trên clip
thật và chấp nhận nó nằm trong khung hình.

## 8. Ưu tiên / PR plan

| PR | Nội dung | Đổi hành vi sản phẩm? |
|---|---|---|
| PR1 | Ladder proxy + test + dòng panel "Sống sót" (§5) | Không (chỉ thêm đo lường) |
| PR2 | A1 + A2 sau cờ `--eot-codec`, so bằng PR1 | Có, sau cờ (mặc định tắt) |
| PR3 | A3 BPDA với FFmpeg thật, nếu PR2 chưa đủ | Có, sau cờ, chậm hơn |
| PR4 | UI hiện bảng survival; cập nhật PIPELINES / CURRENT_STATE | Không |
| PR5 | A5 ensemble surrogate (chỉ khi cần) | Có |
| PR6 | B3 tuỳ chọn "chất lượng cao" | Có (tuỳ chọn) |

## 8b. Kết quả đo thực tế — 2026-10-01

Đã chạy toàn bộ trên máy này (RTX 3050 Laptop 35 W). Cờ A1/A2 đã được cài **mặc định tắt** trong
`pgd_clip.py` (`--eot-mode`, `--pool-size`) để đo; kết luận nằm dưới bảng.

### Bộ đo

- **Mô phỏng TikTok** (`tmp/tt-sim/tt.py`, scratch, không phải code sản phẩm): H.264 High, yuv420p,
  GOP 48 (~1,6 s), AAC 128k, faststart; ba rung: **1080p @ 3,1 Mbps**, **720p @ 1,9 Mbps**,
  **540p @ 1,15 Mbps**. Long side được chặn đúng như `server/harsh-scale.js` (bản đầu của tôi chặn sai
  chiều nên rung 720 không hạ độ phân giải; đã sửa và đo lại).
- **Chỉ số**: 17x16 dHash và 63-bit DCT pHash (port từ `server/perceptual-hash.js`) + CLIP ViT-B-32
  (laion2b) so từng khung 12 khung @3 fps, có căn thời gian theo hệ số retime khi clip đã qua Unique.
- **Vật liệu**: 1080x1920 30 fps 16,46 s (A/B), và 1080x1920 29,97 fps 213,7 s (đo thời gian).
- Nền so sánh: A = bản gốc sau sim, B = bản chúng ta upload sau sim. CLIP ~1,0 nghĩa là nền tảng vẫn
  coi hai bản là một; càng thấp càng khác.

### Sau khi qua sim TikTok — CLIP so với bản gốc (thấp hơn = tốt hơn)

| Bản upload | 1080p | 720p | 540p | dHash sau nén | pHash sau nén |
|---|---|---|---|---|---|
| gốc y nguyên (đối chứng) | ~1,000 | 0,9981 | 0,9961 | 6,6% / 2,7% | ~0,3% |
| Unique strong (không PGD) | 0,9307 | — | — | 91,8%* | 41,0% |
| Unique strong + PGD medium | 0,8862 | — | — | 91,0%* | 41,0% |
| PGD-only medium, EOT jpeg (hiện tại, pool 4) | 0,9516 / 0,9534 | 0,9576 / 0,9581 | 0,9606 / 0,9609 | 12,5% | 0,26% |
| PGD-only medium, EOT `mix` (pool 4) | 0,9425 / 0,9420 | 0,9510 / 0,9507 | 0,9569 / 0,9555 | 12,1% | 0,26% |
| PGD-only medium, pool 8 | 0,9429 | 0,9494 | 0,9492 | 12,1% | 0,26% |
| PGD-only medium, pool 2 | 0,9603 | 0,9690 | 0,9717 | 11,3% | 0,26% |
| **PGD-only strong, EOT jpeg** | **0,9048** | **0,9087** | **0,9168** | 13,7% | 0,26% |

\* dHash của nhóm Unique bị thổi lên vì đường tempo cong (một hệ số speed không căn lại được các mốc);
proxy của chính app (crf 30/720, căn theo speed) đọc 41,9% cho cùng clip.

### Điều thật sự có tác dụng

1. **Đổi PGD medium → strong (eps 6→10, 4→8 bước): +4,7 điểm CLIP** ở mọi rung, và **thời gian gần như
   bằng nhau** trên máy này (excerpt 60 s: medium 128,4 s vs strong 127,4 s; 16 s: 46,7 vs 45,4 s).
   Đây là đòn duy nhất vừa hiệu quả vừa miễn phí. (Không tăng `eps` — đây là tăng mức PGD, đúng như
   `PGD_LEVELS` đã định nghĩa.)
2. **EOT `mix` / pool 8: +0,7…1,0 điểm**, lặp lại được trên nền PGD-only (0,9516→0,9425; 0,9581→0,9507;
   0,9609→0,9555), nhưng **mất tác dụng khi đặt trên nền Unique** (0,8862 jpeg vs 0,8885 mix) → hiệu ứng
   nhỏ, phụ thuộc nền, không nên bật mặc định.
3. **pool 2 (tần số cao hơn): tệ hơn rõ** (0,9603 / 0,9690 / 0,9717) → xác nhận xu hướng "tần số càng
   thấp càng sống sót", nhưng phần lợi chỉ khoảng 1 điểm.
4. **Lớp Unique (hình học/màu/tempo) là thứ sống sót thật**: dHash 41,9% và pHash 34,9% sau proxy của
   app, tức mọi so khớp dựa trên hash gần như không còn trùng.
5. **PGD gần như không đụng tới pHash** (0,26% sau nén, so với 34,9% của lớp Unique) và chỉ thêm
   5–13 điểm dHash. Giá trị của PGD nằm ở so khớp embedding (CLIP) chứ không phải hash.
6. Sau khi nền tảng nén lại, phần "khác biệt" do PGD còn lại khoảng **60–72%** (strong giữ 72% khoảng
   cách CLIP ở rung 720, medium giữ ~60%).

### Thời gian cho một clip 5 phút (1080x1920, Unique strong + PGD)

| Giai đoạn | Đo thật (clip 213,7 s) | Suy ra cho 300 s |
|---|---|---|
| chuẩn bị (probe/hash) | 0,1 s | ~0,2 s |
| encode Unique (NVENC p6 constqp) | 309,1 s | ~7,2 phút |
| PGD (strong, batch 8, EOT 3) | 430,9 s | ~10,1 phút |
| metadata remux | 0,3 s | ~0,4 s |
| đo đạc (hash + seam + audio + CLIP + proxy) | 21,9 s | ~25 s |
| **tổng** | **762,4 s ≈ 12,7 phút** | **≈ 17,8 phút** |

Tốc độ đo được: PGD **~67–71 ms/khung** (≈ 2,0–2,1 s cho mỗi giây nguồn ở 30 fps), **không phụ thuộc
mức** medium/strong. Encode Unique phụ thuộc nội dung/nguồn: **0,85 s/giây nguồn** trên clip Brazil
16 s nhưng **1,45–1,64 s/giây nguồn** trên clip 213 s (cùng NVENC p6) → với 5 phút, encode nằm trong
khoảng **4,2–8,2 phút**. Vậy một clip 5 phút mất **~15–18 phút** khi bật PGD, và **~5–9 phút** khi chỉ
chạy Unique.

## 9. Rủi ro & câu hỏi mở

- Không biết dedup thật của nền tảng dùng gì, nên tối ưu trên proxy có thể lệch hướng.
- PGD sẽ chậm hơn khi thêm view/BPDA (hiện ~21 s cho clip 8 s ở mức medium trên RTX 3050 35 W).
- Kết quả phụ thuộc nội dung: phải đo trên ≥ 3 clip thật, cả 9:16 và 16:9, trước khi đổi mặc định.
- dHash 17x16 không nhìn thấy thay đổi trơn → đừng dùng nó làm thước đo duy nhất cho PGD.
- Câu hỏi mở: có cần sống sót ở rung 540p không? Có chấp nhận file upload to hơn (crf 16) không? Có
  muốn thêm rung đo cho YouTube (VP9/AV1) không?

## 10. Tham chiếu

- `PIPELINES.md` §1 (Unique), `CURRENT_STATE.md` (các mục 2026-10-01), `docs/unique-enhance-design.md`
- `pgd_clip.py`: `eot_stack`, `jpeg_ste`, `project_delta`, `midband_carrier`, `attack_batch`
- `server/harsh-scale.js`, `measureHarshProxy` / `measureUniqueOutput` trong `ghostforge-server.js`
- `remuxWithMetadata` (remux `-c copy`), `encoderAttempts` / `resolveEncoder`, `pgdEncoderArgs`
