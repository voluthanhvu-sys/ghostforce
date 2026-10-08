# Import video YouTube vào GhostForge

| | |
|---|---|
| Author | GhostForge design |
| Date | 2026-09-30 |
| Status | Draft |
| Scope | Design only. Không sửa source, test, hay handoff docs cho đến khi operator nói **thực hiện**. |

## Overview

GhostForge hôm nay nhận file video có sẵn trên máy rồi chạy Unique, Edit, hoặc Auto Reframe. Operator muốn dán một URL YouTube và nhận lại một file local, để file đó đứng trong hàng nguồn của tab đang mở — cùng hình dạng với file mà `POST /api/pick-videos` trả về. File tải về là **nguồn**, không phải output đã qua Unique, Edit, hay Reframe, và không bị gắn metadata giả của Unique.

Cách làm: một hộp **Tải từ YouTube** dùng chung cho ba tab xử lý, một module thuần kiểm tra URL trước khi gọi process, rồi `yt-dlp` chạy như subprocess (argument array, không qua shell). Job nằm trong registry sẵn có `server/jobs.js`. Tiến độ đi theo SSE hiện có. Khi xong, UI thêm một `QueueClip` có `localPath`. Edit và Reframe đã có `/api/edit/job-local` và `/api/reframe/job-local`. Unique thì chưa: `processOneFile` luôn upload `clip.file` qua multer (trần 500 MB). Vì vậy thiết kế có một lối vào mới `POST /api/unique/job-local` chỉ để trỏ `inputPath` vào file đã tải; stream, filter, encoder, và semantics của Unique giữ nguyên.

## Background & Motivation

App là React/Vite cộng một Express, chỉ phục vụ máy của operator. `launch.mjs` listen `127.0.0.1`. Middleware đầu `ghostforge-server.js` từ chối host khác `localhost` / `127.0.0.1` / `[::1]` và từ chối origin lệch (khoảng dòng 33–39). Ba pipeline nguồn đều kết thúc ở một file local:

- Unique: `files` trong `src/ghostforge-app.tsx`. Nguồn browser đi `POST /api/upload` rồi `GET /api/stream/:jobId`.
- Edit: `editFiles`. Có `localPath` thì `POST /api/edit/job-local`, không thì multipart `POST /api/edit/job`, rồi `GET /api/edit/stream/:jobId`.
- Reframe: `reframeFiles`, cùng kiểu với `POST /api/reframe/job-local` hoặc `POST /api/reframe/job`.

`POST /api/pick-videos` (khoảng dòng 1989) mở dialog Windows và trả:

```json
{ "files": [{ "name": "clip.mp4", "path": "D:\\Tiktok\\...\\clip.mp4", "folder": "D:\\Tiktok\\...", "size": 12345 }] }
```

Edit (`pickEditFromPc`, khoảng dòng 624) và Reframe (`pickReframeFromPc`, khoảng dòng 1405) biến từng phần tử thành `QueueClip`: `file` là `new File([], name)`, `localPath` là `path`, `fileSize` là `size`, `outFolder` là `folder`. Unique không có nút này. `processOneFile` (khoảng dòng 1734) luôn `formData.append('video', clip.file)`.

`GET /api/download/:jobId` (khoảng dòng 1876) là tải **output đã xử lý**. Route import không được đụng tên đó.

Điểm đau: muốn đưa một video YouTube vào Edit/Unique thì operator phải tải bằng công cụ khác, rồi pick lại. Làm downloader công khai, rip cả playlist, hoặc sửa lớp Unique/PGD không giải quyết việc đó và nằm ngoài phạm vi sản phẩm.

### Việc nguồn code khác với giả định ban đầu

Các điểm sau lấy từ code hiện tại, không từ giả định:

1. **Không có job map thứ hai.** `ghostforge-server.js` import `{ jobs, subscribeJob, jobSignal, abortJob, ensureAbort }` từ `server/jobs.js`. `PIPELINES.md` mục 4 nói cùng một registry cho cả ba pipeline. Import YouTube phải dùng map này.
2. **`runProcess` chưa chạy được một lần tải dài.** `server/process.js` `spawn` rồi gom hết stdout/stderr, resolve khi process thoát. Không có callback dòng, không trả child. `encoding` không phải option của `spawn` và bị Node bỏ qua. `timeout` thì **không** thuộc nhóm đó: trên Node v24 trong môi trường này, `spawn` tôn trọng `timeout` và giết đúng process con trực tiếp bằng `SIGTERM`. `runProcess` chuyển nguyên `options` vào `spawn`, nên các timeout hiện có là thật: probe PGD `timeout: 30000` (khoảng dòng 983), dialog file Windows `timeout: 180000` (khoảng dòng 2009 và 2076), `runGcloud` `timeout: 25000` (khoảng dòng 3536). PR sau không được gỡ `timeout` khỏi helper dùng chung. Timer đó chỉ `SIGTERM` một pid, không giết process cháu, nên import YouTube vẫn cần giết cả cây khi hủy — và **không** truyền `timeout` vào lần spawn `yt-dlp`. FFmpeg encode dài không đi qua `runProcess`: Unique `spawn('ffmpeg', …)` và gán `job.ffmpeg` (khoảng dòng 1623–1625) để `abortJob` `kill('SIGKILL')`. `runProcess` hôm nay dùng cho dialog PowerShell, `gcloud`, và probe Python PGD.
3. **`abortJob` không giết process group.** `server/jobs.js` chỉ `job.ffmpeg.kill('SIGKILL')` và `AbortController.abort()`. Trên Windows `kill` không giết process con. `yt-dlp` sẽ spawn `ffmpeg` để merge. Cancel phải opt-in giết cả cây, và **không** đổi cách giết FFmpeg của Unique/Edit/Reframe.
4. **`GET /api/stream/:jobId` tự chạy Unique** với mọi job không phải `kind === 'edit' | 'reframe'` (khoảng dòng 1070–1078). Job import nếu không có `kind` riêng và một nhánh từ chối sẽ bị encode Unique nhầm.
5. **Unique không đọc `localPath`.** File YouTube nằm trên đĩa server. Browser không biến `D:\…` thành `File` thật. Upload lại qua multer còn bị trần `limits: { fileSize: 1024 * 1024 * 500 }` (dòng 49). Một bản 1080p dài có thể vượt 500 MB dù vẫn dưới trần import. Lối `job-local` là bắt buộc nếu tab Unique dùng được file vừa tải.
6. **`ffmpeg` đã là phụ thuộc cứng**, tìm bằng `spawnSync('ffmpeg')` và `where`/`which` (`probeEncoderCaps`, khoảng dòng 150–158). Không có `GHOSTFORGE_FFMPEG` trong `ghostforge-server.js`. `GHOSTFORGE_FFPROBE` chỉ nằm ở `server/tiktok-trends.js`. `pgdPython()` trỏ `.venv` của PGD nếu có — **không** dùng venv đó để tìm `yt-dlp`.

## Goals & Non-Goals

### Goals

- Dán **một** URL video, nhận một file local, thêm vào hàng của tab đã chọn lúc bấm Tải (Unique, Edit, hoặc Reframe).
- Chỉ host trong allowlist. Từ chối host khác **trước** khi spawn `yt-dlp`.
- Playlist, kênh, trang search: từ chối bằng lỗi tiếng Việt. `watch?v=…&list=…` vẫn là một video: lấy đúng video đó, `--no-playlist`.
- Tải hủy được. Hủy giết cả cây process, xóa file dở.
- Một import tại một thời điểm.
- Trần thời lượng và dung lượng là hằng số.
- File ra là mp4 mà pipeline hiện tại mở được. Không re-encode để “làm sạch”, không spoof metadata Unique.
- `npm test` không mạng, không tải `yt-dlp`.
- UI mới tiếng Việt. Một dòng nói operator tự chịu trách nhiệm quyền tải.

### Non-Goals

- Website tải công khai, proxy, link chia sẻ, stream media YouTube ra mạng.
- Hàng đợi nhiều URL, cả kênh, search, bulk.
- Đọc cookie trình duyệt, cào tài khoản, `--cookies-from-browser`.
- Vượt DRM, trích signature, né bot. YouTube chặn thì báo lỗi và dừng.
- Sửa filter, prompt, encoder, PGD, `pgd_clip.py`, hoặc semantics job của Unique / Edit / Reframe.
- Tab thứ tư, và không gắn tính năng này vào tab Xu hướng.
- Tự `pip install` trong request.
- Copy file nguồn vào thư mục save đã persist. Thư mục đó là chỗ export output (`/api/export-copy`, `server/save-dir.js`).

## Proposed Design

### Sơ đồ

```mermaid
flowchart LR
  UI["YoutubeImportBox\nTải từ YouTube"]
  Pure["server/youtube-url.js\nallowlist + video id"]
  Routes["ghostforge-server.js\n/api/youtube-import/*"]
  Orch["server/youtube-import.js"]
  Jobs["server/jobs.js\njobs Map + SSE"]
  Proc["server/process.js\nrunProcess + kill tree"]
  Yt["yt-dlp subprocess"]
  Disk["uploads/youtube-import/jobId/"]
  List["files | editFiles | reframeFiles"]

  UI --> Pure
  UI --> Routes
  Routes --> Pure
  Routes --> Orch
  Orch --> Jobs
  Orch --> Proc
  Proc --> Yt
  Yt --> Disk
  Jobs --> UI
  UI --> List
```

```mermaid
sequenceDiagram
  participant Op as Operator
  participant UI as YoutubeImportBox
  participant API as Express
  participant Pure as youtube-url.js
  participant Job as jobs Map
  participant YT as yt-dlp
  participant Tab as Hàng nguồn tab đã chọn

  Op->>UI: Dán URL, bấm Tải từ YouTube
  UI->>API: POST url, quality, tab
  API->>Pure: parseYoutubeUrl
  alt URL hỏng, sai host, playlist, not_video, tab hoặc quality sai
    API-->>UI: 400, chưa đụng slot
  else Slot đang trỏ job sống
    API-->>UI: 409
  else Hợp lệ, slot trống
    Note over API,Job: Giữ activeYoutubeJobId đồng bộ, trước mọi await
    API->>Job: kind youtube-import, pending, targetTab
    API->>API: probe --version bất đồng bộ, timeout 8s
    alt Thiếu yt-dlp hoặc ffmpeg
      API->>Job: xóa record, nhả slot nếu vẫn đúng id
      API-->>UI: 400, không 201, không SSE
    else Tool sẵn
      API-->>UI: 201 jobId, videoId, canonicalUrl, targetTab
      UI->>API: EventSource /api/youtube-import/stream/:jobId
      API->>Job: subscribeJob, không spawn lần hai nếu đã có streamState
      API->>YT: dump-single-json, onSpawn gán job.ffmpeg, không timeout
      YT-->>API: duration, live_status, title
      alt cancelled, quá dài, live, private, age, region
        API->>Job: error SSE, xóa thư mục, không done
      else Trong trần
        API->>YT: download, onSpawn, format selector, newline, không timeout
        YT-->>API: dòng đã qua consumeProcessText
        API-->>UI: type progress value, phase, etaMs
        YT-->>API: mp4
        API->>API: probeImportedFile qua onSpawn, đổi tên đã sanitize
        API-->>UI: type done, file giống pick-videos, targetTab
        UI->>Tab: append QueueClip localPath, source youtube
      end
    end
  end
  Note over UI,Tab: Success bỏ dòng ở cả ba tab. DELETE import chỉ sau Unique hoặc Reframe. Edit success giữ dir vì part replay còn mở sourcePath.
```

### UI

