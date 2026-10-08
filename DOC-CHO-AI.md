# GhostForge — gói source để AI đọc tiếp

Ngày đóng gói: 2026-10-08.
Đây là working tree đang chạy, gồm file đã commit và phần chưa commit. Không phải bản git sạch.

Đọc theo thứ tự, đừng quét cả repo:
1. AGENTS.md
2. ARCHITECTURE.md và CODEMAP.md
3. Đúng một mục trong PIPELINES.md
4. CURRENT_STATE.md
5. VALIDATION.md trước khi chạy lệnh
6. AI_INTEGRATIONS.md chỉ khi việc đụng AI, STT hoặc FFmpeg

Người vận hành viết tiếng Việt. Chỉ sửa code khi họ nói "thực hiện".

Đã bỏ khỏi gói vì nặng hoặc là bí mật:
- node_modules, .venv, .local-ai, dist, .git
- uploads (video đã render, gemini-keys.json)
- tmp, cache, output
- yolov8n.pt và tools/realesrgan (exe, dll, model .bin)

Trên máy gốc: npm install rồi npm test. Không cần file này để chạy app.
