#!/usr/bin/env python3
"""CLIP PGD + EOT (jpeg/resize) for GhostForge. Unique FFmpeg stays unchanged."""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import subprocess
import threading
from queue import Queue

import numpy as np
import torch
import torch.nn.functional as F
import open_clip


def log(msg: str) -> None:
    line = f"[PGD] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def read_exact(stream, n: int):
    """One preallocated buffer + readinto: the 64 KB chunk loop cost ~0.8 s per 60 frames."""
    buf = bytearray(n)
    view = memoryview(buf)
    off = 0
    while off < n:
        got = stream.readinto(view[off:])
        if not got:
            return None
        off += got
    return buf


def write_exact(stream, data: bytes) -> None:
    # One write of the whole batch. The 64 KB loop belonged to the old reader;
    # the encoder pipe blocks until FFmpeg takes the bytes, which is what the
    # writer thread is for. A short write is retried from where it stopped.
    view = memoryview(data)
    off = 0
    while off < len(view):
        n = stream.write(view[off:])
        if not n:
            raise RuntimeError("encoder stdin closed")
        off += n


def probe(ffmpeg: str, src: str):
    r = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", src],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    err = r.stderr or ""
    w = h = 0
    fps = 30.0
    dur = 0.0
    import re
    m = re.search(r"(\d{2,5})x(\d{2,5})", err)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    fm = re.search(r"(\d+(?:\.\d+)?)\s*fps", err) or re.search(r"(\d+(?:\.\d+)?)\s*tbr", err)
    if fm:
        fps = float(fm.group(1))
    dm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", err)
    if dm:
        dur = int(dm.group(1)) * 3600 + int(dm.group(2)) * 60 + float(dm.group(3))
    has_audio = "Audio:" in err
    if w < 16 or h < 16:
        raise RuntimeError("Could not probe video size")
    return w, h, fps, dur, has_audio


def default_target(steps: int, override: float) -> float:
    if override > 0:
        return min(0.995, max(0.70, override))
    if steps <= 3:
        return 0.965
    if steps <= 4:
        return 0.950
    if steps <= 8:
        return 0.930
    return 0.880


def jpeg_ste(x: torch.Tensor, q: float) -> torch.Tensor:
    """Straight-through fake JPEG: quantize to q levels, gradient passes through."""
    y = x.clamp(0, 1) * q
    yq = y.round()
    return (y + (yq - y).detach()) / q


# Standard JPEG luminance quantization table, the shape an 8x8 DCT quantizer uses.
# Only the SHAPE matters here: it is a straight-through model of block-DCT
# quantization, not a bit-exact H.264 encoder.
_JPEG_LUMA = (
    (16, 11, 10, 16, 24, 40, 51, 61),
    (12, 12, 14, 19, 26, 58, 60, 55),
    (14, 13, 16, 24, 40, 57, 69, 56),
    (14, 17, 22, 29, 51, 87, 80, 62),
    (18, 22, 37, 56, 68, 109, 103, 77),
    (24, 35, 55, 64, 81, 104, 113, 92),
    (49, 64, 78, 87, 103, 121, 120, 101),
    (72, 92, 95, 98, 112, 100, 103, 99),
)


def _dct_basis(n: int = 8, device=None, dtype=torch.float32) -> torch.Tensor:
    """Orthonormal DCT-II basis: `B @ x @ B.T` is the 2-D DCT of x."""
    idx = torch.arange(n, device=device, dtype=dtype)
    k = idx.view(-1, 1)
    basis = torch.cos(math.pi * (2 * idx.view(1, -1) + 1) * k / (2 * n))
    basis = basis * math.sqrt(2.0 / n)
    basis[0] = basis[0] / math.sqrt(2.0)
    return basis


