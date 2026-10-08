#!/usr/bin/env python3
"""Measure how far a render moved from its source in CLIP embedding space.

The same ViT-B-32 that pgd_clip.py uses decodes a handful of matching moments from both
files and reports the mean cosine similarity, so a Unique run has a semantic number even
when PGD is off (before this, the panel only had dHash/pHash, which measure the picture,
not the content).

Prints one machine-readable line for the backend:

    CLIPSIM {"meanClipSim": 0.9812, "min": 0.97, "max": 0.99, "frames": 12, "device": "cuda"}

Lower = the content moved further from the source (1.0 = identical). It is an operator
estimate from a few frames, not a platform dedup verdict and not CLIP-PGD.
"""
from __future__ import annotations

import argparse
import json
import subprocess

import numpy as np
import open_clip
import torch
import torch.nn.functional as F

SIZE = 224
MODEL = "ViT-B-32"
PRETRAINED = "laion2b_s34b_b79k"
MEAN = [0.48145466, 0.4578275, 0.40821073]
STD = [0.26862954, 0.26130258, 0.27577711]


def log(msg: str) -> None:
    line = f"[CLIP] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def frames(path: str, count: int, ffmpeg: str = "ffmpeg") -> torch.Tensor:
    cmd = [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-i", path,
        "-vf", f"fps=3,scale={SIZE}:{SIZE}", "-frames:v", str(count),
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ]
    raw = subprocess.run(cmd, capture_output=True).stdout
    arr = np.frombuffer(raw, np.uint8)
    k = len(arr) // (SIZE * SIZE * 3)
    if k == 0:
        raise RuntimeError(f"no frames decoded from {path}")
    tensor = torch.from_numpy(arr[: k * SIZE * SIZE * 3].copy()).reshape(k, SIZE, SIZE, 3)
    return tensor.permute(0, 3, 1, 2).float().div(255.0)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--a", required=True, help="source file")
    p.add_argument("--b", required=True, help="rendered file")
    p.add_argument("--frames", type=int, default=12)
    p.add_argument("--ffmpeg", default="ffmpeg")
    args = p.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model, _, _ = open_clip.create_model_and_transforms(MODEL, pretrained=PRETRAINED, device=device)
    model.eval()
    mean = torch.tensor(MEAN, device=device).view(1, 3, 1, 1)
    std = torch.tensor(STD, device=device).view(1, 3, 1, 1)

    with torch.no_grad():
        a = frames(args.a, args.frames, args.ffmpeg).to(device)
        b = frames(args.b, args.frames, args.ffmpeg).to(device)
        ea = F.normalize(model.encode_image((a - mean) / std), dim=-1)
        eb = F.normalize(model.encode_image((b - mean) / std), dim=-1)

    n = min(ea.shape[0], eb.shape[0])
    sims = (ea[:n] * eb[:n]).sum(dim=-1)
    result = {
        "meanClipSim": round(float(sims.mean()), 4),
        "min": round(float(sims.min()), 4),
        "max": round(float(sims.max()), 4),
        "frames": int(n),
        "device": str(device),
    }
    log(f"mean {result['meanClipSim']} · {n} frames · {device}")
    print("CLIPSIM " + json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001 - the backend treats any failure as "skipped"
        log(f"ERROR: {exc}")
        raise SystemExit(1)
