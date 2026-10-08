#!/usr/bin/env python3
"""Long-lived PGD process. Loads ViT-B-32 once, then runs jobs from stdin.

One JSON object per line. Attack jobs use the same fields as the pgd_clip.py
CLI. Control lines share the socket:

    {"id": "j1", "input": "...", "output": "...", "eps": 3.5, "steps": 3, ...}
    {"id": "s1", "cmd": "sim", "a": "...", "b": "...", "frames": 12}
    {"id": "v1", "cmd": "vram"}
    {"id": "u1", "cmd": "unload"}

Progress stays on stdout as `[PGD] ...` lines between the JSON replies. The
Node side splits those from the JSON. A failed job answers `ok: false` and
the process keeps the model.
"""
from __future__ import annotations

import json
import sys

import torch
import torch.nn.functional as F

from clip_sim import frames
from pgd_clip import load_clip_pack, log, main as run_attack


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def embed_pair(pack: dict, path_a: str, path_b: str, count: int, ffmpeg: str) -> dict:
    device = pack["device"]
    model = pack["model"]
    mean = pack["mean"]
    std = pack["std"]
    with torch.no_grad():
        a = frames(path_a, count, ffmpeg).to(device)
        b = frames(path_b, count, ffmpeg).to(device)
        ea = F.normalize(model.encode_image((a - mean) / std), dim=-1)
        eb = F.normalize(model.encode_image((b - mean) / std), dim=-1)
    n = min(int(ea.shape[0]), int(eb.shape[0]))
    sims = (ea[:n] * eb[:n]).sum(dim=-1)
    return {
        "meanClipSim": round(float(sims.mean()), 4),
        "min": round(float(sims.min()), 4),
        "max": round(float(sims.max()), 4),
        "frames": n,
        "device": str(device),
    }


def vram_payload(request_id) -> dict:
    try:
        free, total = torch.cuda.mem_get_info()
        return {"id": request_id, "ok": True, "freeBytes": int(free), "totalBytes": int(total)}
    except Exception as exc:  # noqa: BLE001
        return {"id": request_id, "ok": False, "error": str(exc)[:200]}


def attack_argv(request: dict) -> list[str]:
    enc = request.get("encArgs") or []
    argv = [
        "--input", str(request["input"]),
        "--output", str(request["output"]),
        "--ffmpeg", str(request.get("ffmpeg") or "ffmpeg"),
        "--eps", str(request.get("eps", 6)),
        "--steps", str(request.get("steps", 4)),
        "--alpha", str(request.get("alpha", 1.5)),
        "--visible-gain", str(request.get("visibleGain", 1)),
        "--target-sim", str(request.get("targetSim", 0)),
        "--eot-views", str(request.get("eotViews", 3)),
        "--eot-mode", str(request.get("eotMode") or "jpeg"),
        "--json-out", str(request.get("jsonOut") or ""),
        "--enc-label", str(request.get("encLabel") or ""),
        "--batch", str(request.get("batch", 8)),
        "--hash-loss", str(request.get("hashLoss", 0)),
        "--frame-step", str(request.get("frameStep", 1)),
        "--amp", str(request.get("amp") or "off"),
        "--pool-size", str(request.get("poolSize", 4)),
        "--adaptive-skip", str(request.get("adaptiveSkip", 0)),
        "--phash-loss", str(request.get("phashLoss", 0)),
    ]
    if enc:
        argv += ["--enc-args", json.dumps(enc)]
    return argv


def serve() -> int:
    pack_box: dict = {"pack": None}
    try:
        pack_box["pack"] = load_clip_pack()
    except Exception as exc:  # noqa: BLE001 - tell the server, then exit
        emit({"ready": False, "error": str(exc)[:200]})
        return 2
    emit({"ready": True, "device": "cuda"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"ok": False, "error": f"bad request: {exc}"})
            continue
        request_id = request.get("id")
        command = request.get("cmd")
        try:
            if command == "vram":
                payload = vram_payload(request_id)
                payload["loaded"] = pack_box["pack"] is not None
                emit(payload)
                continue
            if command == "unload":
                pack_box["pack"] = None
                try:
                    torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                emit({"id": request_id, "ok": True, "unloaded": True})
                continue
            if pack_box["pack"] is None:
                pack_box["pack"] = load_clip_pack()
            if command == "sim":
                result = embed_pair(
                    pack_box["pack"],
                    str(request["a"]),
                    str(request["b"]),
                    int(request.get("frames", 12)),
                    str(request.get("ffmpeg") or "ffmpeg"),
                )
                emit({"id": request_id, "ok": True, **result})
                continue
            code = run_attack(attack_argv(request), pack_box["pack"])
            if code == 0:
                emit({"id": request_id, "ok": True, "warm": True})
            else:
                emit({"id": request_id, "ok": False, "error": f"PGD exit {code}"})
        except Exception as exc:  # noqa: BLE001 - one bad job must not drop the model
            log(f"ERROR: {exc}")
            emit({"id": request_id, "ok": False, "error": str(exc)[:200]})
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