def codec_ste(x: torch.Tensor, qscale: float = 1.0) -> torch.Tensor:
    """Straight-through model of a block codec: 8x8 DCT quantize, 4:2:0, deblock.

    This is the view the current EOT was missing: the real second encode does not
    quantize each pixel evenly, it quantizes DCT blocks, subsamples chroma and
    filters block edges. `qscale` 1.0 approximates the JPEG table at its nominal
    strength; 2.0 is a low-bitrate encode.
    """
    n, c, h, w = x.shape
    pad_h = (8 - h % 8) % 8
    pad_w = (8 - w % 8) % 8
    if pad_h or pad_w:
        x = F.pad(x, (0, pad_w, 0, pad_h), mode="replicate")
    h2, w2 = x.shape[-2], x.shape[-1]

    blocks = x.view(n, c, h2 // 8, 8, w2 // 8, 8).permute(0, 1, 2, 4, 3, 5)
    basis = _dct_basis(8, device=x.device, dtype=x.dtype)
    coeff = basis @ blocks @ basis.transpose(-1, -2)

    step = torch.tensor(_JPEG_LUMA, device=x.device, dtype=x.dtype).view(1, 1, 1, 1, 8, 8)
    step = (step / 255.0) * qscale
    quant = torch.round(coeff / step) * step
    coeff = coeff + (quant - coeff).detach()

    out = basis.transpose(-1, -2) @ coeff @ basis
    out = out.permute(0, 1, 2, 4, 3, 5).reshape(n, c, h2, w2)
    if pad_h or pad_w:
        out = out[:, :, :h, :w]
    out = out.clamp(0, 1)

    # 4:2:0 chroma: average 2x2, then back up (gradient flows through the upsample).
    chroma = F.interpolate(F.avg_pool2d(out, 2), size=(h, w), mode="bilinear", align_corners=False)
    # Luma keeps the block-coded values; chroma carries the 4:2:0 round trip.
    out = torch.cat([out[:, :1], chroma[:, 1:]], dim=1) if c > 1 else out

    # Deblocking / low-pass proxy: a 3x3 mean, the cheapest stand-in for the
    # in-loop filter that smears block edges.
    out = F.avg_pool2d(F.pad(out, (1, 1, 1, 1), mode="replicate"), 3, 1)
    return out.clamp(0, 1)


def ladder_ste(x: torch.Tensor, small: int = 149) -> torch.Tensor:
    """Down-and-up through one platform rung (224 -> 149 -> 224 is 1080 -> 720)."""
    low = F.interpolate(x, size=(small, small), mode="bilinear", align_corners=False)
    return F.interpolate(low, size=(x.shape[-2], x.shape[-1]), mode="bilinear", align_corners=False)


def eot_stack(adv: torch.Tensor, k: int, mode: str = "jpeg") -> torch.Tensor:
    """adv: 1x3x224x224 in [0,1]. Identity + the views EOT trains against.

    `jpeg` is the long-standing behaviour and stays the default. `codec` and
    `ladder` add the two transforms the platform applies and the old stack did
    not model; `mix` is both of them plus the old jpeg/resize views.
    """
    views = [adv]
    if k <= 1:
        return adv
    if mode == "codec":
        # Two quantizer strengths: a mild rung and a low-bitrate one.
        views.append(codec_ste(adv, 1.0))
        views.append(codec_ste(adv, 1.8))
    elif mode == "ladder":
        views.append(ladder_ste(adv, 149))   # 1080 -> 720
        views.append(ladder_ste(adv, 112))   # 1080 -> 540
    elif mode == "mix":
        views.append(codec_ste(adv, 1.0))
        views.append(ladder_ste(adv, 149))
        if k >= 4:
            views.append(codec_ste(ladder_ste(adv, 149), 1.6))
    if mode in ("codec", "ladder", "mix"):
        if len(views) < k:
            # Remaining slots keep the transforms the shipped stack always had.
            tiny = F.interpolate(adv, size=(112, 112), mode="bilinear", align_corners=False)
            views.append(jpeg_ste(F.interpolate(tiny, size=(224, 224), mode="bilinear",
                                                align_corners=False), 16.0))
        return torch.cat(views[:k], dim=0)
    tiny = F.interpolate(adv, size=(112, 112), mode="bilinear", align_corners=False)
    back = F.interpolate(tiny, size=(224, 224), mode="bilinear", align_corners=False)
    views.append(jpeg_ste(back, 16.0))
    if k >= 3:
        mid = F.interpolate(adv, size=(160, 160), mode="bilinear", align_corners=False)
        mid = F.interpolate(mid, size=(224, 224), mode="bilinear", align_corners=False)
        views.append(jpeg_ste(mid, 24.0))
    if k >= 4:
        big = F.interpolate(adv, size=(256, 256), mode="bilinear", align_corners=False)
        top = int(torch.randint(0, 33, (1,), device=adv.device).item())
        left = int(torch.randint(0, 33, (1,), device=adv.device).item())
        crop = big[:, :, top:top + 224, left:left + 224]
        views.append(jpeg_ste(crop, 20.0))
    return torch.cat(views[:k], dim=0)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--eps", type=float, default=6.0)
    p.add_argument("--steps", type=int, default=4)
    p.add_argument("--alpha", type=float, default=1.5)
    p.add_argument("--target-sim", type=float, default=0.0)
    p.add_argument("--visible-gain", type=float, default=1.0)
    p.add_argument("--eot-views", type=int, default=3, help="1=off (old PGD), 3-4=jpeg+resize EOT")
    p.add_argument("--eot-mode", default="jpeg",
                   choices=["jpeg", "codec", "ladder", "mix"],
                   help="which transform stack EOT trains against; 'jpeg' is the shipped default")
    p.add_argument("--json-out", default="")
    # The encoder for the PGD re-encode. It used to be hardcoded libx264 crf16, which
    # ignored the operator's Encoder choice: measured 1.7 MB -> 6.3 MB on a 4 s clip.
    # The server resolves the choice (and smoke-tests it) and passes the exact FFmpeg
    # video args as a JSON array, so this script never guesses which GPU it has.
    p.add_argument("--enc-args", default="", help="JSON array of FFmpeg video encoder args (empty = libx264 crf16)")
    p.add_argument("--enc-label", default="CPU libx264 veryfast crf 16")
    p.add_argument("--batch", type=int, default=8, help="frames attacked per forward/backward pass (1 = old behaviour)")
    p.add_argument("--hash-loss", type=float, default=0.0, help="weight of the soft-dHash term added to the CLIP loss (0 = CLIP only)")
    p.add_argument("--phash-loss", type=float, default=0.0,
                   help="weight of the soft-DCT-pHash term added to the CLIP loss (0 = off). The shipped "
                        "attack barely moves pHash after a re-encode, this term is the experiment for it.")
    p.add_argument("--frame-step", type=int, default=1, help="attack one frame every N and give the in-between frames the same perturbation (1 = attack every frame)")
    p.add_argument("--pool-size", type=int, default=4,
                   help="the residual is avg-pooled by this factor in the 224px attack space before it is written "
                        "(4 = shipped behaviour; higher = lower-frequency, more compression-robust perturbation)")
    p.add_argument("--amp", default="off", choices=["off", "bf16", "fp16"],
                   help="mixed precision for the attack forward/backward (off = shipped float32)")
    p.add_argument("--adaptive-skip", type=float, default=0.0,
                   help="reuse the previous attacked frame's perturbation when the 224px picture is within this "
                        "mean-abs difference (0 = shipped behaviour, e.g. 0.004 for near-static shots)")
    p.add_argument("--compile", action="store_true",
                   help="torch.compile the CLIP encoder (amortises on the warm server; a one-shot run pays the "
                        "compile each time)")
    return p


def load_clip_pack():
    """One ViT-B-32 on CUDA. The warm server calls this once and passes the pack
    into every later main() so a batch of clips does not pay the load again."""
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA not available")
    device = torch.device("cuda")
    # `GHOSTFORGE_CLIP_WEIGHTS` points at a local open_clip .safetensors/.pt file.
    # It exists for hosts where the Hugging Face cache is read-only or the hub is
    # unreachable: the weights are the same laion2b_s34b_b79k ViT-B-32, only the
    # source of the file changes. Unset (the normal case) keeps the hub path.
    local_weights = os.environ.get("GHOSTFORGE_CLIP_WEIGHTS", "").strip()
    if local_weights and os.path.exists(local_weights):
        log("Loading CLIP ViT-B-32 from a local checkpoint...")
        model, _, _ = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained=local_weights, device=device
        )
    else:
        log("Loading CLIP ViT-B-32 (first run downloads ~350MB)...")
        model, _, _ = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", device=device
        )
    model.eval()
    model.float()
    for param in model.parameters():
        param.requires_grad = False
    mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device).view(1, 3, 1, 1)
    std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device).view(1, 3, 1, 1)
    return {"device": device, "model": model, "mean": mean, "std": std}