Một component `src/components/YoutubeImportBox.tsx`, **luôn mounted** ngay dưới dải tab trong `src/ghostforge-app.tsx` (sau cụm nút Unique / Edit / Reframe / Xu hướng, trước panel `appTab === 'unique'`). Không nhét vào trong `{appTab === 'unique' && …}`: panel đó unmount khi đổi tab và sẽ mất `EventSource`.

Không thêm giá trị `AppTab`. `src/types.ts` giữ `'unique' | 'edit' | 'reframe' | 'trends'`.

Tab Xu hướng: khi không có import đang chạy thì component render rỗng. Khi đang chạy thì chỉ còn thanh tiến độ và nút Hủy, vì file không bao giờ được thêm vào Trends. Trends vẫn chỉ gọi `/api/trends*`.

Hành vi control:

- Chưa có `yt-dlp` hoặc chưa có `ffmpeg`: **ẩn** ô URL, select chất lượng, và nút Tải. Hiện một dòng lý do và nút **Kiểm tra lại** (`GET /api/youtube-import/status?fresh=1`). Control vô nghĩa thì không để operator bấm rồi mới fail.
- Đủ tool: ô URL, select chất lượng, nút **Tải từ YouTube**.
- Dòng chữ nhỏ, luôn thấy khi form hiện: `Chỉ tải video bạn có quyền tải và xử lý. GhostForge không đăng nhập YouTube hộ bạn.`
- Placeholder: `Dán link một video YouTube`.
- Select **Chất lượng**: `1080p (mặc định)` value `1080`, và `Tốt nhất` value `best`. Hai mức là đủ. Không slider.
- Đang tải: khóa ô URL và select, ẩn nút Tải, hiện **Hủy**, thanh phần trăm, phase, ETA nếu có. Không ghi đè `progress` / `progressEtaMs` của Unique hay thanh Edit/Reframe.
- Lúc bấm Tải, nhớ `appTab` vào `targetTab` và gửi kèm `tab` trong `POST` để server giữ (reload mất state React). Đổi tab giữa chừng không đổi nơi file sẽ rơi. `tab` chỉ được `unique`, `edit`, hoặc `reframe`. Trends không gọi API.
- **Mount lại hộp:** mỗi lần component mount, `GET /api/youtube-import/status`. Nếu `busy` và `active.jobId` có giá trị, khôi phục `jobId`, hiện nút **Hủy**, và mở lại `EventSource` tới `/api/youtube-import/stream/:jobId`. `subscribeJob` phát lại history nếu `streamState` còn sống, và không spawn lần hai. Hủy gọi `POST /api/cancel/:jobId` với đúng id đó — không thêm route cancel. Không có bước này thì đóng tab để yt-dlp chạy tiếp và lần Tải sau bị 409 đến hết lượt (tối đa 2 giờ). `targetTab` lấy từ `active.targetTab` trên status, không từ tab operator đang đứng sau reload.

Ba hàng nguồn **không** dùng chung một state:

| Tab | State | Ref phải ghi khi append | Pipeline sau đó đọc path thế nào |
|---|---|---|---|
| Unique | `files` / `setFiles` | `filesRef` được gán mỗi render (`filesRef.current = files`) | Hôm nay **không** đọc `localPath`. Cần nhánh mới, xem dưới. `startProcessing` chụp `ids` lúc bấm Start, nên clip thêm trong lúc Unique đang chạy **không** tự vào lượt đó. |
| Edit | `editFiles` / `setEditFiles` | Gán `editFilesRef.current` **trong** setter, giống `pickEditFromPc` | `runOneEdit` đã gọi `/api/edit/job-local` khi có `localPath`. Vòng `startEdit` đọc ref mỗi clip, nên clip tới trong lúc Edit chạy vẫn được xếp sau. |
| Reframe | `reframeFiles` / `setReframeFiles` | Gán `reframeFilesRef.current` trong setter, giống `pickReframeFromPc` | `runOneReframe` đã gọi `/api/reframe/job-local`. |

Append một `QueueClip` cùng hình với pick từ PC, cộng hai field optional trong `src/types.ts`:

```ts
export interface QueueClip {
  id: string;
  file: File;
  name: string;
  originalName: string;
  outFolder?: string;
  localPath?: string;
  fileSize?: number;
  source?: 'pc' | 'youtube';
  youtubeJobId?: string;
}
```

`source` và `youtubeJobId` optional để clip cũ không đổi. Clip YouTube:

- `file`: `new File([], name, { type: 'video/mp4' })` — rỗng, chỉ để thỏa type. Không được upload blob này.
- `name`: `safeFileName` từ `src/lib/files.ts`.
- `originalName`: `file.name` server trả.
- `localPath`: `file.path`.
- `fileSize`: `file.size`.
- `source`: `'youtube'`.
- `youtubeJobId`: job import, không phải job Unique/Edit/Reframe sau này.
- `outFolder`: **không** lấy `file.folder`. Folder đó là `uploads/youtube-import/<jobId>/`. Edit auto-save vào đó sẽ trộn output với nguồn và có thể bị xóa theo nguồn. Dùng `osSavePath` nếu operator đã chọn thư mục save; nếu trống thì để `undefined` (Edit đã chịu được “no folder”).

Dedupe theo `localPath` đúng như pick từ PC. Trùng path thì log `[YT] Video này đã có trong hàng.` và không thêm dòng.

Dòng Unique hôm nay hiện `formatBytes(clip.file.size)` (khoảng dòng 2515), sẽ ra `0 Bytes` với `File` rỗng. Chỉ đổi dòng đó thành `formatBytes(clip.fileSize || clip.file.size)`. Edit **đã** hiện `formatBytes(clip.fileSize || clip.file.size)` (khoảng dòng 3604), nên clip YouTube có `fileSize` hiện đúng, không sửa. Hàng Reframe không hiện size; v1 không thêm.

Nút X trên dòng `source === 'youtube'` khi clip **không** đang bị pipeline mở để đọc:

- Gọi `DELETE /api/youtube-import/:youtubeJobId` rồi mới xóa khỏi state.
- Chỉ DELETE theo job id do server đã phát. Không gửi path thô.
- File pick từ PC (`source` trống hoặc `'pc'`) **không** bị xóa đĩa. Đó là file của operator.
- Nếu đúng clip đó đang là job Unique/Edit/Reframe còn chạy, không DELETE giữa chừng (Unique đã khóa X lúc `isProcessing`). Hủy pipeline trước, hoặc đợi job xong.

**Cả ba hàng đều bỏ clip khi chạy xong**, không chỉ Unique. `startEdit` lọc `setEditFiles` sau một lần cắt thành công (khoảng dòng 1022–1026) và log `Removed … from waiting queue`. `startReframe` làm cùng việc (khoảng dòng 1584–1588). Nhánh lỗi hoặc hủy thì **giữ** clip (`Keeping this clip in queue`). Sau success, nút X và `youtubeJobId` trên hàng không còn.

Chính sách v1: không thêm hàng lịch sử import. Sau khi pipeline đã đóng file nguồn:

- **Unique và Reframe:** nếu `source === 'youtube'` và có `youtubeJobId`, gọi `DELETE /api/youtube-import/:youtubeJobId`. Output là file khác, không phải bản tải.
- **Edit: không gọi DELETE.** Giữ nguyên `uploads/youtube-import/<jobId>/`. Lần cắt xong ghi `uploads/edit-part-test-history.json` với `sourcePath: path.resolve(job.inputPath)` khi `completedWholeRun` (`ghostforge-server.js` khoảng dòng 5102–5108). Mỗi part còn `jobs.set` `kind: 'edit-part'`, `inputPath: job.inputPath`, `keepInput: true` (khoảng dòng 5073–5078), kể cả lần không ghi history (Test 1 phút, khoảng part). `POST /api/edit/part-test` mở path đó và trả 404 `Original landscape source no longer exists` nếu file mất (khoảng dòng 5218–5236). Panel history hiện `nguồn gốc không còn tồn tại` và tắt Test lại khi `sourceAvailable` false (khoảng dòng 4171–4181). Nút Test lại Part (khoảng dòng 4291–4301) cắt lại từ video nguồn ngang gốc. Xóa dir lúc Edit success làm chết replay trong cùng phiên và đổi semantics Edit, trái non-goal. File pick từ PC không bị xóa, nên replay hôm nay chạy được. Chi phí đĩa của một nguồn Edit bằng dir mồ côi đã chấp nhận khi lỡ `done`. Không sweep `uploads/youtube-import/` lúc boot — history JSON sống qua restart và trỏ path tuyệt đối vào dir đó.

Fail hoặc cancel giữ dòng và giữ file để chạy lại; X trên dòng đó vẫn DELETE. Xóa tay thư mục, hoặc bấm X, chỉ khi operator không còn Test lại lần Edit đó. `DELETE /api/job/:jobId` của job Unique/Edit/Reframe vẫn không đụng nguồn vì `keepInput` — đó là route khác với DELETE import. Không copy sang save dir.

Log UI prefix `[YT]`. Ví dụ: `[YT] Đã thêm <name> vào hàng Edit.`

Ô import **không** nằm trong div Unique bị `pointer-events-none` khi `isProcessing`, để có thể tải trong lúc Unique chạy. File mới chờ lần Start sau.

### Module thuần `server/youtube-url.js`

Không `fs`, không `spawn`, không mạng. `npm test` import file này.

```js
export const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

export const YOUTUBE_MAX_DURATION_SEC = 7200;
export const YOUTUBE_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;
export const YOUTUBE_DEFAULT_QUALITY = '1080';

export const YOUTUBE_FORMATS = {
  '1080': 'bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[acodec^=mp4a]/bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][height<=1080][ext=mp4]/bv*[height<=1080]+ba[acodec^=mp4a]/b[height<=1080][ext=mp4]',
  best: 'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]/bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][ext=mp4]/bv*+ba/b',
};

export function parseYoutubeUrl(raw) {}
export function formatSelector(quality) {}
export function parseYtDlpProgressLine(line) {}
export function consumeProcessText(pending, chunk) {}
export function playlistSlip(line) {}
export function classifyYtDlpFailure(text) {}
export function sanitizeImportFileName(title, videoId) {}
export function ytDlpMaxFilesizeArg(bytes) {}
export function redactLogLine(line) {}
export function isInsideDir(root, candidate) {}
```

`parseYoutubeUrl` dùng `new URL`, không regex trên cả chuỗi:

1. Trim. Rỗng hoặc `URL` ném lỗi → `{ ok: false, code: 'bad_url' }`.
2. `username` hoặc `password` khác rỗng → `bad_url` (chặn `https://user:pass@youtube.com/...`).
3. Protocol chỉ `http:` hoặc `https:`. Khác (`javascript:`, `file:`, `ftp:`) → `bad_url`.
4. Hostname: lower case, bỏ dấu chấm cuối. Không nằm trong `YOUTUBE_HOSTS` → `host`. So khớp **cả host**, không phải `includes('youtube.com')`, nên `youtube.com.evil.example` và `notyoutube.com` đều rơi.
5. Không có video id 11 ký tự thì mỗi dạng một mã, không để người viết chọn:
   - path `/playlist`, hoặc query `list` mà không có video id → `playlist`.
   - path `/channel`, `/c/`, `/user/`, `/feed`, `/results`, `/hashtag`, hoặc segment đầu `@…` → `not_video`. Kể cả `https://www.youtube.com/channel/UC…` không có `list`.
