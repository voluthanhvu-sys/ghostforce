#!/usr/bin/env python3
"""Long-lived CLIP helper for the Unique measurement stage.

Starting `python`, importing torch + open_clip and loading ViT-B-32 costs ~4.7 s on every
clip, which was most of the measurement stage (measured on 2026-09-28: 3.0 s imports,
1.7 s model, 0.6 s for the 12 frames). This process pays that once and then answers
requests on stdin, one JSON object per line:

    {"id": "r1", "a": "<source>", "b": "<render>", "frames": 12}

and answers on stdout, one JSON object per line:

    {"ready": true, "device": "cuda"}
    {"id": "r1", "ok": true, "meanClipSim": 0.9812, "min": ..., "max": ..., "frames": 12, "device": "cuda"}
    {"id": "r1", "ok": false, "error": "..."}

The server falls back to the one-shot `clip_sim.py` if this process cannot start, dies or
times out, so a broken helper degrades to the old behaviour instead of failing a job.
Frame extraction is shared with clip_sim.py on purpose - one definition of the method.
"""
from __future__ import annotations

import json
import sys

import torch
import torch.nn.functional as F
import open_clip

from clip_sim import MEAN, MODEL, PRETRAINED, STD, frames


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED, device=device)[0]
    model.eval()
    mean = torch.tensor(MEAN, device=device).view(1, 3, 1, 1)
    std = torch.tensor(STD, device=device).view(1, 3, 1, 1)
    emit({"ready": True, "device": str(device)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:  # noqa: BLE001 - a bad line must not kill the helper
            emit({"ok": False, "error": f"bad request: {exc}"})
            continue
        request_id = request.get("id")
        command = request.get("cmd")
        # Control requests used by the server before a PGD pass: report free VRAM, or drop
        # the weights (keeping the process and the imported torch alive) so PGD can load its
        # own copy on a small card. The model is loaded again lazily on the next measure.
        if command == "vram":
            try:
                free, total = torch.cuda.mem_get_info()
                emit({"id": request_id, "ok": True, "freeBytes": int(free), "totalBytes": int(total)})
            except Exception as exc:  # noqa: BLE001
                emit({"id": request_id, "ok": False, "error": str(exc)[:200]})
            continue
        if command == "unload":
            model = None
            try:
                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
            emit({"id": request_id, "ok": True, "unloaded": True})
            continue
        try:
            if model is None:
                model = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED, device=device)[0]
                model.eval()
            count = int(request.get("frames", 12))
            with torch.no_grad():
                a = frames(request["a"], count).to(device)
                b = frames(request["b"], count).to(device)
                ea = F.normalize(model.encode_image((a - mean) / std), dim=-1)
                eb = F.normalize(model.encode_image((b - mean) / std), dim=-1)
            n = min(ea.shape[0], eb.shape[0])
            sims = (ea[:n] * eb[:n]).sum(dim=-1)
            emit({
                "id": request_id,
                "ok": True,
                "meanClipSim": round(float(sims.mean()), 4),
                "min": round(float(sims.min()), 4),
                "max": round(float(sims.max()), 4),
                "frames": int(n),
                "device": str(device),
            })
        except Exception as exc:  # noqa: BLE001 - report per request and keep serving
            emit({"id": request_id, "ok": False, "error": str(exc)[:200]})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