def main(argv=None, pack=None) -> int:
    args = build_parser().parse_args(argv)

    enc_video_args = []
    if args.enc_args.strip():
        try:
            parsed = json.loads(args.enc_args)
            enc_video_args = [str(part) for part in parsed]
        except Exception as exc:  # noqa: BLE001 - any bad value falls back to the safe default
            log(f"WARN: --enc-args not usable ({exc}) - falling back to libx264 crf16")
            enc_video_args = []
    if not enc_video_args:
        enc_video_args = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p"]
        args.enc_label = "CPU libx264 veryfast crf 16"

    if pack is None:
        try:
            pack = load_clip_pack()
        except RuntimeError as exc:
            log(f"ERROR: {exc} — skip PGD")
            return 2
    else:
        log("warm model: CLIP already loaded")

    device = pack["device"]
    model = pack["model"]
    mean = pack["mean"]
    std = pack["std"]
    w, h, fps, dur, has_audio = probe(args.ffmpeg, args.input)
    n_est = max(1, int(round(dur * fps)))
    steps = max(1, args.steps)
    target = default_target(steps, args.target_sim)
    eot_k = max(1, min(4, int(args.eot_views)))
    eot_mode = str(args.eot_mode or "jpeg")
    log(f"GPU {torch.cuda.get_device_name(0)} · {w}x{h} @{fps:.2f}fps ~{n_est} frames")
    eps = args.eps / 255.0
    pool_size = max(1, min(28, int(args.pool_size)))
    amp_mode = str(args.amp or "off")
    amp_dtype = torch.bfloat16 if amp_mode == "bf16" else (torch.float16 if amp_mode == "fp16" else None)
    adaptive_skip = max(0.0, float(args.adaptive_skip or 0.0))
    skip_carry = {"small": None, "delta": None}
    skipped_frames = 0
    alpha = args.alpha / 255.0
    vis_gain = max(1.0, float(args.visible_gain))
    demo = vis_gain >= 8.0
    hash_weight = max(0.0, float(args.hash_loss))
    phash_weight = max(0.0, float(args.phash_loss))
    frame_step = max(1, int(args.frame_step))
    # Frames move through the pipes as yuv420p (half the bytes of rgb24: 3.1 MB vs 6.2 MB for
    # 1080x1920). Measured: the frame plumbing was the largest single cost of the loop, so the
    # colour conversion is done on the GPU instead of letting the two ffmpeg processes trade
    # full RGB frames. BT.709 limited range, which is what the Unique output uses.
    uv_w = w // 2
    uv_h = h // 2
    y_size = w * h
    uv_size = uv_w * uv_h
    frame_bytes = y_size + 2 * uv_size
    if hash_weight > 0:
        log(f"hash loss ON · weight {hash_weight:.2f} (soft 17x16 dHash term added to the CLIP loss)")
    if demo:
        log(f"VISIBLE TEST gain x{vis_gain:.0f} — unwatchable on purpose. Do not upload.")
    if eot_k > 1:
        log(f"EOT ON · {eot_k} views · mode {eot_mode} · long-wave pool-4 · no full-frame carrier")
    else:
        log("EOT off (clean CLIP only) · long-wave pool-4 · no full-frame carrier")

    def clip_emb(img01: torch.Tensor) -> torch.Tensor:
        x = (img01 - mean) / std
        return F.normalize(model.encode_image(x), dim=-1)

    def amp_ctx():
        """Mixed-precision region for the attack. The update is sign(grad) plus a
        clamp, so reduced precision cannot rescale the step the way a
        magnitude-scaled optimiser would."""
        return torch.autocast("cuda", dtype=amp_dtype or torch.float32, enabled=amp_dtype is not None)

    if args.compile:
        try:
            compiled = torch.compile(clip_emb, mode="default")
            # Trace once here so a backend that cannot compile (Windows has no
            # official Triton build, and inductor needs it) fails now, where it can
            # fall back to eager, instead of killing the job mid-clip.
            with torch.no_grad():
                compiled(torch.zeros(1, 3, 224, 224, device=device))
            clip_emb = compiled
            log("torch.compile enabled for the CLIP encoder")
        except Exception as exc:  # noqa: BLE001 - a compile failure must not kill the job
            log(f"torch.compile unavailable, staying eager: {exc}")

    def midband_carrier(hh: int, ww: int, amp: float, phase: torch.Tensor) -> torch.Tensor:
        """phase: (N,) tensor of per-frame phases -> (N,3,hh,ww) carrier pattern."""
        batch = int(phase.shape[0])
        ys = torch.arange(hh, device=device, dtype=torch.float32).view(1, 1, hh, 1)
        xs = torch.arange(ww, device=device, dtype=torch.float32).view(1, 1, 1, ww)
        p = phase.view(batch, 1, 1, 1)
        r = torch.sin(2 * 3.14159265 * xs / 32.0 + p).expand(batch, 1, hh, ww)
        g = torch.sin(2 * 3.14159265 * ys / 28.0 + p * 1.31).expand(batch, 1, hh, ww)
        bch = torch.cos(2 * 3.14159265 * (xs + ys) / 36.0 + p * 0.73)
        return amp * torch.cat([r, g, bch], dim=1)

    def soft_dhash(x01: torch.Tensor) -> torch.Tensor:
        """Differentiable 17x16 dHash of a batch, values in [-1,1] (sign = the real bit).
        Same feature family the app measures after the render (17x16 grey, compare with the
        right neighbour), so a loss on it pushes the frames apart on the classic perceptual
        hash as well as on CLIP."""
        gray = 0.299 * x01[:, 0:1] + 0.587 * x01[:, 1:2] + 0.114 * x01[:, 2:3]
        small = F.interpolate(gray, size=(16, 17), mode="bilinear", align_corners=False)
        diff = small[:, :, :, 1:] - small[:, :, :, :-1]
        return torch.tanh(diff * 255.0 * 4.0)

    def soft_phash(x01: torch.Tensor) -> torch.Tensor:
        """Differentiable 63-bit DCT pHash - the same family the app measures after the
        render (32x32 downsample, 8x8 low-frequency block, DC dropped). The real hash
        thresholds each coefficient against the median of that block; here the sign of
        (coefficient - block mean) stands in for the bit, which is differentiable and
        keeps the same ordering information."""
        gray = 0.299 * x01[:, 0:1] + 0.587 * x01[:, 1:2] + 0.114 * x01[:, 2:3]
        small = F.interpolate(gray, size=(32, 32), mode="bilinear", align_corners=False)
        basis = _dct_basis(32, device=x01.device, dtype=x01.dtype)
        coeff = torch.matmul(torch.matmul(basis, small), basis.transpose(-1, -2))
        ac = coeff[:, :, :8, :8].reshape(coeff.shape[0], -1)[:, 1:]
        ac = ac - ac.mean(dim=-1, keepdim=True)
        scale = 2.0 / (ac.abs().mean(dim=-1, keepdim=True) + 1e-6)
        return torch.tanh(ac * scale)

    def yuv_to_rgb(raw: torch.Tensor, n: int) -> torch.Tensor:
        """(N, frame_bytes) uint8 yuv420p -> (N,3,h,w) float in [0,1]."""
        flat = raw.float()
        y = flat[:, :y_size].view(n, 1, h, w)
        u = flat[:, y_size:y_size + uv_size].view(n, 1, uv_h, uv_w)
        v = flat[:, y_size + uv_size:y_size + 2 * uv_size].view(n, 1, uv_h, uv_w)
        u = F.interpolate(u, size=(h, w), mode="bilinear", align_corners=False)
        v = F.interpolate(v, size=(h, w), mode="bilinear", align_corners=False)
        yf = (y - 16.0) * (255.0 / 219.0)
        cb = (u - 128.0) * (255.0 / 224.0)
        cr = (v - 128.0) * (255.0 / 224.0)
        rgb = torch.cat([yf + 1.5748 * cr, yf - 0.1873 * cb - 0.4681 * cr, yf + 1.8556 * cb], dim=1)
        return (rgb / 255.0).clamp(0, 1)

    def project_delta(delta: torch.Tensor, pool: int = 4) -> torch.Tensor:
        """The residual the file stores: NxN average, then back to 224.

        The loss has to see this projection. A gradient spent on finer detail
        is thrown away before the encoder, and the next compress throws away
        whatever of it the encoder kept.
        """
        k = max(1, min(28, int(pool)))
        coarse = F.avg_pool2d(delta, kernel_size=k, stride=k)
        return F.interpolate(coarse, size=(224, 224), mode="bilinear", align_corners=False)

    def rgb_to_yuv(rgb: torch.Tensor) -> torch.Tensor:
        """(N,3,h,w) float in [0,1] -> (N, frame_bytes) uint8 yuv420p."""
        n = rgb.shape[0]
        r = rgb[:, 0:1] * 255.0
        g = rgb[:, 1:2] * 255.0
        b = rgb[:, 2:3] * 255.0
        yf = 0.2126 * r + 0.7152 * g + 0.0722 * b
        y = (yf * (219.0 / 255.0) + 16.0).round().clamp(0, 255).view(n, y_size)
        cb = F.avg_pool2d((b - yf) / 1.8556, kernel_size=2, stride=2)
        cr = F.avg_pool2d((r - yf) / 1.5748, kernel_size=2, stride=2)
        u = (cb * (224.0 / 255.0) + 128.0).round().clamp(0, 255).view(n, uv_size)
        v = (cr * (224.0 / 255.0) + 128.0).round().clamp(0, 255).view(n, uv_size)
        return torch.cat([y, u, v], dim=1).to(torch.uint8)

    def attack_batch(batch_np: np.ndarray, start_i: int):
        """Attack N frames in one pass. The frames are independent (each has its own phase,
        its own delta and its own loss term), so batching changes nothing except how many
        frames share a forward/backward call. `start_i` keeps the per-frame phase identical
        to the one-frame-at-a-time version."""
        nonlocal skipped_frames
        n = int(batch_np.shape[0])
        t = yuv_to_rgb(torch.from_numpy(batch_np).to(device, non_blocking=True), n)
        small = F.interpolate(t, size=(224, 224), mode="bilinear", align_corners=False)
        with torch.no_grad():
            orig_e = clip_emb(small).detach()
            orig_hash = soft_dhash(small).detach() if hash_weight > 0 else None
            orig_phash = soft_phash(small).detach() if phash_weight > 0 else None
        # The backstop carrier's phase steps fast (per-frame decorrelation) instead of crawling
        # (0.21 rad/frame): the amplitude is identical, the attack is identical, but the eye can
        # no longer track the pattern from frame to frame, so a faint texture reads as noise
        # rather than as stripes.
        phase = torch.arange(start_i, start_i + n, device=device, dtype=torch.float32) * 1.9
        delta = midband_carrier(224, 224, 0.35 * eps, phase)
        used = 0
        sims = torch.ones(n, device=device)
        # Frames are independent, so a frame that already reached the target stops being
        # updated while the laggards keep going. Before this, every frame in a group ran all
        # `steps` iterations as long as ONE frame was still above target, which is where the
        # measured overshoot came from (strong level finished at 0.8164 against a 0.93 target).
        active = torch.ones(n, dtype=torch.bool, device=device)
        # Content-adaptive skipping: a frame whose 224px picture is within `adaptive_skip`
        # of the last attacked frame reuses that frame's perturbation and pays no
        # forward/backward pass at all. Static shots (the bulk of talking-head footage)
        # collapse to one attack per scene; a cut always gets its own.
        reuse = None
        if adaptive_skip > 0.0 and skip_carry["small"] is not None:
            diff = (small - skip_carry["small"]).abs().mean(dim=(1, 2, 3))
            reuse = diff <= adaptive_skip
            reuse_n = int(reuse.sum())
            if reuse_n:
                skipped_frames += reuse_n
                delta = torch.where(reuse.view(-1, 1, 1, 1), skip_carry["delta"].expand_as(delta), delta)
                active = active & ~reuse
        # Attack every `frame_step`-th frame only: the frames in between inherit the leader's
        # perturbation. The point is speed (half the forward/backward passes at step 2); the
        # question the operator asked is what it costs in picture quality and attack strength.
        idx_in_group = torch.arange(n, device=device)
        leader_local = idx_in_group.clone()
        if frame_step > 1:
            global_idx = start_i + idx_in_group
            leader_local = torch.clamp(idx_in_group - (global_idx % frame_step), min=0)
            active = active & (idx_in_group == leader_local)
        for _ in range(steps):
            idx = torch.nonzero(active, as_tuple=False).flatten()
            if idx.numel() == 0:
                break
            sub_delta = delta.index_select(0, idx).detach().requires_grad_(True)
            sub_small = small.index_select(0, idx)
            sub_orig_e = orig_e.index_select(0, idx)
            adv = (sub_small + project_delta(sub_delta, pool_size)).clamp(0, 1)
            views = eot_stack(adv, eot_k, eot_mode)
            with amp_ctx():
                e = clip_emb(views)
                # views are stacked view-major: [view0 of all frames, view1 of all frames, ...]
                loss = (e * sub_orig_e.repeat(eot_k, 1)).sum(dim=-1).mean()
                if orig_hash is not None:
                    # Minimising the product of the two soft bit maps maximises the Hamming
                    # distance between them - i.e. this term makes the perceptual hash move.
                    loss = loss + hash_weight * (soft_dhash(adv) * orig_hash.index_select(0, idx)).mean()
                if orig_phash is not None:
                    # Same trick on the DCT hash: the product of two soft bit maps is
                    # smallest when their signs disagree, so the pHash bits are pushed apart.
                    loss = loss + phash_weight * (soft_phash(adv) * orig_phash.index_select(0, idx)).mean()
                loss.backward()
            with torch.no_grad():
                g = sub_delta.grad
                # No `g.abs().max().item()` here on purpose: that call forces a full
                # GPU->CPU sync every step (0.108 s per call, measured with cProfile) and the
                # check is not needed - a zero gradient simply leaves the candidate as-is.
                if g is None:
                    break
                cand = (sub_delta - alpha * g.sign()).clamp(-eps, eps)
                used += 1
                # View 0 of `e` IS this frame's adversarial embedding, so the per-step
                # similarity comes for free. The old code spent a second forward pass per
                # step on it, which was about a seventh of the whole attack.
                sub_sims = (e.detach().view(eot_k, -1, e.shape[-1])[0] * sub_orig_e).sum(dim=-1)
                delta = delta.index_copy(0, idx, cand)
                sims = sims.index_copy(0, idx, sub_sims)
                if not demo:
                    reached = sub_sims <= target
                    if bool(reached.any()):
                        active = active.clone()
                        active[idx] = ~reached
        with torch.no_grad():
            if frame_step > 1:
                # Every frame takes its leader's perturbation, so the skipped frames cost no
                # forward/backward pass at all. Their similarity is measured here (one clean
                # view each) so the reported CLIP figure stays comparable.
                delta = delta.index_select(0, leader_local)
            # One recompute per group instead of one per step: the number that is
            # reported (and that the early stop compared against) then matches the
            # delta actually written out.
            with amp_ctx():
                sims = (clip_emb((small + project_delta(delta, pool_size)).clamp(0, 1)) * orig_e).sum(dim=-1)
            if (not demo) and eot_k <= 1 and float(sims.min().item()) < target - 0.01 and float(sims.max().item()) < 0.999:
                scale = ((1.0 - target) / (1.0 - sims).clamp(min=1e-4)).clamp(0.04, 1.0).view(n, 1, 1, 1)
                delta = delta * scale
                with amp_ctx():
                    sims = (clip_emb((small + project_delta(delta, pool_size)).clamp(0, 1)) * orig_e).sum(dim=-1)
            # Dead-zone fill stays in the 224px buffer and is pooled with the attack.
            # Do not add a second carrier at full-frame size: that grain dies in the
            # next encode and was the visible plaid at high eps.
            floor = min(1.2 / 255.0, max(0.6 / 255.0, 0.25 * eps))
            cover = (1.0 - delta.abs() / (eps + 1e-6)).clamp(0.0, 1.0)
            delta = (delta + midband_carrier(224, 224, floor, phase + 1.7) * cover).clamp(-eps, eps)
            # Same projection the loss attacked. No full-frame carrier on top:
            # that grain is what the next encode deletes, and it inflated the file.
            resid = F.interpolate(project_delta(delta, pool_size), size=(h, w), mode="bilinear", align_corners=False)
            if vis_gain > 1.01:
                resid = resid * vis_gain
            out = (t + resid).clamp(0, 1)
            arr = rgb_to_yuv(out).cpu().numpy()
        if adaptive_skip > 0.0:
            # The last frame of the group becomes the reference for the next one.
            skip_carry["small"] = small[-1:].detach()
            skip_carry["delta"] = delta[-1:].detach()
        return arr, sims, used

    dec_cmd = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error",
        "-threads", "0",
        "-i", args.input,
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-an", "pipe:1",
    ]
    enc_cmd = [
        args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        # Raw yuv420p carries no colour tags, so state them for the input and write the same
        # ones out: without this the render came back as color_range/colorspace "unknown" and
        # anything that converts it later (grayscale grabs, PNG export, another encode) could
        # pick a different range/matrix than the source.
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", f"{w}x{h}", "-r", str(fps),
        "-i", "pipe:0",
        "-i", args.input,
        "-map", "0:v:0",
    ]
    if has_audio:
        enc_cmd += ["-map", "1:a:0?", "-c:a", "copy"]
    else:
        enc_cmd += ["-an"]
    enc_cmd += [
        *enc_video_args,
        "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-movflags", "+faststart", args.output,
    ]

    log(f"PGD+EOT eps={args.eps}/255 steps={steps} alpha={args.alpha}/255 · target {target:.3f} · vis x{vis_gain:.0f}")
    # Print the codec from the args as well as the label: a label alone cannot show whether
    # the encoder was really used (a silent fallback to x264 hid this once).
    enc_codec = enc_video_args[1] if len(enc_video_args) > 1 and enc_video_args[0] == "-c:v" else "?"
    log(f"encode {args.enc_label} [codec {enc_codec}]")
    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert dec.stdout and enc.stdin

    # Frames are attacked in small groups so the GPU is not idle between calls. Measured on
    # 2026-09-28 (RTX 3050, 1080x1920, light level): one frame at a time ran at ~6.3 fps.
    # A group that does not fit in VRAM halves itself and those frames are attacked again
    # in smaller slices, so the result is never affected by the batch size - only the speed is.
    # Decode fills `frame_q` while the GPU works, and the previous group's bytes go to the
    # encoder on `writer` during the next attack. eps, steps, phase and the loss are the
    # same calls as the one-thread loop.
    batch_size = max(1, min(8, int(args.batch)))
    if batch_size > 1:
        log(f"batch {batch_size} frames per pass")
    log("decode and encode overlap the attack")
    frame_q: Queue = Queue(maxsize=max(16, batch_size * 2))
    reader_error: list[BaseException] = []

    def reader() -> None:
        try:
            while True:
                raw = read_exact(dec.stdout, frame_bytes)
                if raw is None or len(raw) < frame_bytes:
                    frame_q.put(None)
                    return
                frame_q.put(np.frombuffer(raw, dtype=np.uint8).copy())
        except Exception as exc:  # noqa: BLE001 - surfaced on the main thread
            reader_error.append(exc)
            frame_q.put(None)

    write_q: Queue = Queue(maxsize=1)
    write_error: list[BaseException] = []

    def writer() -> None:
        try:
            while True:
                blob = write_q.get()
                if blob is None:
                    return
                write_exact(enc.stdin, blob)
        except Exception as exc:  # noqa: BLE001 - surfaced on the main thread
            write_error.append(exc)

    reader_t = threading.Thread(target=reader, name="pgd-decode", daemon=True)
    writer_t = threading.Thread(target=writer, name="pgd-encode", daemon=True)
    reader_t.start()
    writer_t.start()

    def pull(n: int) -> list[np.ndarray]:
        group: list[np.ndarray] = []
        while len(group) < n:
            item = frame_q.get()
            if item is None:
                frame_q.put(None)
                break
            group.append(item)
        if reader_error:
            raise reader_error[0]
        return group

    i = 0
    sim_sum = 0.0
    sim_n = 0
    skip_n = 0
    failed = False

    def note(sim_list: list[float]) -> None:
        if i == len(sim_list) or i % 15 == 0:
            pct = min(99, int(100 * i / max(n_est, 1)))
            avg = sim_sum / max(sim_n, 1)
            skip = f" · skip {skip_n}" if skip_n else ""
            log(f"{pct}% · frame {i}/{n_est} · CLIP sim {sim_list[-1]:.4f} avg {avg:.4f} (target {target:.3f} · EOT {eot_k}){skip}")

    try:
        while True:
            if write_error:
                raise write_error[0]
            group = pull(batch_size)
            if not group:
                break
            offset = 0
            while offset < len(group):
                take = min(batch_size, len(group) - offset)
                sl = group[offset:offset + take]
                try:
                    out, sims, used = attack_batch(np.stack(sl, axis=0), i)
                except RuntimeError as exc:  # almost always CUDA OOM: shrink and retry this slice
                    if take > 1 and "out of memory" in str(exc).lower():
                        batch_size = max(1, take // 2)
                        log(f"VRAM ran out — batch size {batch_size} frame(s) per pass")
                        torch.cuda.empty_cache()
                        continue
                    raise
                if write_error:
                    raise write_error[0]
                write_q.put(np.ascontiguousarray(out).tobytes())
                if used == 0:
                    skip_n += take
                # One sync for the whole slice instead of one per frame.
                sim_list = [float(v) for v in sims.tolist()]
                sim_sum += float(sum(sim_list))
                sim_n += len(sim_list)
                i += take
                offset += take
                note(sim_list)
    except Exception as e:
        log(f"ERROR: {e}")
        failed = True
        try:
            dec.kill()
        except Exception:
            pass
        try:
            enc.kill()
        except Exception:
            pass
    finally:
        try:
            write_q.put(None, timeout=5 if failed else None)
            writer_t.join(timeout=5 if failed else 180)
        except Exception:
            pass
        try:
            enc.stdin.close()
        except Exception:
            pass
    if failed:
        return 1

    dec.stdout.close()
    dec.wait(timeout=30)
    enc_err = ""
    try:
        _, enc_err_b = enc.communicate(timeout=180)
        enc_err = (enc_err_b or b"").decode("utf-8", "replace")
    except Exception:
        enc.kill()
        log("ERROR: encoder hung")
        return 1
    if enc.returncode not in (0, None):
        log(f"ERROR: encoder {enc_err[-400:]}")
        return 1

    if not os.path.isfile(args.output) or os.path.getsize(args.output) < 1000:
        log("ERROR: empty output")
        return 1
    mean_sim = sim_sum / max(sim_n, 1)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"meanClipSim": round(mean_sim, 4), "frames": i, "skipped": skip_n, "target": target, "eot": eot_k, "wave": "pool4"}, f)
    log(f"done · {i} frames · skip {skip_n} · mean CLIP {mean_sim:.4f} · EOT {eot_k} (target {target:.3f}) · wave pool4")
    if adaptive_skip > 0.0:
        pct = (100.0 * skipped_frames / i) if i else 0.0
        log(f"adaptive skip: {skipped_frames}/{i} frames reused ({pct:.0f}%), threshold {adaptive_skip}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"ERROR: {e}")
        sys.exit(1)