6. Có video id **và** có `list` (link share “video trong playlist”) → **chấp nhận** một video. Canonical không mang `list`. Path `/playlist` vẫn là `playlist` dù query có lẫn một id.
7. Video id là đúng 11 ký tự `[A-Za-z0-9_-]`, lấy từ:
   - `youtu.be`: một segment path.
   - `watch`: `searchParams.get('v')` (giá trị đầu).
   - `/embed/<id>`, `/shorts/<id>`, `/live/<id>`, `/v/<id>`, kể cả host `www.youtube-nocookie.com` và `music.youtube.com`.
8. Thành công:

```js
{ ok: true, videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` }
```

Mọi nhánh spawn chỉ nhận `canonicalUrl` do ta dựng, không nhận chuỗi operator dán. `t=`, `feature=`, `si=`, `list=` không đi vào process.

`formatSelector('1080' | 'best')` trả đúng chuỗi trong `YOUTUBE_FORMATS`. Khác → `null`.

Ý selector `1080`, theo thứ tự yt-dlp:

1. Video H.264 (`avc1`) trong mp4, cao tối đa 1080, cộng audio AAC (`mp4a`).
2. Cùng codec nhưng không buộc ext video.
3. Một file progressive H.264 mp4 ≤ 1080.
4. Video bất kỳ ≤ 1080 cộng AAC.
5. Một file progressive mp4 ≤ 1080.

Không có `height<=?1080` (dấu `?` của yt-dlp nghĩa là “nới trần nếu không có”). Trần 1080 là cứng với quality mặc định. `best` bỏ trần cao, vẫn ưu tiên H.264+AAC, và chỉ ở nhánh cuối mới nhận codec khác (`bv*+ba/b`) để video chỉ có VP9/AV1 vẫn tải được. Không `--recode-video`. Không encode lại nguồn. Ghép/remux sang mp4 bằng ffmpeg mà yt-dlp tự gọi. Codec không vào được mp4 thì job fail, không âm thầm re-encode.

`consumeProcessText(pending, chunk)` ghép `pending` với chunk mới, bỏ ANSI trên buffer, tách bằng `\n` hoặc `\r\n`, trả `{ lines, pending }`. `pending` là đoạn cuối **chưa** có newline, giữ cho chunk sau. Không parse trên chunk dở. `parseYtDlpProgressLine` chỉ nhận một dòng đã hoàn chỉnh, ANSI đã bỏ:

`playlistSlip(line)` khớp cả `Downloading item <n> of <m>` và `Downloading video <n> of <m>` (yt-dlp hiện in `item`). `m > 1` thì là slip. Không khớp → `null`.

`classifyYtDlpFailure` chỉ chạy **một lần** trên cả stderr lúc process thoát, không chạy trên từng chunk.

- `[download]  45.2% of ~12.34MiB at 1.23MiB/s ETA 00:08` → `{ phase: 'download', value: 45.2, etaMs: 8000 }`.
- ETA `HH:MM:SS` hoặc `MM:SS`. `ETA Unknown` hoặc không có ETA → không có `etaMs`.
- `[Merger] Merging formats into …` hoặc `[VideoRemuxer]` → `{ phase: 'merge', value: 100 }` không ETA.
- Dòng khác → `null`. UI không bịa phần trăm.

`classifyYtDlpFailure(stderr)` trả `{ code, message }` tiếng Việt. Bảng message nằm ở mục Failure modes. Hàm này thuần, test bằng chuỗi giả, không gọi yt-dlp.

`sanitizeImportFileName(title, videoId)`:

- Chuẩn hóa NFKC, thay ký tự cấm Windows `<>:"/\|?*` và control bằng dấu cách, gộp khoảng trắng, cắt stem 80 ký tự.
- Giữ chữ Việt. Không ASCII-hóa.
- Stem rỗng → dùng `videoId`.
- Kết quả: `<stem> [<videoId>].mp4`. Không có bước xóa chuỗi `..`: `foo..bar` vẫn hợp lệ trong tên file một khi dấu slash đã bị bỏ. Tên luôn có hậu tố ` [<videoId>].mp4`, rồi `path.basename` trước `path.join(jobDir, name)`. Chặn thoát thư mục là `isInsideDir`, không phải sanitizer.

`redactLogLine`:

- Xóa mọi `https?://…`.
- Xóa query string còn sót.
- Không để nguyên URL googlevideo (có chữ ký).
- Giữ `videoId` nếu caller truyền riêng, không parse lại từ URL đã xóa.
- Cắt 180 ký tự.

`isInsideDir(root, candidate)` dùng `path.relative(path.resolve(root), path.resolve(candidate))`. Từ chối relative bắt đầu bằng `..` hoặc absolute. Trên Windows, `path.relative` không phân biệt hoa thường; test Linux chỉ cần chặn `..`. Không tự viết so sánh chuỗi prefix (dễ sai với `uploads/youtube-import-evil`).

### Job, SSE, và chỗ đặt orchestration

`server/youtube-import.js` export `createYoutubeImport({ uploadsDir, jobs, subscribeJob, runProcess })` và `uniqueStreamBlock(job)`. `ghostforge-server.js` chỉ đăng ký route và truyền dependency. Không import ngược `ghostforge-server.js`. Không gọi `probeMedia` của Unique cho file import: hàm đó `spawn('ffmpeg')` và không gán `job.ffmpeg` (khoảng dòng 233). Import dùng wrapper riêng `probeImportedFile`, mô tả ở mục tiến độ.

Route string nằm **trong** `ghostforge-server.js` để `scripts/validate-handoff.mjs` còn thấy nếu sau này thêm vào `documentedRoutes`.

Vòng đời giống Edit: `POST` chỉ validate và tạo job `pending`; `GET` stream mới chạy việc, vì `subscribeJob` bắt đầu history đúng lúc client nối. Client mở `EventSource` ngay sau 201.

Job:

```js
jobs.set(jobId, {
  kind: 'youtube-import',
  status: 'pending',
  videoId,
  canonicalUrl,
  quality,
  targetTab,
  createdAt: Date.now(),
  killTree: true,
  importDir: null,
});
```

`jobId` = `crypto.randomBytes(16).toString('hex')`, cùng kiểu `job-local` của Edit. Không lấy từ tên file operator. `targetTab` là `unique` | `edit` | `reframe` từ body, đã kiểm trước khi giữ slot.

`GET /api/stream/:jobId` gọi helper này **trước** mọi encode, rồi return:

```js
export function uniqueStreamBlock(job) {
  if (!job) return { status: 404 };
  if (job.kind === 'edit') return { status: 400, error: 'Use /api/edit/stream for edit jobs' };
  if (job.kind === 'reframe') return { status: 400, error: 'Use /api/reframe/stream for reframe jobs' };
  if (job.kind === 'youtube-import') {
    return { status: 400, error: 'Use /api/youtube-import/stream for YouTube import jobs' };
  }
  return null;
}
```

Nhánh `edit` và `reframe` giữ nguyên câu lỗi đang có. Job thường của Unique không có `kind` → `null` → stream cũ chạy. Không sửa thân encode.

`/api/edit/stream` và `/api/reframe/stream` đã đòi đúng `kind`, nên job import rơi 404 ở đó. Không sửa thân stream Unique.

SSE dùng đúng `subscribeJob`: body `data: {"type":"…", …}\n\n`, không dùng event name riêng của SSE. UI đọc `data.type` như Edit/Unique. Type: `log`, `progress`, `done`, `error`. History và reconnect giữ nguyên (tối đa 2000 chunk trong `subscribeJob`).

`POST /api/cancel/:jobId` **giữ nguyên**. Nó đã `abortJob(job)` cho mọi job trong map. Không thêm route cancel mới.

Khi stream bắt đầu mà `job.cancelled` đã true (operator hủy trước khi EventSource kịp nối): không spawn, phát error `cancelled`, xóa dir nếu đã tạo, nhả slot.

Slot là một biến module `activeYoutubeJobId`. Giữ slot **đồng bộ, trước mọi `await`** trong `POST`:

1. Parse URL, `quality`, và `tab` — toàn bộ đồng bộ. Sai thì 400, chưa đụng slot.
2. Nếu slot đang trỏ một job `status === 'pending'`, chưa có `streamState`, và `Date.now() - createdAt > 120_000`: reap **trong cùng request** (xóa record, `fs.rm` dir nếu đã có, gán `activeYoutubeJobId = null`), rồi đi tiếp với URL mới. Không trả về sau mỗi reap. Job đã có `streamState` hoặc đang `running` không bị reap — operator hủy bằng id trên status.
3. Nếu `activeYoutubeJobId` vẫn khác null → 409, không tạo job.
4. Sinh `jobId`, gán `activeYoutubeJobId = jobId`, `jobs.set` — vẫn chưa `await`.
5. Từ đây mới được `await` (probe tool). Probe fail thì xóa job vừa tạo và nhả slot **chỉ khi** `activeYoutubeJobId === jobId`, rồi 400.

Hai `POST` chồng nhau không cùng thấy slot trống, vì bước 3–4 không có điểm `await` ở giữa. `finally` của stream (done, error, cancel) chỉ làm `if (activeYoutubeJobId === jobId) activeYoutubeJobId = null`. `finally` của job cũ không được xóa slot của job mới.

Đóng tab không abort: `subscribeJob` chỉ gỡ client SSE. yt-dlp chạy tiếp. Status phải trả id để UI mount lại mà Hủy được (mục UI và `GET /api/youtube-import/status`). Không có client nào cần đợi hết 2 giờ chỉ vì quên id.

### Resolver: yt-dlp

Chỉ `yt-dlp`. Không YouTube Data API: API đó trả metadata, không trả file media, và thêm quota/key không cần. Không Invidious/Piped: thêm một dịch vụ bên thứ ba dễ chết, dễ lệch format, và biến app localhost thành client của proxy người khác. `yt-dlp` là subprocess trên máy operator, cùng kiểu app đã chạy ffmpeg/Python.

Không tự cài. Không sửa extractor. Không `--extractor-args` để đổi player client. Không `--cookies-from-browser`.

Probe thông tin (trong job, phase `info`, `progress` value 0, không `etaMs`):

```text
<yt-dlp argv prefix> --dump-single-json --skip-download --no-playlist --no-colors -f <selector> https://www.youtube.com/watch?v=<id>
```

Stdout phải là một object JSON, không phải playlist (`_type !== 'playlist'`). Không log stdout. Đọc:

- `id` phải bằng `videoId` đã parse. Lệch → `id_mismatch`, không tải.
- `live_status`: `is_live`, `is_upcoming`, `post_live` → `live`. `was_live` (live đã thành VOD) và `not_live` được đi tiếp nếu `duration` là số hữu hạn.
- `duration` thiếu hoặc không hữu hạn → `unknown_duration`. `duration > YOUTUBE_MAX_DURATION_SEC` → `too_long`.
- `availability`: `private` → `private`; `needs_auth` → `age`; `premium_only` hoặc `subscriber_only` → `members`. `public` và `unlisted` được (operator có URL).
- Ước lượng byte: cộng `filesize` hoặc `filesize_approx` của `requested_formats`, không có thì lấy của format đã chọn. Biết chắc và lớn hơn `YOUTUBE_MAX_FILE_BYTES` → `too_big` trước khi tải. Không biết size thì vẫn tải. Trần lúc tải là **tổng** size các file thường trong `jobDir` (video và audio tách nhau có thể mỗi file dưới trần nhưng cộng lại và bản mp4 sau merge thì vượt). Không dùng “file lớn nhất”. `--max-filesize` lấy từ cùng hằng số, xem argv.

Tải:

