"""Read-only TikTokApi hashtag video bridge; writes one JSON object to stdout."""
import asyncio
import json
import os
from pathlib import Path
import sys

sys.stdout.reconfigure(encoding="utf-8")


async def main():
    from TikTokApi import TikTokApi

    tag = sys.argv[1]
    count = int(sys.argv[2])
    token = os.environ.get("TIKTOK_MS_TOKEN")
    session_file = Path(__file__).resolve().parent / ".tiktok-api-session" / "storage-state.json"
    cookies = {}
    if session_file.exists():
        state = json.loads(session_file.read_text(encoding="utf-8"))
        cookies = {cookie["name"]: cookie["value"] for cookie in state.get("cookies", [])
                   if cookie.get("name") and cookie.get("value") and
                   cookie.get("domain", "").lstrip(".") in ("tiktok.com", "www.tiktok.com")}
        if not token:
            token = cookies.get("msToken")
    if not token:
        raise RuntimeError("Chưa có phiên TikTok.com (msToken). TikTok đã trả HTTP 403 trong Chromium trên máy này nên chưa thể dùng tìm kiếm hashtag. Danh sách video Creative Center ở bên dưới vẫn hoạt động.")
    async with TikTokApi() as api:
        await api.create_sessions(
            ms_tokens=[token],
            cookies=[cookies] if cookies else None,
            num_sessions=1,
            sleep_after=3,
            browser=os.environ.get("TIKTOK_BROWSER", "chromium"),
        )
        rows = []
        async for video in api.hashtag(name=tag).videos(count=count):
            data = video.as_dict
            author = data.get("author") or {}
            stats = data.get("stats") or {}
            video_data = data.get("video") or {}
            video_id = str(data.get("id") or video.id or "")
            handle = author.get("uniqueId") or ""
            if not video_id:
                continue
            rows.append({
                "id": video_id,
                "title": data.get("desc") or "",
                "url": f"https://www.tiktok.com/@{handle}/video/{video_id}" if handle else f"https://www.tiktok.com/video/{video_id}",
                "authorHandle": handle,
                "views": stats.get("playCount") or 0,
                "durationSec": video_data.get("duration"),
            })
        print(json.dumps({"videos": rows}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        message = str(exc)
        if "TikTok returned an empty response" in message:
            message = "TikTok từ chối truy vấn tự động. Danh sách video Creative Center bên dưới vẫn hoạt động; tìm kiếm hashtag cần một phiên TikTok.com được TikTok chấp nhận."
        print(json.dumps({"error": message}, ensure_ascii=False))
        sys.exit(1)
