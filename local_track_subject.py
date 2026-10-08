#!/usr/bin/env python3
"""Local subject tracker: dense per-frame positions for ONE subject.

Why: the AI plan gives sparse anchors (measured: 1-9 aim points for a 134 s part,
even 3.8 only reached 59 -> one every 2.3 s). The crop needs a position at every
moment, so the dense part is done locally with a face detector instead of being
asked from the model. Free, deterministic, no API quota.

Design rule: this script never decides WHO matters or WHAT should be framed - the
AI plan does that. It only answers "where is that subject now", seeded by the
plan's anchor and refusing to jump to another face beyond `--max-jump`.

Usage:
  python local_track_subject.py --video in.mp4 --start 18 --end 152 \
      --fps 5 --anchor 40:0.50:0.55 --out track.json

Output: JSON on stdout (and --out when given):
  { video, start, end, srcFps, samples, detected, detectRate, longestGapSec,
    sampleMs, msPerSample, track: [{ t, cx, cy, w, h, score }] }
All coordinates are normalised to the frame (0..1); t is seconds from --start.
"""

import argparse
import json
import os
import subprocess
import sys
import time

import cv2
import numpy as np

DEFAULT_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "models", "face_detection_yunet_2023mar.onnx")


def parse_anchor(text):
    parts = str(text).split(":")
    if len(parts) != 3:
        raise argparse.ArgumentTypeError("anchor must be t:cx:cy")
    return tuple(float(p) for p in parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=0.0, help="0 = end of file")
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--width", type=int, default=640, help="detector input width")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--score", type=float, default=0.6)
    ap.add_argument("--person", action="store_true",
                    help="also run a YOLO person detector (covers frames with no face)")
    ap.add_argument("--yolo", default="yolov8n.pt", help="ultralytics weights for --person")
    ap.add_argument("--person-conf", type=float, default=0.35)
    ap.add_argument("--anchor", action="append", type=parse_anchor, default=[],
                    help="t:cx:cy (repeatable) - the subject should be near these")
    ap.add_argument("--max-jump", type=float, default=0.25,
                    help="max cx/cy movement between samples")
    ap.add_argument("--no-lock", action="store_true",
                    help="disable identity lock (continuity beats nearest-anchor)")
    ap.add_argument("--out")
    ap.add_argument("--pipe", action="store_true",
                    help="decode+subsample with ffmpeg (multithreaded) instead of cv2.VideoCapture")
    ap.add_argument("--hwaccel", action="store_true",
                    help="with --pipe: ask ffmpeg for CUDA decode")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        sys.exit(f"model not found: {args.model}")
    if not os.path.exists(args.video):
        sys.exit(f"video not found: {args.video}")

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit("cannot open video")
    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    dur = total / src_fps if src_fps else 0.0
    end = args.end if args.end > 0 else dur
    end = min(end, dur) if dur else args.end
    if end <= args.start:
        sys.exit("empty range")

    step = max(1, int(round(src_fps / max(0.1, args.fps))))
    first = int(round(args.start * src_fps))
    last = int(round(end * src_fps))
    if first > 0:
        cap.set(cv2.CAP_PROP_POS_FRAMES, first)

    det_w = min(args.width, src_w or args.width)
    det_h = max(2, int(round((src_h or det_w) * det_w / (src_w or det_w))))
    det_h -= det_h % 2
    detector = cv2.FaceDetectorYN.create(args.model, "", (det_w, det_h), args.score, 0.3, 5000)
    person_model = None
    if args.person:
        from ultralytics import YOLO
        person_model = YOLO(args.yolo)

    anchors = sorted(args.anchor)
    track = []
    gaps = []
    gap_start = None
    idx = first
    samples = 0
    detected = 0
    last_cx = None
    last_cy = None
    last_box = None
    switch_streak = 0
    hold_from = None
    t_all0 = time.time()
    detect_ms = 0.0
    detect_count = 0
    person_ms = 0.0
    face_hits = 0
    person_hits = 0

    def ingest(t, small):
        """Detect one frame and append the chosen subject to `track`."""
        nonlocal samples, detected, last_cx, last_cy, gap_start, detect_ms, detect_count
        nonlocal person_ms, face_hits, person_hits, last_box, switch_streak, hold_from
        t0 = time.time()
        _, faces = detector.detect(small)
        detect_ms += (time.time() - t0) * 1000.0
        detect_count += 1
        samples += 1
        if faces is not None and len(faces):
            face_hits += 1
        persons = []
        if person_model is not None:
            p0 = time.time()
            res = person_model.predict(small, imgsz=640, classes=[0], conf=args.person_conf, verbose=False)
            person_ms += (time.time() - p0) * 1000.0
            for box in (res[0].boxes if res else []):
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                # A full-body box is centred on the hips, which is NOT where a 9:16
                # head crop should point. Aim near the top of the box instead.
                persons.append(((x1 + x2) / 2 / det_w, (y1 + 0.15 * (y2 - y1)) / det_h,
                                (x2 - x1) / det_w, (y2 - y1) / det_h, float(box.conf[0])))
            if persons:
                person_hits += 1
        best = None
        candidates = []
        if faces is not None and len(faces):
            for f in faces:
                fx, fy, fw, fh = float(f[0]), float(f[1]), float(f[2]), float(f[3])
                candidates.append((((fx + fw / 2) / det_w), ((fy + fh / 2) / det_h),
                                   fw / det_w, fh / det_h, float(f[-1]), "face"))
        elif persons:
            # Faces win outright when the frame has one: mixing them per-frame made
            # the aim flip between a head point and a hip point (measured: cx jumped
            # 0.63 -> 0.53 on a full-body box). The body detector only fills the
            # frames where no face exists at all.
            for cx, cy, w, h, score in persons:
                candidates.append((cx, cy, w, h, score, "person"))
        def iou(a, b):
            ax, ay, aw, ah = a
            bx, by, bw, bh = b
            x1 = max(ax - aw / 2, bx - bw / 2)
            x2 = min(ax + aw / 2, bx + bw / 2)
            y1 = max(ay - ah / 2, by - bh / 2)
            y2 = min(ay + ah / 2, by + bh / 2)
            inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
            union = aw * ah + bw * bh - inter
            return inter / union if union > 0 else 0.0

        if candidates and not args.no_lock and last_box is not None:
            # Identity lock: with two faces 0.14 apart (measured at 19-21 s of the
            # Law By Mike part) "nearest to the anchor" alternates between them on
            # every sample, which the renderer draws as a hard cut - the flicker
            # the operator reported. Continuity of the box wins when it overlaps.
            cont = max(candidates, key=lambda c: iou((c[0], c[1], c[2], c[3]), last_box))
            if iou((cont[0], cont[1], cont[2], cont[3]), last_box) >= 0.25:
                best = (0.0, cont[0], cont[1], cont[2], cont[3], cont[4], cont[5])
                switch_streak = 0
        if candidates and best is None:
            seed = None
            if anchors:
                seed = min(anchors, key=lambda a: abs(a[0] - t))[1:]
            elif last_cx is not None:
                seed = (last_cx, last_cy)
            for cx, cy, w, h, score, src in candidates:
                # A face beats a body when both are available: the 9:16 crop wants
                # the head, and the body box can drift onto a second person.
                if seed is not None:
                    key = (((cx - seed[0]) ** 2 + (cy - seed[1]) ** 2) ** 0.5, -score)
                else:
                    key = (0.0, -(w * h))
                if best is None or key < best[0]:
                    best = (key, cx, cy, w, h, score, src)
            if best is not None and last_cx is not None:
                jump = ((best[1] - last_cx) ** 2 + (best[2] - last_cy) ** 2) ** 0.5
                if jump > args.max_jump:
                    best = None
                elif jump > 0.08:
                    # A different box won: only accept the identity change when it
                    # keeps winning, otherwise keep following the current subject -
                    # and still EMIT that held position, so the render keeps an aim
                    # point instead of falling back to a stale model anchor.
                    switch_streak += 1
                    if switch_streak < 3:
                        # A hold is only honest for a short occlusion. Measured: holding
                        # for seconds emitted a stale aim point that counted as coverage,
                        # so the RGB repair never fired and the subject left the crop
                        # 16.3 % of the time (worst: no aim point at all in 55-58.5 s,
                        # one point in 112.5-118 s). After HOLD_MAX the tracker gives up
                        # and emits NOTHING, which lets the caller re-sample the frame.
                        if hold_from is None:
                            hold_from = t
                        if t - hold_from <= 0.6:
                            hw = last_box[2] if last_box else 0.1
                            hh = last_box[3] if last_box else 0.1
                            best = (0.0, last_cx, last_cy, hw, hh, 1.0, "held")
                        else:
                            best = None
                else:
                    switch_streak = 0
        if best is None:
            if gap_start is None:
                gap_start = t
        else:
            if gap_start is not None:
                gaps.append(t - gap_start)
                gap_start = None
            detected += 1
            last_cx, last_cy = best[1], best[2]
            last_box = (best[1], best[2], best[3], best[4])
            track.append({"t": round(t, 3), "cx": round(best[1], 4), "cy": round(best[2], 4),
                          "w": round(best[3], 4), "h": round(best[4], 4), "score": round(best[5], 4),
                          "src": best[6]})

    if args.pipe:
        span = end - args.start
        cmd = ["ffmpeg", "-v", "error", "-nostdin"]
        if args.hwaccel:
            cmd += ["-hwaccel", "cuda"]
        cmd += ["-ss", f"{args.start}", "-t", f"{span}", "-i", args.video,
                "-vf", f"fps={args.fps},scale={det_w}:{det_h}", "-f", "rawvideo",
                "-pix_fmt", "bgr24", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=det_w * det_h * 3 * 4)
        frame_bytes = det_w * det_h * 3
        n = 0
        while True:
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, dtype=np.uint8).reshape((det_h, det_w, 3))
            ingest(n / args.fps, frame)
            n += 1
        proc.stdout.close()
        proc.wait()
        cap.release()
        elapsed = time.time() - t_all0
        if gap_start is not None:
            gaps.append(max(0.0, span - gap_start))
        result = {
            "video": os.path.basename(args.video),
            "start": args.start,
            "end": end,
            "srcFps": round(src_fps, 3),
            "srcSize": [src_w, src_h],
            "sampleFps": args.fps,
            "decoder": "ffmpeg-cuda" if args.hwaccel else "ffmpeg",
            "samples": samples,
            "detected": detected,
            "detectRate": round(detected / samples, 4) if samples else 0,
            "detectRateFace": round(face_hits / samples, 4) if samples else 0,
            "detectRatePerson": round(person_hits / samples, 4) if samples else 0,
            "longestGapSec": round(max(gaps), 2) if gaps else 0,
            "elapsedSec": round(elapsed, 2),
            "detectMsPerSample": round(detect_ms / detect_count, 2) if detect_count else None,
            "personMsPerSample": round(person_ms / samples, 2) if samples and args.person else None,
            "msPerSample": round(elapsed * 1000.0 / samples, 2) if samples else None,
            "track": track,
        }
        text = json.dumps(result)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as fh:
                fh.write(text)
        print(text)
        return

    while idx <= last:
        if not cap.grab():
            break
        if (idx - first) % step:
            idx += 1
            continue
        ok, frame = cap.retrieve()
        idx += 1
        if not ok or frame is None:
            continue
        t = (idx - 1) / src_fps - args.start
        small = cv2.resize(frame, (det_w, det_h)) if (det_w, det_h) != (frame.shape[1], frame.shape[0]) else frame
        ingest(t, small)
    if gap_start is not None:
        gaps.append(max(0.0, end - args.start - gap_start))
    cap.release()

    elapsed = time.time() - t_all0
    result = {
        "video": os.path.basename(args.video),
        "start": args.start,
        "end": end,
        "srcFps": round(src_fps, 3),
        "srcSize": [src_w, src_h],
        "sampleFps": round(1.0 * src_fps / step, 3),
        "samples": samples,
        "detected": detected,
        "detectRate": round(detected / samples, 4) if samples else 0,
        "detectRateFace": round(face_hits / samples, 4) if samples else 0,
        "detectRatePerson": round(person_hits / samples, 4) if samples else 0,
        "longestGapSec": round(max(gaps), 2) if gaps else 0,
        "elapsedSec": round(elapsed, 2),
        "detectMsPerSample": round(detect_ms / detect_count, 2) if detect_count else None,
        "personMsPerSample": round(person_ms / samples, 2) if samples and args.person else None,
        "msPerSample": round(elapsed * 1000.0 / samples, 2) if samples else None,
        "track": track,
    }
    text = json.dumps(result)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)


if __name__ == "__main__":
    main()