```js
const args = [
  ...tool.prefixArgs,
  '--no-playlist',
  '--newline',
  '--no-colors',
  '-f', selector,
  '--merge-output-format', 'mp4',
  '--remux-video', 'mp4',
  '--max-filesize', ytDlpMaxFilesizeArg(YOUTUBE_MAX_FILE_BYTES),
  '--retries', '2',
  '--fragment-retries', '2',
  '--socket-timeout', '20',
  '--no-mtime',
  '--no-write-subs',
  '--no-write-auto-subs',
  '--no-embed-subs',
  '-o', path.join(jobDir, '%(id)s.%(ext)s'),
  '--ffmpeg-location', ffmpegLocation,
  canonicalUrl,
];
```

`canonicalUrl` là argument cuối, một phần tử argv. `shell` không được true. Không ghép chuỗi lệnh.

`-o` chỉ dùng `%(id)s` và `%(ext)s`. Title không đi vào template của yt-dlp (tránh ký tự lạ và log đường dẫn dài). Đổi tên sang `sanitizeImportFileName` **sau** khi probe ffmpeg thành công, vẫn trong cùng `jobDir`.

Mỗi chunk stdout/stderr đi qua `consumeProcessText`. Chỉ dòng đã đủ newline mới vào `parseYtDlpProgressLine` và `playlistSlip`. `playlistSlip` với `m > 1` → kill tree, `playlist_slip`, không đợi hết file. `--no-playlist` là lớp trong yt-dlp; đây là lớp chặn thêm. `classifyYtDlpFailure` nhận chuỗi stderr đã gom lúc thoát, không nhận chunk lẻ.

Không `--embed-metadata`, không gọi `generateRealisticMetadata`, không `remuxWithMetadata`. Metadata container mà yt-dlp để lại mặc định là của nguồn. Unique sẽ tự gắn profile thiết bị **sau này**, trên output của nó, không trên file import.

### Tiến độ và hủy

`runProcess` được mở rộng tương thích ngược. Caller cũ (PowerShell, gcloud, probe PGD) không truyền hooks thì hành vi cũ: gom stdout/stderr, resolve `{ status, stdout, stderr, error }`.

```js
export function runProcess(command, args, options = {}, hooks = {}) {
  const { onSpawn, onStdout, onStderr } = hooks;
  const spawnOpts = { ...options };
  // hooks không được đưa vào spawn
  const child = spawn(command, args, spawnOpts);
  onSpawn?.(child);
  // ...
}
```

Mọi child của job import — `yt-dlp --dump-single-json`, `yt-dlp` tải, và ffmpeg của `probeImportedFile` — đều gọi `onSpawn` để gán `job.ffmpeg = child` (cùng field `abortJob` đã biết, không thêm field song song). Lúc child `close` hoặc `error`, gán `job.ffmpeg = null`. Probe JSON vẫn **gom** stdout để `JSON.parse`; gom buffer không thay `onSpawn`. Không truyền `timeout` vào các spawn này: timer của Node chỉ `SIGTERM` đúng pid đó, không `taskkill /T`, nên hủy phải đi `abortJob`. Trần thời gian nếu sau này cần thì handler gọi `abortJob`, không mượn `timeout` của `spawn`.

`options` của caller cũ được spread nguyên vào `spawn`, **kể cả `timeout`**. Không lọc bỏ `timeout` trong helper. `encoding` vẫn không phải option của `spawn`; đừng “sửa” bằng cách nuốt luôn `timeout`.

Sau **mỗi** child thoát, trước khi sang phase sau (tải, probe file, `done`): nếu `job.cancelled` thì xóa `importDir`, `send('error', { message: 'Đã hủy tải từ YouTube.', code: 'cancelled' })`, không tải tiếp, không `done`. Kiểm tra “cancelled lúc stream vừa mở” không phủ cửa sổ đang chờ `--dump-single-json`.

`probeImportedFile(file, job)` nằm trong `server/youtube-import.js`. Nó spawn `ffmpeg -hide_banner -i <file>` qua `runProcess` + `onSpawn`, parse duration/codec cùng quy tắc `probeMedia` (có stream video, `durationSec >= 0.5`, rộng và cao `>= 64`). Không gọi `probeMedia` trực tiếp. Không đổi chữ ký `probeMedia` của Unique.

POSIX: `detached: true` để child là group leader, **không** `unref`. Windows: không `detached` (tránh console mới); `windowsHide: true`.

`server/process.js` thêm:

```js
export function planChildKill(job) {
  const pid = job?.ffmpeg?.pid;
  if (!pid) return { mode: 'none' };
  if (job.killTree) return { mode: 'tree', pid };
  return { mode: 'signal', pid };
}

export function killProcessTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { process.kill(pid, 'SIGKILL'); } catch { /* đã thoát */ } }
}
```

`abortJob`:

```js
export function abortJob(job) {
  if (!job) return;
  job.cancelled = true;
  try { ensureAbort(job).abort(); } catch {}
  const plan = planChildKill(job);
  if (plan.mode === 'tree') killProcessTree(plan.pid);
  else if (plan.mode === 'signal') {
    try { job.ffmpeg.kill('SIGKILL'); } catch {}
  }
}
```

Job Unique/Edit/Reframe không set `killTree`, nên vẫn một `SIGKILL` như hôm nay. Chỉ job import set `killTree: true`. Test `planChildKill` không gọi `taskkill`.

Hủy giữa probe, giữa tải, hoặc giữa probe file đều cùng một lối đó. UI không append.

`progress` bám shape Unique (`value`, `phase`, `etaMs` optional):

```json
{ "type": "progress", "value": 45.2, "phase": "download", "etaMs": 8000 }
```

`phase` của import chỉ là `info` | `download` | `merge`. Không dùng `unique` hay `pgd`. Bỏ `etaMs` khi parser không có ETA — đừng gửi `null` nếu Unique đang coi “có field là có số”; importer UI của riêng hộp YouTube coi field thiếu là “chưa có ETA”. Gửi số nguyên millisecond.

Dòng log SSE là câu tiếng Việt ngắn (`[YT] Đang đọc thông tin video.`, `[YT] Đang tải.`, `[YT] Đang ghép hình và tiếng.`). Không forward stderr thô.

### Nơi ghi file

Ghi dưới `uploads/youtube-import/<jobId>/`, `uploadsDir` đã là `path.join(__dirname, 'uploads')` và đã gitignore cả `uploads/`.

Không ghi vào save dir. Save dir là đích export do operator chọn (`uploads/save-dir.json` qua `createSaveDirStore`). Trộn bản tải thô vào đó làm lẫn với output đã xử lý.

Tạo dir lúc stream bắt đầu, không lúc `POST` fail validation. Mọi path qua `isInsideDir(importRoot, jobDir)` và file kết thúc cũng phải nằm trong đó. Từ chối nếu `jobId` không phải 32 hex — dù id do server tự sinh.

Sau khi yt-dlp thoát 0:

- Đúng một file video, ext `.mp4`, size từ 100 byte đến `YOUTUBE_MAX_FILE_BYTES`, trực tiếp trong `jobDir` (không nhận file trong thư mục con). Mp4 cuối lớn hơn hằng số → `too_big`, xóa dir, không `done`, kể cả khi từng part lúc tải chưa bị chặn.
- `probeImportedFile` thấy stream video, `durationSec >= 0.5`, chiều rộng và cao `>= 64`. Không thêm ffprobe riêng. Child ffmpeg này cũng gắn `job.ffmpeg`.
- Đổi tên thành `sanitizeImportFileName(title, videoId)`.
- Xóa phần còn lại trong dir (`.part`, `.ytdl`, format trung gian). Giữ một mp4.

Fail hoặc cancel: `fs.rm` cả dir (recursive). Không giữ file dở.

`done` trả đúng shape pick-videos, bọc trong event:

```json
{
  "type": "done",
  "file": {
    "name": "Tieu de [dQw4w9WgXcQ].mp4",
    "path": "D:\\tool\\ghostforge-refactored\\uploads\\youtube-import\\<jobId>\\Tieu de [dQw4w9WgXcQ].mp4",
    "folder": "D:\\tool\\ghostforge-refactored\\uploads\\youtube-import\\<jobId>",
    "size": 12345678
  },
  "videoId": "dQw4w9WgXcQ",
  "title": "Tieu de",
  "height": 1080,
  "durationSec": 212,
  "quality": "1080",
  "targetTab": "edit"
}
```

Side map trong process, `youtubeFiles: Map<jobId, { dir, filePath }>`, sống sau khi job SSE đã `done` và record trong `jobs` có thể được xóa khỏi map lúc stream kết thúc. `DELETE` chỉ tra map này. Restart server thì map mất. Dir mà Edit đã dùng làm `sourcePath` **phải còn trên đĩa** sau restart: `edit-part-test-history.json` giữ path tuyệt đối và không nằm trong map này. Không sweep `uploads/` lúc boot, và không sweep riêng `uploads/youtube-import/` — lần sweep cũ đã từng xóa nhầm artifact, và boot không biết dir nào history còn trỏ tới. Dir mồ côi khác (crash, lỡ `done`, hoặc Edit success cố ý giữ) chỉ xóa tay khi operator không còn Test lại.

### Một lượt, và trần

`YOUTUBE_MAX_DURATION_SEC = 7200` (2 giờ). `YOUTUBE_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024` (8589934592, 8 GiB). `ytDlpMaxFilesizeArg` trả `String(bytes)` không hậu tố (`8589934592`). yt-dlp đọc số trần không đơn vị là byte. Không hardcode `'8G'` hay chuỗi đơn vị khác — đó là bản sao thứ hai của cùng trần, dễ lệch khi hằng số đổi.

Ngày 2026-09-30 operator bác phương án 45 phút / 3 GiB và chốt 2 giờ / 8 GiB. Code chỉ đọc hai hằng số này. Trần vẫn chặn VOD dài hơn 2 giờ và file nặng hơn 8 GiB, kể cả `best` và 4K. Không có trần vô hạn.

Trong lúc download, sau mỗi dòng progress đã hoàn chỉnh (và trước `done`): cộng `size` mọi file thường trực tiếp trong `jobDir`. Tổng vượt `YOUTUBE_MAX_FILE_BYTES` → kill tree, `too_big`, xóa dir. Không so mỗi file riêng.

### Lối vào Unique — không đổi pipeline

`POST /api/unique/job-local` làm đúng việc `POST /api/edit/job-local` (khoảng dòng 2028) nhưng **không** set `kind`, để `GET /api/stream/:jobId` hiện có xử lý:

```js
jobs.set(jobId, {
  inputPath: localPath,
  originalName: path.basename(localPath),
  originalSize: st.size,
  keepInput: true,
  settings,
  status: 'pending',
});
```

Check giống Edit: path tồn tại, là file, `size >= 100`. Đây là cùng biên localhost mà Edit/Reframe đã tin. Không nhận URL. Xóa `path` khỏi settings trước khi lưu. Stream Unique so vài cờ bằng `=== 'true'` trên string — client gửi string, không gửi boolean JSON.

`keepInput: true` để `DELETE /api/job/:jobId` không xóa nguồn. Nhánh xóa input hiện chỉ chạy khi `!job.keepInput` và path nằm trong `uploadsDir` (khoảng dòng 1898). Thiếu cờ này thì xóa job Unique sẽ xóa luôn file YouTube. Xóa nguồn YouTube sau success của Unique hoặc Reframe là `DELETE /api/youtube-import/:youtubeJobId` từ UI, không phải route này. Edit success không gọi DELETE đó: part job và `edit-part-test-history.json` còn `sourcePath` trỏ vào file import.

