# GhostForge Local — bản sửa 17/09/2026

## Chạy
Giải nén toàn bộ ZIP vào thư mục mới rồi mở start.bat. Lần đầu launcher cài các gói npm theo package-lock. Bản giao diện đã build nằm trong dist, không cần chạy Vite để sử dụng.

Yêu cầu: Node.js hiện đại (đã thử v24), npm, FFmpeg trong PATH. AI dùng Google Cloud CLI và ADC đang có trên máy; không cần đăng nhập lại nếu phiên hiện tại còn hợp lệ. Ứng dụng chỉ mở trên 127.0.0.1. Nếu 8080 bận hoặc bị chặn, launcher chọn cổng trống và mở URL đúng. Muốn cố định cổng: đặt biến PORT trước khi chạy.

Nếu sửa giao diện/source: chạy npm run build rồi khởi động lại ứng dụng.

## Đã sửa
- Chỉ bind localhost; chặn Host lạ và Origin khác trước API thao tác tệp.
- Export không ghi đè: tự thêm (1), (2)... bằng COPYFILE_EXCL.
- Hộp chọn file/thư mục và gcloud chạy bất đồng bộ, không khóa event loop.
- Escape đường dẫn PowerShell bằng literal, không dùng JSON.stringify để tạo source PowerShell.
- SSE một bộ xử lý mỗi job; kết nối lại nhận lịch sử/kết quả, không chạy lại FFmpeg hoặc gọi AI lần nữa. Lưu tối đa 2000 sự kiện mỗi job.
- DELETE job gọi cơ chế hủy chung, bao gồm AbortController cho request AI.
- Nhận application_default_credentials.json, APPDATA/CLOUDSDK_CONFIG và giữ các đường dẫn cũ.
- PGD kiểm tra Python/thư viện/CUDA trước khi bật; hỗ trợ GHOSTFORGE_PYTHON hoặc .venv/Scripts/python.exe.
- Launcher dùng build có sẵn, tránh phụ thuộc vào esbuild/Vite dev khi chạy bình thường.
- Tab Edit có encoder riêng: Auto, NVIDIA NVENC, Intel QSV hoặc CPU. Encoder áp dụng cho cắt, fade, proxy Gemini, TikTok Pad và Mixed 9:16; GPU lỗi sẽ tự thử lại bằng CPU.

## Encoder của Edit
Mặc định Auto ưu tiên NVIDIA NVENC, sau đó Intel Quick Sync, cuối cùng CPU libx264. Log `[EDIT] Encoder:` cho biết encoder thực tế. Filter crop/scale/blur vẫn chạy trên CPU; GPU tăng tốc bước nén H.264.

Thiết lập NVIDIA hiện dùng preset p4, constant QP 23 cho đầu ra chính; proxy dùng preset nhanh hơn và QP cao hơn. Benchmark nội bộ với video tổng hợp 720p/30fps dài 65 giây: CPU khoảng 3,68 giây, NVIDIA khoảng 3,03 giây; file NVIDIA lớn hơn khoảng 12%. Kết quả thực tế phụ thuộc nội dung, GPU, CPU và filter.

## Kiểm thử đã thực hiện
- Build và kiểm tra cú pháp server: đạt.
- Unique CPU: video tổng hợp 3 giây có âm thanh, đầu ra hợp lệ.
- Hai subscriber SSE cùng job + replay sau khi hoàn thành: cùng hash đầu ra, không chạy lại job.
- Xuất trùng tên: tệp cũ giữ nguyên, tệp mới đổi tên.
- Origin bên ngoài bị từ chối HTTP 403; health vẫn trả 200.
- Health vẫn phản hồi trong khi ADC đang xử lý.
- ADC thật: ok; không lưu credential/token trong gói này.
- AI Reframe thật qua ADC/gemini-3.8-flash: video 3 giây → MP4 1080x1080, done.
- AI Edit thật qua ADC: mẫu 65 giây, chế độ test 60 giây → một clip 58.8 giây, done.
- Giao diện tải được, chuyển Edit và hiển thị ADC ready.

## PGD (tùy chọn, chưa kiểm thử xử lý)
Máy thử không có lệnh python trong PATH. PGD cần Python cùng numpy, torch có hỗ trợ CUDA, open_clip_torch, GPU NVIDIA tương thích và model CLIP. Danh sách thư viện nằm trong requirements-pgd.txt. Nếu đã có môi trường này, đặt GHOSTFORGE_PYTHON thành đường dẫn python.exe của môi trường đó. Ứng dụng cũng tự nhận .venv/Scripts/python.exe cạnh server.

Không dùng Python đi kèm Google Cloud SDK để cài thư viện PGD, nhằm tránh ảnh hưởng gcloud đang hoạt động. Khả năng chạy PGD và model download chưa được xác nhận. Các phiên thử không chứng minh app không còn mọi lỗi hoặc bảo đảm tránh nhận diện nội dung của nền tảng.
