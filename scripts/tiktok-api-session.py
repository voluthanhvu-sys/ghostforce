"""Save a user-approved TikTok.com browser session for hashtag lookup."""
import asyncio
import json
import getpass
import sys
from pathlib import Path

from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8")


ROOT = Path(__file__).resolve().parent.parent
SESSION_DIR = ROOT / ".tiktok-api-session"
STATE_FILE = SESSION_DIR / "storage-state.json"


async def main():
    if "--manual-token" in sys.argv:
        token = getpass.getpass("Dán giá trị msToken từ cookie TikTok.com của Opera GX Family security (không hiện trên màn hình): ").strip()
        if not token or any(character.isspace() for character in token):
            raise RuntimeError("msToken trống hoặc không hợp lệ.")
        SESSION_DIR.mkdir(exist_ok=True)
        state = {"cookies": [{"name": "msToken", "value": token, "domain": ".tiktok.com", "path": "/"}], "origins": []}
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
        print("Đã lưu msToken cục bộ. Không gửi giá trị này qua chat.")
        return
    SESSION_DIR.mkdir(exist_ok=True)
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            str(SESSION_DIR / "profile"), headless=False
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            response = await page.goto("https://www.tiktok.com/", wait_until="domcontentloaded")
            if response and response.status == 403:
                raise RuntimeError(
                    "TikTok.com trả HTTP 403 cho trình duyệt này. Không thể tạo phiên từ trang bị chặn; "
                    "đóng cửa sổ này và dùng danh sách Creative Center trong tab Xu hướng."
                )
            print("Hoàn tất truy cập TikTok.com trong cửa sổ trình duyệt.")
            print("Khi trang TikTok hoạt động bình thường, quay lại đây và nhấn Enter.")
            await asyncio.to_thread(input)
            state = await context.storage_state()
            tokens = [cookie for cookie in state["cookies"] if cookie["name"] == "msToken"
                      and cookie.get("value") and cookie.get("domain", "").lstrip(".") in ("tiktok.com", "www.tiktok.com")]
            if not tokens:
                raise RuntimeError("Phiên chưa có cookie msToken. Nếu TikTok hiển thị HTTP 403, không thể lưu phiên từ cửa sổ này.")
            STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
            print("Đã lưu phiên TikTok.com cho tìm kiếm hashtag.")
        finally:
            await context.close()


if __name__ == "__main__":
    asyncio.run(main())