`processOneFile` rẽ nhánh **trước** khi tạo `FormData`. Nhánh `localPath` không dựng `FormData`, không `append('video', clip.file)`, và không log `Uploading`. Log một dòng đĩa, cùng kiểu Edit/Reframe (`Edit from disk` khoảng dòng 837, `Reframe from disk` khoảng dòng 1476):

```ts
const settings = {
  platformMode,
  uniqueStrength,
  featherTop: String(featherTop),
  featherBottom: String(featherBottom),
  featherEnabled: String(!!featherEnabled),
  uniqueRotate: String(rotateParts.rotate),
  uniqueWobble: String(rotateParts.wobble),
  enableAdversarial: String(enableAdversarial),
  enableAudioAttack: String(enableAudioAttack),
  enableTikTokCanvas: String(enableTikTokCanvas),
  enablePgd: String(!!enablePgd),
  enablePgdOnly: String(!!(enablePgd && enablePgdOnly)),
  pgdLevel,
  encoderMode,
};
const upload = clip.localPath
  ? (log(`Unique from disk: ${clip.name}`),
     fetch(`${BACKEND_URL}/api/unique/job-local`, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ path: clip.localPath, ...settings }),
     }))
  : (log(`Uploading ${clip.originalName} → ${clip.name}...`),
     postMultipart(settings, clip.file));
```

`postMultipart` là đường cũ: `FormData`, `append('video', clip.file)`, rồi cùng các key trên dưới dạng string. Nhánh đĩa không gọi hàm đó. Sau cả hai nhánh vẫn `EventSource` tới `/api/stream/${jobId}`. Không đụng filter graph, PGD, metadata remux, hay shape `done` của Unique.

### Tìm yt-dlp và ffmpeg

`GET /api/youtube-import/status` không tạo job, không mạng, không tải binary.

Thứ tự, dừng ở cái `--version` thoát 0:

1. `process.env.GHOSTFORGE_YT_DLP` nếu đặt. Coi đó là command (một executable), prefix args rỗng.
2. `yt-dlp` trên `PATH`. Windows thử tiếp `yt-dlp.exe` nếu cái trước `ENOENT`.
3. `python -m yt_dlp`. Python là `process.env.GHOSTFORGE_PYTHON` nếu đặt, không thì `python` trên `PATH`. **Không** dùng `pgdPython()` / `.venv` của OpenCLIP.

Probe **bất đồng bộ** qua `runProcess`, không `spawnSync`. `spawnSync` chặn thread Node (SSE Unique, Edit, cancel) suốt lúc probe. `/api/pgd-status` đã tránh việc đó bằng `runProcess` (comment khoảng dòng 978). Mỗi lần thử: `runProcess(command, [...prefix, '--version'], { windowsHide: true, timeout: 8000 })` và ffmpeg `runProcess('ffmpeg', ['-hide_banner', '-version'], { windowsHide: true, timeout: 8000 })`. `timeout` ở đây đúng nghĩa giết probe treo; không `shell: true`. Cache **cả** thành công và thất bại 60 giây, cùng kiểu `/api/pgd-status`. `?fresh=1` xóa cache. Không gọi `probeEncoderCaps` từ status hay từ job import: lần gọi đầu chạy thử mở NVENC/QSV rồi cache, và khi `where`/`which` rỗng nó vẫn gán `ffmpegPath` là chuỗi `'ffmpeg'` (khoảng dòng 150–158). Chuỗi đó không có nghĩa là ffmpeg chạy được.

ffmpeg sẵn sàng chỉ khi `-version` thoát 0. Khi đó `--ffmpeg-location` nhận đúng command vừa chạy được (`ffmpeg`), hoặc đường dẫn đầy đủ nếu `where`/`which` (chỉ chạy sau probe thành công) trả một dòng. yt-dlp nhận cả tên binary lẫn đường dẫn. Thiếu ffmpeg thì `ready: false` dù có yt-dlp, vì selector mặc định gần như luôn phải merge. Không có `GHOSTFORGE_FFMPEG` trong `ghostforge-server.js`.

Response status:

```json
{
  "ready": true,
  "busy": false,
  "active": null,
  "message": "",
  "ytDlp": { "ok": true, "via": "path", "command": "yt-dlp", "version": "2026.09.01" },
  "ffmpeg": { "ok": true, "path": "C:\\ffmpeg\\bin\\ffmpeg.exe" },
  "limits": { "maxDurationSec": 7200, "maxFileBytes": 8589934592, "defaultQuality": "1080" }
}
```

Thiếu yt-dlp: `ready: false`, `message`: `Chưa có yt-dlp. Cài yt-dlp rồi bấm kiểm tra lại. Ứng dụng không tự cài.` `version` cắt một dòng, bỏ URL nếu bản nào in URL.

### Failure modes

**Từ chối lúc POST** — client không nhận 201, không có dir, không có SSE. `bad_url` đến `quality` trả trước khi đụng slot. `busy` là slot đang trỏ một job sống. `no_ytdlp` và `no_ffmpeg` chỉ xảy ra sau khi slot đã được giữ đồng bộ: probe `--version` là `await`, fail thì xóa record vừa tạo và nhả slot nếu `activeYoutubeJobId` vẫn là id này. Không `await` probe tool trước bước giữ slot.

| code | HTTP | Khi nào | Message |
|---|---|---|---|
| `bad_url` | 400 | Không parse được, sai protocol, có userinfo | Link không hợp lệ. |
| `host` | 400 | Host không trong allowlist | Chỉ nhận link YouTube (youtube.com hoặc youtu.be). |
| `playlist` | 400 | Path `/playlist`, hoặc `list` không kèm video id 11 ký tự | Link playlist không được tải. Hãy dán link một video. |
| `not_video` | 400 | `/channel`, `/c/`, `/user/`, `/@handle`, `/feed`, `/results`, `/hashtag`, hoặc không rút được id 11 ký tự | Link này không phải một video YouTube. |
| `tab` | 400 | Thiếu `tab` hoặc không phải `unique` / `edit` / `reframe` | Chọn tab Unique, Edit hoặc Reframe trước khi tải. |
| `quality` | 400 | Khác `1080` và `best` | Chất lượng không hợp lệ. |
| `no_ytdlp` | 400 | Status không ready vì thiếu yt-dlp | Chưa có yt-dlp. Cài yt-dlp rồi bấm kiểm tra lại. Ứng dụng không tự cài. |
| `no_ffmpeg` | 400 | Không thấy ffmpeg lúc POST | Không thấy ffmpeg, nên không ghép được hình và tiếng. |
| `busy` | 409 | Đã có một import pending/running | Đang tải một video YouTube khác. Hủy hoặc đợi xong rồi thử lại. |

Body lỗi: `{ "error": "<message>", "code": "<code>" }`. UI hiện `error`, không hiện HTML.

**Fail trong job** — SSE `type: error`, xóa dir, nhả slot, UI không append:

| code | Khi nào | Message |
|---|---|---|
| `private` | availability hoặc stderr private | Video này ở chế độ riêng tư. |
| `age` | needs_auth, “confirm your age”, “Sign in” | Video giới hạn tuổi hoặc cần đăng nhập. Bản này chưa đọc cookies. |
| `members` | members-only / premium | Video chỉ dành cho thành viên kênh. |
| `region` | “not available in your country” | YouTube chặn video này theo khu vực. |
| `deleted` | removed, deleted, unavailable không kèm reason khác | Video không còn trên YouTube hoặc đã bị xóa. |
| `live` | live, premiere chưa thành VOD | Video đang phát trực tiếp hoặc chưa có bản xem lại. |
| `too_long` | duration > `YOUTUBE_MAX_DURATION_SEC` (2 giờ) | Video dài hơn 2 giờ. Không tải. |
| `too_big` | ước lượng, tổng file trong `jobDir`, mp4 cuối, hoặc yt-dlp max-filesize vượt `YOUTUBE_MAX_FILE_BYTES` | File vượt quá 8 GiB. Không tải. |
| `unknown_duration` | không có duration số | Không đọc được thời lượng. Không tải. |
| `id_mismatch` | JSON `id` khác id đã chọn | Thông tin YouTube không khớp video đã chọn. Đã dừng. |
| `playlist_slip` | dòng hoàn chỉnh `Downloading item N of M` hoặc `Downloading video N of M` với M > 1 | Link này vẫn trỏ tới nhiều video. Đã dừng. |
| `no_format` | requested format is not available | YouTube không có bản H.264/AAC trong tầm đã chọn. |
| `no_ffmpeg` | stderr ffmpeg/ffprobe not found lúc merge | Máy không ghép được hình và tiếng vì thiếu ffmpeg. |
| `blocked` | HTTP 403, “confirm you’re not a bot” | YouTube từ chối lượt tải. Không thử vượt chặn. |
| `disk` | ENOSPC / No space left | Hết dung lượng ổ đĩa. |
| `cancelled` | `job.cancelled` ở probe JSON, lúc tải, hoặc lúc probe file | Đã hủy tải từ YouTube. |
| `probe` | `probeImportedFile` không thấy video dùng được | File tải về không phải video xem được. |
| `output` | exit 0 nhưng không có đúng một mp4 | yt-dlp không tạo được file mp4. |
| `failed` | mã khác | Tải thất bại. |

`failed` được kèm tối đa một cụm đã `redactLogLine`, không kèm URL. Log server ghi `code`, `videoId`, exit status — không ghi canonical URL đầy đủ query (canonical cũng chỉ còn id; vẫn không ghi ra file log nếu stderr chứa URL khác).

Cookie tuổi/riêng tư **không** có trong v1, kể cả khi file `.youtube-cookies.txt` đã nằm trên đĩa. Message `age` nói thẳng là bản này chưa đọc cookies. PR 5, chỉ khi operator yêu cầu, mới đọc đúng một file server chọn — không nhận path từ client.

## API / Interface Changes

Không đổi body của `/api/upload`, `/api/edit/*`, `/api/reframe/*`, `/api/download/:jobId`, `/api/cancel/:jobId`, `/api/pick-videos`.

Thêm:

### `GET /api/youtube-import/status`

Query `fresh=1` tùy chọn. 200, shape ở mục tìm tool. Luôn 200 khi process sống; `ready: false` không phải 500.

Khi có import chưa xong, `busy: true` và `active` không null:

```json
{
  "busy": true,
  "active": {
    "jobId": "0123456789abcdef0123456789abcdef",
    "state": "running",
    "videoId": "dQw4w9WgXcQ",
    "targetTab": "edit"
  }
}
```

`state` là `pending` (chưa có `streamState`) hoặc `running` (SSE đã bắt đầu). Rảnh thì `"busy": false, "active": null`. UI mount dùng `active.jobId` để mở lại stream và để `POST /api/cancel/:jobId`. Không trả URL gốc.

### `POST /api/youtube-import`

```json
{ "url": "https://youtu.be/dQw4w9WgXcQ", "quality": "1080", "tab": "edit" }
```

`quality` bỏ trống → `1080`. `tab` bắt buộc: `unique`, `edit`, hoặc `reframe`.

201:

```json
{
  "jobId": "0123456789abcdef0123456789abcdef",
  "videoId": "dQw4w9WgXcQ",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "targetTab": "edit"
}
```

400 / 409 như bảng trên. Không echo URL gốc.

### `GET /api/youtube-import/stream/:jobId`

`Content-Type: text/event-stream`, qua `subscribeJob`.

Sự kiện, field `type`:

```json
{ "type": "log", "message": "[YT] Đang đọc thông tin video." }
{ "type": "progress", "value": 0, "phase": "info" }
{ "type": "progress", "value": 45.2, "phase": "download", "etaMs": 8000 }
{ "type": "progress", "value": 100, "phase": "merge" }
{ "type": "done", "file": { "name": "", "path": "", "folder": "", "size": 0 }, "videoId": "", "title": "", "height": 1080, "durationSec": 1, "quality": "1080", "targetTab": "edit" }
{ "type": "error", "message": "Video này ở chế độ riêng tư.", "code": "private" }
```

Job không tồn tại hoặc sai kind → 404, không body SSE. Reconnect khi `streamState` đã có: `subscribeJob` phát lại history rồi return null; handler không spawn lần hai.

### `POST /api/cancel/:jobId`

Không đổi, và đây là cách hủy id mà status trả về sau reload. Với job import, `abortJob` đi nhánh `killTree` nếu child đã được `onSpawn` gán vào `job.ffmpeg` (kể cả probe JSON). Response cũ: `{ "ok": true, "aborted": true }` hoặc `{ "ok": true, "missing": true }`.

### `DELETE /api/youtube-import/:jobId`

Xóa dir đã ghi trong `youtubeFiles` nếu `isInsideDir(importRoot, dir)`. 200 `{ "ok": true }`. Không có trong map → 404 `{ "error": "Không còn file import này." }`. Đang tải chính job đó → 409 `{ "error": "Đang tải video này. Hủy trước đã." }`. Không nhận path từ client.

### `POST /api/unique/job-local`

```json
{
  "path": "D:\\tool\\ghostforge-refactored\\uploads\\youtube-import\\<jobId>\\clip.mp4",
  "platformMode": "auto",
  "uniqueStrength": "strong",
  "enableAdversarial": "true"
}
```

Các key settings khác y nguyên form Unique hiện gửi. 200 `{ "jobId": "<new id>" }`. 400 `{ "error": "Local video path missing" }` hoặc `{ "error": "Not a usable video file" }` — cùng câu Edit đang dùng, để client khỏi có hai kiểu “path hỏng”. Job id này **khác** job import. Stream vẫn là `GET /api/stream/:jobId`.

### UI state mới

Nằm trong `YoutubeImportBox`, không nâng lên thành state pipeline:

| Field | Kiểu | Việc |
|---|---|---|
| `url` | string | Ô dán |
| `quality` | `'1080' \| 'best'` | Select |
| `toolReady` | boolean | Từ status |
| `toolMessage` | string | Lý do ẩn form |
| `busy` | boolean | Khóa form |
| `jobId` | string \| null | Để Hủy và DELETE. Sau reload lấy từ `status.active.jobId`, không chỉ từ state lần bấm |
| `targetTab` | `'unique' \| 'edit' \| 'reframe'` \| null | Nơi append. Sau reload lấy từ `status.active.targetTab` hoặc `done.targetTab` |
| `phase` | `'info' \| 'download' \| 'merge'` \| null | Nhãn |
| `value` | number | 0–100 |
| `etaMs` | number \| null | Chỉ hiện khi là số |

Nhãn phase: `Đang đọc thông tin` / `Đang tải` / `Đang ghép`. ETA: `còn khoảng N giây` khi `etaMs` có, làm tròn giây. Không hiện ETA ở phase `info` và `merge`.

## Data Model Changes

Không database. Không đổi `uploads/save-dir.json`.

Trên đĩa:

```text
uploads/youtube-import/<32 hex>/
  <sanitized title> [<videoId>].mp4
```

`uploads/` đã nằm trong `.gitignore`. Không commit file tải.

Trong RAM:

- `jobs` Map: record import chỉ sống suốt SSE. Xong thì xóa khỏi `jobs` để `GET /api/stream/:jobId` không nuốt id này về sau. File không nằm ở `job.outputPath`, nên `GET /api/download/:jobId` không phục vụ nó.
- `youtubeFiles` Map: `{ dir, filePath, videoId }` đến khi DELETE hoặc process thoát.
- `activeYoutubeJobId`: string hoặc null.

`QueueClip` thêm optional `source` và `youtubeJobId`. Không migration.

Cookie v1: không đọc file nào. PR 5 không nhận `cookiesPath` từ client. Nếu PR đó được làm sau khi operator yêu cầu, server chỉ đọc đúng `<repo>/.youtube-cookies.txt` (gitignore cạnh `.tiktok-session/`), sau `realpath` vẫn phải là file đó. Mọi path khác — JSON service account, `.env`, cookie store của Chrome — bị từ chối, không đưa vào argv. Body có `cookiesPath` thì 400, không spawn. v1 không đọc file kể cả khi nó đã tồn tại, nên gitignore thuộc PR 5, không thuộc PR đầu.

## Alternatives Considered

### 1. Tab thứ tư “YouTube”

Một hàng riêng rồi operator kéo sang Unique/Edit/Reframe. Bị loại: file phải vào đúng list pipeline đã có, và Trends đã cho thấy tab mới là một sản phẩm riêng. Đổi tab giữa chừng cũng dễ tải xong mà không biết file nằm ở đâu. Hộp chung, nhớ `targetTab` lúc bấm, ít state hơn.

### 2. YouTube Data API, hoặc Invidious/Piped, làm nguồn byte

Data API không trả media file; chỉ metadata và tốn key. Invidious/Piped bỏ một binary local để phụ thuộc instance công cộng (chết, chặn, hoặc chính nó là proxy). `yt-dlp` trên máy operator khớp cách server đã spawn ffmpeg/Python, và hỏng thì dừng — không có lớp “thử instance khác” để né chặn.

### 3. Tải xong, browser `fetch` file rồi nhét vào `File` để Unique upload lại

Bị loại. Multer trần 500 MB (`ghostforge-server.js` dòng 49). Unique sẽ nhận một bản copy thứ hai qua HTTP localhost, chậm, và file trên 500 MB fail dù import hợp lệ. `job-local` để stream Unique đọc thẳng `inputPath`, đúng pattern Edit/Reframe đã chạy.

### 4. Dùng `runProcess` nguyên trạng

Không stream được progress, không giữ child để `abortJob` giết giữa chừng. Spawn thẳng trong route thì tiếp tục có hai kiểu chạy process. Mở rộng `runProcess` bằng hooks tùy chọn giữ một chỗ spawn, không đổi caller cũ.

### 5. Re-encode mọi thứ sang H.264 bằng `--recode-video mp4`

Bảo đảm mp4 ngay cả khi nguồn chỉ có AV1/Opus, nhưng đốt CPU, đổi pixel của **nguồn** trước khi Unique/Edit chạy, và dễ bị hiểu nhầm là một pass xử lý. Selector ưu tiên avc1+aac và remux. Không có format thì báo `no_format` hoặc, với `best`, để yt-dlp merge; remux thất bại thì `output` / `no_ffmpeg`, không encode lại.

### 6. Job system mới

Không cần. `server/jobs.js` đã có map, history SSE, cancel. Việc phải làm chỉ là `kind` để Unique stream không nuốt job, và `killTree` vì `abortJob` hôm nay không giết con của yt-dlp.

## Security & Privacy Considerations

Kẻ được giả định: người dùng local đã có quyền với process (middleware host + listen `127.0.0.1`). Không có tài khoản, không có tenant. Rủi ro là URL độc họ dán (hoặc một trang họ mở trên cùng máy gửi request localhost), playlist nuốt đĩa, và lộ bí mật trong log.

| Việc | Cách chặn |
|---|---|
| SSRF qua host giả, userinfo, redirect tới metadata IP | `new URL` + allowlist hostname đúng chuỗi + dựng lại canonical `https://www.youtube.com/watch?v=<id>`. Không fetch URL bằng `http.get` của Node. Không spawn trước khi `parseYoutubeUrl` ok. Redirect sang `googlevideo.com` chỉ xảy ra **bên trong** yt-dlp sau allowlist — đó là CDN của chính video, không phải do ta curl host tùy ý. |
| Smuggle argv / shell | `spawn(command, args)` , không `shell: true`, không nối chuỗi. URL là một phần tử. |
| Path escape | `jobId` hex, `isInsideDir`, `-o` trong dir job, rename không nhận `..`. DELETE không nhận path client. |
| Playlist bất ngờ | Từ chối trước spawn; `--no-playlist`; giết nếu thấy “of N” với N > 1. |
| Một máy bị nhiều tải | Một slot. 409. |
| Đĩa đầy | Trần duration + byte + `--max-filesize` + xóa dir khi fail. |
| Lộ cookie | v1 không đọc cookie. Không `--cookies-from-browser`. PR 5 không nhận path client; chỉ một file server chọn. Không đọc SQLite cookie của Chrome. |
| Lộ URL có token | Log và SSE chỉ `videoId` và câu đã redact. Không log argv. Không log stdout JSON (có URL chữ ký). |
| Nhầm với download output | Prefix `/api/youtube-import/`. Không ghi `job.outputPath`. |
| Job import rơi vào Unique | `kind: 'youtube-import'` và nhánh 400 trên `/api/stream/:jobId`. |
| Quyền tác phẩm | Một dòng UI. App không kiểm tra giấy phép và không giả vờ kiểm tra. |

Không thêm CORS, không nới middleware host, không listen `0.0.0.0`.

`POST /api/unique/job-local` tin path local giống Edit. Người đã gọi được localhost đã chạy được ffmpeg trên file đó hôm nay. Không biến route này thành “tải URL hộ”.

## Observability

App không có Prometheus. Không thêm metrics stack.

- SSE `log` prefix `[YT]`, câu ngắn tiếng Việt.
- SSE `progress` có `phase` và `etaMs` khi parser có ETA.
- `console.info` một dòng lúc xong hoặc fail: `youtube-import <videoId> <code|ok> <ms> <bytes>`. Không URL, không stderr thô.
- Exit status và `code` phân loại đủ để operator đọc log UI. Không alert, vì không có hệ alert và chỉ một người dùng.
- Probe tool fail: status `ready: false` và message UI, không spawn tải.

## Rollout Plan

Chưa làm cho đến khi operator nói **thực hiện**. Không feature-flag service. “Chưa có yt-dlp” chính là công tắc: form ẩn, phần còn lại của app chạy như cũ.

Thứ tự merge là các PR ở cuối tài liệu. Mỗi PR để `npm test` xanh. PR UI mới cần `npm run build` trên máy Windows (cây `node_modules` trong repo là bản Windows; sandbox Linux không load được Rollup native — `VALIDATION.md` mục Frontend build).

Rollback: gỡ route và component. Dir dưới `uploads/youtube-import/` có thể xóa tay. Không migration. Job Unique/Edit/Reframe không đổi shape nên rollback không làm hỏng hàng đang xử lý.

Cookie không nằm trong lát cắt đầu. Trần 2 giờ / 8 GiB là hằng số của PR 1, không phải việc nới sau.

## Validation

Test thuần, `tests/youtube-url.test.js`, style `node:test` + `node:assert/strict` như `tests/jobs.test.js`. Không mạng, không spawn yt-dlp, không tải binary.

Case tối thiểu:

- Host đủ bộ allowlist, kể cả `youtu.be`, `music.youtube.com`, `www.youtube-nocookie.com`, `/shorts/`, `/embed/`.
- `http://` được parse nhưng canonical là `https://www.youtube.com/watch?v=<id>`.
- Từ chối userinfo, `https://evil.example/watch?v=…`, `https://youtube.com.evil.example/…`, `file:`, id không đủ 11 ký tự.
- `https://www.youtube.com/playlist?list=…` và `watch?list=` không có `v` → `playlist`. `https://www.youtube.com/channel/UC…`, `/c/name`, `/user/name`, `/@name`, `/feed`, `/results?search_query=`, `/hashtag/name` → `not_video`, kể cả khi không có `list`.
- `watch?v=<id>&list=<id>` ra một video, canonical không có `list`. Path `/playlist` vẫn `playlist`.
- `formatSelector` khớp đúng hai chuỗi trong tài liệu này. `ytDlpMaxFilesizeArg(YOUTUBE_MAX_FILE_BYTES)` là `'8589934592'`, không phải chuỗi đơn vị.
- Progress: `45.2%` + `ETA 00:08` → `etaMs` 8000; `ETA 01:02:03`; dòng Merger → phase `merge`; dòng rác → `null`.
- `consumeProcessText`: chunk `"[download]  45.2% of 1MiB ETA 00:"` rồi `"08\n"` ra một dòng, `pending` rỗng, parse ra `etaMs` 8000. Đoạn không newline ở cuối được giữ.
- `playlistSlip` khớp `Downloading item 1 of 3` và `Downloading video 2 of 4`; `of 1` không phải slip.
- `classifyYtDlpFailure` với mẫu private, age, region, 403, ENOSPC, ffmpeg not found — gọi trên cả chuỗi, không trên một nửa chunk.
- `sanitizeImportFileName` bỏ `<>:"/\|?*`, giữ chữ Việt và giữ `foo..bar`, luôn kết thúc `.mp4` và có ` [<videoId>]`. Không bắt sanitizer xóa `..`.
- `redactLogLine` xóa `https://…`.
- `isInsideDir` chặn `..` và path ra ngoài root. Đây là test chặn thoát thư mục.
- `planChildKill`: không pid → `none`; có pid không `killTree` → `signal`; `killTree` → `tree`. Không gọi `taskkill`.

Lệnh khi đã có code:

```bash
npm test
npm run check:server
npm run validate
```

`npm run check:server` đã `readdir` mọi `server/*.js`, nên file mới được kiểm syntax không cần sửa glob. `npm run validate` = handoff + test + syntax.

PR 3 thêm `tests/youtube-import.test.js`, vẫn `node:test`, không mạng, không binary yt-dlp:

- Gọi orchestrator (`createYoutubeImport` / hàm stream nó dùng) với `runProcess` giả ghi `command`, `args`, `options`. URL đầu vào là chuỗi operator dán, ví dụ `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxx&si=SECRET`. Fake trả JSON dump rồi thoát 0 cho lần tải, không mở socket. Assert: không có `options.shell === true`; args có `--no-playlist` và đúng selector `1080`; argument URL cuối cùng đúng `https://www.youtube.com/watch?v=dQw4w9WgXcQ`; chuỗi gốc, `si=SECRET`, và `list=PLxxxx` không xuất hiện trong bất kỳ arg nào. Probe JSON cũng đi qua fake và cũng có `onSpawn` (test đếm rằng hooks được truyền).
- Import `app` từ `ghostforge-server.js` (không set `GHOSTFORGE_STANDALONE`, nên không listen sẵn) và `jobs` từ `server/jobs.js`. Nhét một job `kind: 'youtube-import'`. `http.createServer(app).listen(0, '127.0.0.1')`, `GET /api/stream/:jobId`, kỳ vọng 400 và `error` trỏ sang `/api/youtube-import/stream`. `job.outputPath` và `job.ffmpeg` vẫn trống — encode Unique không chạy. Đóng server. Route phải gọi `uniqueStreamBlock` trước encode; test này đập vào route thật nên quên guard là test đỏ.

PR đụng `src/`: `npm run build` trên Windows. Không bắt CI Linux build nếu native Rollup vẫn vỡ như `VALIDATION.md` đã ghi.

Smoke tay, **không** vào `npm test`, operator tự chạy sau khi cài yt-dlp:

1. `GET /api/youtube-import/status` báo `ready` trước một video ngắn họ có quyền tải. Khi một lượt đang chạy, cùng endpoint trả `active.jobId`.
2. Dán link đó ở tab Edit, thấy progress, file xuất hiện trong hàng Edit với `localPath` dưới `uploads/youtube-import/`.
3. Start Edit và thấy log `from disk`, không phải `Uploading`. Xong job, dòng biến mất khỏi hàng **nhưng** `uploads/youtube-import/<jobId>/` còn. Test lại Part (hoặc history “Part đã chạy gần nhất”) mở được file đó, không 404 `Original landscape source no longer exists`. Start Reframe: cùng log đĩa, dòng biến mất, và thư mục import bị DELETE vì Reframe không ghi `sourcePath`.
4. Cùng kiểu ở tab Unique: log `Unique from disk`, không có dòng `Uploading`, không gửi multipart. `DELETE /api/job/:uniqueJobId` không xóa file nguồn (`keepInput`). Nhánh success của UI gọi `DELETE /api/youtube-import/:youtubeJobId` sau khi Unique đã đóng file, nên hàng trống không để lại mp4. Edit không đi nhánh DELETE này.
5. Dán `https://www.youtube.com/playlist?list=…` và một URL không phải YouTube: 400, không có process yt-dlp.
6. Bấm Hủy trong lúc phase `info` (đang `--dump-single-json`) và một lần nữa trong lúc tải: message hủy, không `done`, không còn `.part`, không còn `yt-dlp` hay `ffmpeg` con. Reload giữa chừng: status còn `active.jobId`, nút Hủy hiện lại và cancel trúng job đó.
7. Bấm Tải lần hai trong khi lần một chạy: 409. Một job `pending` không stream quá 120 giây thì lần POST sau reap rồi nhận URL mới trong cùng request.

Không video mạng trong CI. Không dùng quota Gemini/Vertex để “thử import”.

## Documentation impact khi thực hiện

Không sửa các file này trong task thiết kế. Khi code được viết:

| File | Có sửa? |
|---|---|
| `CODEMAP.md` | Có. Route `/api/youtube-import/*`, `POST /api/unique/job-local`, module `server/youtube-url.js` và `server/youtube-import.js`. |
| `ARCHITECTURE.md` | Có, một dòng trong bảng: import YouTube → `server/youtube-import.js`, không nằm trong pipeline Unique. |
| `PIPELINES.md` | Có, mục mới “YouTube import”, tách khỏi mục Unique. Nói rõ file tải là nguồn, job `kind`, và Unique `job-local` chỉ là lối vào. |
| `VALIDATION.md` | Có, đoạn ngắn: test thuần không mạng, smoke tay một video, cấm CI gọi yt-dlp. |
| `AI_INTEGRATIONS.md` | Không. yt-dlp không phải provider/model/STT. |
| `CURRENT_STATE.md` | Chỉ nếu focus đang làm chuyển sang import. Không dán lại lịch sử Unique. |
| `CHANGELOG_AI.md` | Có, một entry ngày thực hiện. |
| `scripts/validate-handoff.mjs` | Nên thêm các route mới vào `documentedRoutes` trong cùng PR route, không thì guard không biết chúng tồn tại. Không bắt buộc để guard cũ vẫn xanh. |

`npm run validate:handoff` sau khi sửa danh sách route/docs.

## Risks

| Mức | Rủi ro | Giảm |
|---|---|---|
| Cao | Allowlist regex trên chuỗi thô bị qua mặt bằng userinfo hoặc host hậu tố | `new URL`, set host, canonical lại, test các case đó |
| Cao | `shell: true` hoặc nối chuỗi lệnh | Test PR 3 với `runProcess` giả: không `shell`, URL cuối là canonical, chuỗi operator dán không có trong args |
| Trung bình | `abortJob` đổi nhầm cách giết FFmpeg Unique, hoặc gỡ `timeout` làm gcloud và dialog treo | `killTree` opt-in; spread `options` giữ `timeout`; test `planChildKill`; import không truyền `timeout` |
| Trung bình | Quên guard `kind` → stream Unique nuốt job import | `uniqueStreamBlock` trước encode; test HTTP 400, `outputPath` không được gán |
| Trung bình | Quên nhánh `localPath` ở Unique → upload file 0 byte hoặc vướng 500 MB, log vẫn `Uploading` | PR UI không dựng `FormData` trên nhánh đĩa; log `Unique from disk`; chỉ hàng Unique đổi biểu thức size |
| Trung bình | Hủy lúc probe JSON không có child | `onSpawn` cho mọi child import, kể cả dump-json và `probeImportedFile`; sau mỗi exit kiểm tra `cancelled` |
| Trung bình | Reload mất nút Hủy, slot kẹt 2 giờ | Status trả `active.jobId`; UI nối lại stream; giữ slot trước `await`; `finally` chỉ xóa đúng id |
| Trung bình | yt-dlp để lại ffmpeg con sau cancel | `taskkill /T /F` trên Windows, `kill(-pid)` trên POSIX. `timeout` của Node không thay việc này |
| Trung bình | Chunk cắt đôi dòng progress hoặc câu slip | `consumeProcessText` giữ đuôi; slip khớp `item` và `video` |
| Trung bình | YouTube 403 / bot check | `blocked`, dừng. Không PR “fix extractor” |
| Thấp | Dir mồ côi sau crash, UI không nhận `done`, hoặc Edit success cố ý giữ nguồn | Unique và Reframe success gọi DELETE import. Edit success không gọi, để `sourcePath` của part history và part job còn file. Xóa khi bấm X nếu dòng còn (fail/cancel/chưa chạy) và operator không còn Test lại. Không sweep boot, kể cả `uploads/youtube-import/`. Restart làm mất map; file Edit đã ghi history vẫn nằm trên đĩa |
| Thấp | PR 5 nhận path cookies tùy ý và yt-dlp gửi file đó đi | Không nhận path client. Chỉ `<repo>/.youtube-cookies.txt` khi operator yêu cầu làm PR đó. v1 không đọc |
| Thấp | `best` chọn codec không remux được | Fail `output`, xóa dir, không re-encode |
| Thấp | Operator tưởng file import đã được Unique | UI nói “thêm vào hàng nguồn”; không set `downloadUrl` của `/api/download/:jobId` |
| Thấp | Hai pipeline và một tải tranh đĩa | Chấp nhận trên máy một người; không xếp hàng thêm |

## Open Questions

Không còn câu hỏi mở.

Ngày 2026-09-30 operator chọn trần một lượt là 2 giờ và 8 GiB. Phương án 45 phút / 3 GiB bị bác. `YOUTUBE_MAX_DURATION_SEC = 7200`. `YOUTUBE_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024` (8589934592). `--max-filesize` là chuỗi thập phân của số byte đó, không hardcode chuỗi thứ hai. Không nới thành trần vô hạn.

Không hỏi lại chuyện downloader công khai hay rip playlist. Đó là non-goal. Cookies để PR sau, không phải câu hỏi mở: v1 cố ý không đọc cookies.

## References

- `ghostforge-server.js`: middleware host (~33–39), `uploadsDir` và multer 500 MB (~44–49), `probeMedia` (~233), `probeEncoderCaps` (~127–160), `POST /api/upload` (~1042), `GET /api/stream/:jobId` (~1070), encode `job.ffmpeg` (~1623), `GET /api/download/:jobId` (~1876), `DELETE /api/job/:jobId` và `keepInput` (~1891), `POST /api/cancel/:jobId` (~1914), `POST /api/pick-videos` (~1989), `POST /api/edit/job-local` (~2028), part job `inputPath` (~5073–5078), `writeEditPartHistory` `sourcePath` (~5102–5108), `POST /api/edit/part-test` 404 khi mất file (~5218–5236), `GET /api/pgd-status` (~977), `POST /api/reframe/job-local` (~6086), listen standalone `127.0.0.1:3033` (~6358).
- `launch.mjs`: listen `127.0.0.1`, port `PORT` hoặc 8080.
- `server/jobs.js`: `jobs`, `subscribeJob`, `abortJob`.
- `server/process.js`: `runProcess`.
- `server/save-dir.js`: thư mục export, không phải thư mục nguồn.
- `src/types.ts`: `AppTab`, `QueueClip`.
- `src/ghostforge-app.tsx`: `files` / `editFiles` / `reframeFiles`, `pickEditFromPc`, `pickReframeFromPc`, `processOneFile`, `runOneEdit`, `runOneReframe`. Success bỏ dòng: Edit ~1022, Reframe ~1584, Unique trong `startProcessing`. Size Edit ~3604, Unique ~2515. Log đĩa Edit ~837, Reframe ~1476. History Test lại ~4171–4181, nút Test lại Part ~4291–4301. `runGcloud` timeout ~3536.
- `src/lib/files.ts`: `safeFileName`, `newClipId`.
- `PIPELINES.md` mục 4: một job registry.
- `VALIDATION.md`: `npm test`, `npm run check:server`, `npm run validate`, caveat `npm run build` trên Windows.
- `scripts/check-server.mjs`, `scripts/validate-handoff.mjs`.
- `.gitignore`: `uploads/`, `.tiktok-session/`, `.tiktok-api-session/`. Chưa có cookie YouTube.

## Key Decisions

1. **Hộp chung, không tab mới.** File phải rơi vào `files`, `editFiles`, hoặc `reframeFiles`. Ba state này khác nhau: Edit và Reframe cần ghi ref trong setter để hàng đang chạy nhìn thấy clip; Unique chụp id lúc Start nên clip tới muộn chờ lượt sau. Nhớ tab tại thời điểm bấm Tải.
2. **`yt-dlp` subprocess, canonical URL, không API và không Invidious.** Data API không có file. Proxy bên thứ ba là phụ thuộc tồi hơn một binary local. Spawn chỉ sau allowlist.
3. **Allowlist bằng `new URL` và dựng lại `https://www.youtube.com/watch?v=<id>`.** `watch` kèm `list` là một video và `--no-playlist`. Playlist thật thì 400.
4. **Mp4 ưu tiên H.264 + AAC, trần cao 1080, thêm lựa chọn `best`.** Selector là hai chuỗi trong `YOUTUBE_FORMATS`. Merge/remux, không `--recode-video`. Không spoof metadata.
5. **Cùng `server/jobs.js` và `POST /api/cancel/:jobId`.** `kind: 'youtube-import'` để `/api/stream` không chạy Unique. Không registry mới.
6. **Mở rộng `runProcess` bằng hooks; `killTree` chỉ job import; giữ `timeout`.** `runProcess` hiện không stream và không trả child. `timeout` trên Node 24 đã giết đúng child bằng `SIGTERM` và đang được PGD, dialog file, và `gcloud` dùng — spread `options` phải giữ nó. Import không truyền `timeout` vì timer đó không giết cây process. `abortJob` hiện không giết process con. Giữ nguyên SIGKILL cho FFmpeg pipeline cũ. Windows dùng `taskkill /T /F`. Mọi child import, kể cả dump-json và probe file, gán `job.ffmpeg` qua `onSpawn`.
7. **File nằm trong `uploads/youtube-import/<jobId>/`, không vào save dir.** Save dir là export. Xóa cả dir khi fail/cancel của lần tải, và khi Unique hoặc Reframe success đã đóng file. Edit success bỏ dòng hàng nhưng **không** DELETE dir: `edit-part-test-history.json` và part job giữ `sourcePath` / `inputPath` trỏ vào file đó, và `POST /api/edit/part-test` 404 nếu file mất. Không sweep dir này lúc boot. X trên dòng còn sống vẫn DELETE, trừ khi operator còn Test lại lần Edit đó. DELETE theo job id, không theo path client.
8. **Một import một lúc, 2 giờ, 8 GiB.** Slot giữ đồng bộ trước `await`, nhả trong `finally` chỉ đúng id. Status trả `active.jobId` để reload còn Hủy. Trần byte là tổng file trong dir và cả mp4 cuối; `--max-filesize` là số byte của hằng số (`8589934592`), không copy chuỗi đơn vị. Ngày 2026-09-30 operator bác 45 phút / 3 GiB và chốt hai hằng số này.
9. **Unique nhận path bằng `POST /api/unique/job-local` + `keepInput`.** Edit/Reframe đã có job-local. Unique upload lại sẽ đụng trần 500 MB và file `File` rỗng. Nhánh `localPath` không dựng `FormData` và log `Unique from disk`. Stream Unique không đổi. Chỉ hàng Unique cần đổi biểu thức size; Edit đã dùng `fileSize`.
10. **v1 không cookies.** Thiếu quyền thì lỗi `age` / `private` và dừng. PR 5 không làm cho đến khi operator yêu cầu, và khi làm thì chỉ đọc `<repo>/.youtube-cookies.txt` do server chọn. Không nhận `cookiesPath`, không `--cookies-from-browser`, không commit.
11. **Không mạng trong `npm test`.** Parser, allowlist, progress, buffer dòng, classify, path confine, `planChildKill` là test. PR 3 thêm test argv với `runProcess` giả và test HTTP 400 cho `kind === 'youtube-import'` trên `/api/stream`. Smoke một video ngắn là tay.
12. **Ẩn form khi thiếu yt-dlp hoặc ffmpeg.** Khớp quy ước UI: control không làm được thì ẩn và nói vì sao. Không `pip install` trong request.

## PR Plan

### PR 1 — Pure YouTube URL and progress parsing

- **Title:** Add pure YouTube URL allowlist and yt-dlp progress parsing
- **Files:** `server/youtube-url.js`, `tests/youtube-url.test.js`
- **Depends on:** không
- **Description:** Hàm thuần: `parseYoutubeUrl`, `YOUTUBE_HOSTS`, `YOUTUBE_FORMATS`, `formatSelector`, `parseYtDlpProgressLine`, `consumeProcessText`, `playlistSlip`, `classifyYtDlpFailure`, `sanitizeImportFileName`, `ytDlpMaxFilesizeArg`, `redactLogLine`, `isInsideDir`, hằng số 2 giờ (`7200`) và 8 GiB (`8589934592`). Mã `playlist` và `not_video` theo bảng trong tài liệu, có test `/channel/UC…`. Test không mạng, không yt-dlp. Chưa có route.

### PR 2 — Stream child output and opt-in process-tree kill

- **Title:** Let runProcess stream output and kill a YouTube child tree
- **Files:** `server/process.js`, `server/jobs.js`, `tests/jobs.test.js` (và test nhỏ cho `planChildKill` nếu để ở `process.js`)
- **Depends on:** không (có thể merge song song với PR 1)
- **Description:** `runProcess` thêm hooks `onSpawn` / `onStdout` / `onStderr`. Caller cũ không truyền hooks thì vẫn gom buffer như cũ. `options` spread vào `spawn` **giữ `timeout`** cho probe PGD (30s), dialog file (180s), và `runGcloud` (25s). Không coi `timeout` là no-op và không xóa nó khi bỏ `encoding`. `planChildKill` + `killProcessTree` (`taskkill /T /F` trên Windows, `kill(-pid)` trên POSIX). `abortJob` chỉ giết cây khi `job.killTree`; job FFmpeg hiện tại không set cờ nên vẫn một `SIGKILL`. Test không gọi taskkill thật. Import (PR 3) không truyền `timeout` vào yt-dlp.

### PR 3 — YouTube import routes and one-at-a-time job

- **Title:** Add localhost YouTube import job and SSE
- **Files:** `server/youtube-import.js`, `tests/youtube-import.test.js`, `ghostforge-server.js` (route + `uniqueStreamBlock` ở đầu `GET /api/stream/:jobId`), `scripts/validate-handoff.mjs` (thêm route vào `documentedRoutes`), `CODEMAP.md`, `ARCHITECTURE.md`, `PIPELINES.md`, `VALIDATION.md`, `CHANGELOG_AI.md`
- **Depends on:** PR 1, PR 2
- **Description:** `GET /api/youtube-import/status` (async `--version`, cache 60s cả lúc fail, `active.jobId` khi bận), `POST /api/youtube-import`, `GET /api/youtube-import/stream/:jobId`, `DELETE /api/youtube-import/:jobId`. Slot giữ trước `await`; reap pending quá 120s rồi tạo job mới trong cùng POST; `finally` chỉ xóa đúng id. Probe JSON và tải đều `onSpawn`. Buffer dòng, trần là tổng size trong dir, `--max-filesize` từ hằng số byte. `POST /api/cancel/:jobId` giữ nguyên. Test argv với `runProcess` giả và test HTTP 400 trên `/api/stream` cho `kind === 'youtube-import'`. Chưa UI. `npm test` không mạng.

### PR 4 — Shared control and Unique local-path entry

- **Title:** Paste a YouTube URL into the active Unique, Edit, or Reframe queue
- **Files:** `src/components/YoutubeImportBox.tsx`, `src/ghostforge-app.tsx`, `src/types.ts`, `ghostforge-server.js` (`POST /api/unique/job-local` only), docs ở PR 3 nếu contract UI cần một câu trong `PIPELINES.md` / `CODEMAP.md`, `CHANGELOG_AI.md`
- **Depends on:** PR 3
- **Description:** Hộp “Tải từ YouTube” luôn mounted dưới dải tab, ẩn trên Xu hướng khi rảnh, ẩn form khi thiếu tool. Mount thì đọc status; nếu `busy` thì hiện Hủy và nối lại stream bằng `active.jobId`. Append `QueueClip` vào `targetTab` đã gửi lúc POST, `localPath`, `source: 'youtube'`, `outFolder` là save dir chứ không phải dir import. X trên dòng còn sống thì DELETE, trừ khi file đang là `sourcePath` của một lần Edit còn Test lại. Success của Unique và Reframe bỏ dòng rồi DELETE import sau khi job đã đóng file. Success của Edit bỏ dòng nhưng giữ `uploads/youtube-import/<jobId>/` để part history và part job còn mở được nguồn. `processOneFile`: nhánh `localPath` không dựng `FormData`, log `Unique from disk`, gửi đủ các string settings liệt kê trong tài liệu, rồi stream Unique cũ; `keepInput: true`. Chỉ đổi biểu thức size ở hàng Unique. Không đổi filter/encoder/PGD, không sweep import lúc boot. `npm test`, `npm run check:server`, `npm run build` trên Windows. Smoke tay một video ngắn operator có quyền tải.

### PR 5 — Optional Netscape cookies file (không thuộc lát cắt dùng được)

- **Title:** Read only the repo-root YouTube cookies file when the operator asks
- **Files:** `server/youtube-import.js`, `YoutubeImportBox.tsx` (một dòng trạng thái, không ô path), `.gitignore` (`.youtube-cookies.txt`), docs ngắn trong `PIPELINES.md` / `VALIDATION.md`, `CHANGELOG_AI.md`
- **Depends on:** PR 4
- **Description:** Không làm trong lát cắt v1, và không bắt đầu cho đến khi operator yêu cầu. Không nhận `cookiesPath` hay bất kỳ path nào từ body. Nếu body có field đó: 400 `Không nhận đường dẫn cookies.`, không spawn. Chỉ khi file đúng `<repo>/.youtube-cookies.txt` tồn tại thì thêm `--cookies` với path đã `realpath` và vẫn nằm tại file đó. Mọi path khác bị bỏ. Không `--cookies-from-browser`, không đọc cookie Chrome, không log nội dung, không commit file. Thiếu file hoặc YouTube vẫn từ chối thì lỗi tiếng Việt và dừng. Bỏ qua PR này thì v1 vẫn đúng thiết kế.
