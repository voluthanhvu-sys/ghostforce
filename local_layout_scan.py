#!/usr/bin/env python3
"""One local pass over a focus part: faces, people, portrait panels, and a side pair.

The pair is two objects on a dark canvas, or, when that finds nothing and
no real face is present, two ink drawings on a light page or two round
objects across the middle of the frame. One real face beside a wide dark
board on a bright page is also a pair: the page is too bright for the
dark-canvas rule and the board is too wide for a phone panel.

YOLOv8n misses the phone-ad graphics in Law By Mike (measured at 50 s, 52 s and
131 s, confidence floor 0.15, zero cell-phone boxes) while a tall pair of
vertical edges finds the same graphic at cx 0.16. This script only reports
boxes, plus how much the picture changed since the previous sample.
server/focus-layout.js decides focus versus split.

  .venv-diar/Scripts/python.exe local_layout_scan.py <video> <start> <dur> [fps]

Prints a JSON list, one object per sample, including empty samples so the
caller can tell "one subject" from "the scan was blind". `motion` is the mean
absolute change against the previous sample on a 160x90 grey frame. The first
sample is 0. A cut into the title card at 99.5 s measured about 63, and the
card itself then stayed under 21.
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
YUNET = os.path.join(ROOT, "models", "face_detection_yunet_2023mar.onnx")
YOLO_WEIGHTS = os.path.join(ROOT, "yolov8n.pt")


def ffmpeg_bin():
    for key in ("FFMPEG", "GHOSTFORGE_FFMPEG"):
        value = os.environ.get(key)
        if value and os.path.exists(value):
            return value
    return "ffmpeg"


def find_side_pair(bgr):
    """Two separate objects on a dark canvas, or nothing.

    A filled 9:16 crop is the middle third of a 16:9 frame, so two monitors
    cannot both stay in one crop. Measured on the 134 s part: the scoreboard
    near 97 s has a near-black border and two boxes around cx 0.25 and 0.74.
    A video wall is one wide box. A bright room (host, laptop, phone ad)
    is skipped on the border alone.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    border = np.concatenate([
        gray[: height // 10, :].ravel(),
        gray[-height // 8:, :].ravel(),
        gray[:, : width // 16].ravel(),
        gray[:, -width // 16:].ravel(),
    ])
    border_med = float(np.median(border))
    if border_med > 42:
        return []
    # Local contrast, not flat colour. A blue curtain is saturated and used to
    # look like a second object beside a phone (2 s). The scoreboard digits
    # and bezels stay.
    blur = cv2.GaussianBlur(gray, (0, 0), 3)
    contrast = cv2.absdiff(gray, blur)
    detail = (contrast > 18) | (gray > 160)
    mask = (detail & (gray > border_med + 30)).astype(np.uint8) * 255
    close = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, width // 16), max(9, height // 8)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7)))
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    boxes = []
    for i in range(1, count):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        if area < 0.015 * width * height:
            continue
        box_w = bw / width
        if box_w < 0.18 or box_w > 0.60 or bh / height < 0.35:
            continue
        boxes.append({
            "cx": round((x + bw / 2) / width, 3),
            "cy": round((y + bh / 2) / height, 3),
            "w": round(box_w, 3),
        })
    if len(boxes) != 2:
        return []
    boxes.sort(key=lambda box: box["cx"])
    left, right = boxes
    if right["cx"] - left["cx"] < 0.35:
        return []
    if max(left["w"], right["w"]) / max(0.001, min(left["w"], right["w"])) > 2.2:
        return []
    return boxes


def find_ink_pair(bgr):
    """Two dark drawings on a light page, or nothing.

    Measured on a capsaicin card: the molecule and the figure are two ink
    blobs (gray under 150) about 0.39 apart, widths about 0.27 and 0.29,
    and the pair holds for about 3 s including the frame where the figure
    turns red. A host, a scoreboard, a title card and a wood table do not
    return two blobs. Called only when the dark-canvas pair found nothing
    and no real face is in the frame.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    ink = (gray < 150).astype(np.uint8) * 255
    ink = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (21, 11)))
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink)
    boxes = []
    for i in range(1, count):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        share = area / float(width * height)
        if share < 0.006 or share > 0.35:
            continue
        box_w = bw / width
        if box_w < 0.12 or box_w > 0.42 or bh / height < 0.28:
            continue
        if x / width < 0.02 or (x + bw) / width > 0.98:
            continue
        boxes.append({
            "cx": round((x + bw / 2) / width, 3),
            "cy": round((y + bh / 2) / height, 3),
            "w": round(box_w, 3),
        })
    if len(boxes) != 2:
        return []
    boxes.sort(key=lambda box: box["cx"])
    left, right = boxes
    if right["cx"] - left["cx"] < 0.35:
        return []
    if max(left["w"], right["w"]) / max(0.001, min(left["w"], right["w"])) > 2.2:
        return []
    return boxes


def find_round_pair(bgr):
    """Two plates or bowls across the middle of the frame, or nothing.

    Measured on an overhead table: both bowls sit near cy 0.49, radius
    about 0.12 of the width, centres about 0.50 apart, for more than a
    second. A fist above them is higher than cy 0.40 and is dropped.
    Title cards, a seated host, the fish, the laptop and the scoreboard
    do not return this pair. Same preconditions as find_ink_pair.
    """
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 5)
    height, width = gray.shape
    found = cv2.HoughCircles(
        gray, cv2.HOUGH_GRADIENT, dp=1.2, minDist=max(8, int(width * 0.28)),
        param1=80, param2=28, minRadius=max(6, int(width * 0.09)), maxRadius=int(width * 0.16),
    )
    boxes = []
    if found is not None:
        for circle in found[0]:
            cx = float(circle[0]) / width
            cy = float(circle[1]) / height
            radius = float(circle[2]) / width
            if cy < 0.40 or cy > 0.62:
                continue
            if cx - radius < 0.02 or cx + radius > 0.98:
                continue
            boxes.append({
                "cx": round(cx, 3),
                "cy": round(cy, 3),
                "w": round(radius * 2, 3),
                "r": radius,
            })
    if len(boxes) != 2:
        return []
    boxes.sort(key=lambda box: box["cx"])
    left, right = boxes
    if right["cx"] - left["cx"] < 0.35:
        return []
    if max(left["r"], right["r"]) / max(0.001, min(left["r"], right["r"])) > 1.35:
        return []
    return [{"cx": box["cx"], "cy": box["cy"], "w": box["w"]} for box in boxes]


def find_face_board(bgr, faces):
    """One real face beside a wide dark board on a bright page, or nothing.

    Measured beside a "U.S. Law" card: the page border median is about 190,
    so the dark-canvas pair returns nothing, and the card is about 0.39 to
    0.47 wide, so the portrait phone panel misses it. The suit and the card
    are two separate dark blobs. The blob that contains the face is the
    person. The other blob, at least 0.35 away, is the board. A second real
    face, a lone host, and a narrow sliver cut by the frame stay one crop.
    """
    real = [box for box in faces if box.get("w", 0) >= 0.06]
    if len(real) != 1:
        return []
    face = real[0]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    dark = (gray < 80).astype(np.uint8) * 255
    dark = cv2.morphologyEx(
        dark, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)),
    )
    count, _, stats, _ = cv2.connectedComponentsWithStats(dark)
    boards = []
    fx = float(face["cx"]) * width
    fy = float(face["cy"]) * height
    for i in range(1, count):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        share = area / float(width * height)
        box_w = bw / width
        box_h = bh / height
        cx = (x + bw / 2) / width
        cy = (y + bh / 2) / height
        contains = x <= fx <= x + bw and y <= fy <= y + bh
        # The suit is dark too. It contains the face, so it is not the board.
        # Its width is the whole jacket, which is not the size of the face
        # half, and must not veto a smaller card through the 2.2 ratio.
        if contains:
            continue
        if share < 0.04 or box_w < 0.18 or box_w > 0.55 or box_h < 0.28:
            continue
        if abs(cx - float(face["cx"])) < 0.35:
            continue
        if box_w < 0.32 and (x <= 2 or x + bw >= width - 2):
            continue
        boards.append({
            "cx": round(cx, 3),
            "cy": round(cy, 3),
            "w": round(box_w, 3),
        })
    if len(boards) != 1:
        return []
    board = boards[0]
    # The half is the face, not the jacket. Report a width near the board so
    # the shared 2.2 size ratio still applies to the two halves.
    person_w = max(0.22, min(0.50, board["w"]))
    return [
        {"cx": round(float(face["cx"]), 3), "cy": round(float(face["cy"]), 3), "w": round(person_w, 3)},
        board,
    ]


def find_panels(gray):
    """Tall portrait card: two strong vertical edges, 12-42 % of the frame apart.

    Thresholds were measured on the 134 s part. Phone ads score 111-202.
    A seated host, a video wall and a laptop score under 80 and are ignored.
    A phone whose far edge is covered by the product beside it (the red chair
    at 29 s) keeps one edge in that same 140+ band. The covered edge scores
    about 60 and is not a peak, so it never reaches the 100 rule. That case
    is accepted on its own, and only when the strict pair found nothing, so
    a clean ad keeps the box it already had.
    """
    height, width = gray.shape
    edges = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    column = edges.mean(axis=0)
    tall = (edges > 40).mean(axis=0)
    smooth = np.convolve(column, np.ones(9) / 9, mode="same")
    peaks = []
    for i in range(8, width - 8):
        if smooth[i] < 80 or tall[i] < 0.35:
            continue
        if smooth[i] < smooth[i - 1] or smooth[i] < smooth[i + 1]:
            continue
        if not peaks or i - peaks[-1][0] > 12:
            peaks.append((i, float(smooth[i])))
        elif smooth[i] > peaks[-1][1]:
            peaks[-1] = (i, float(smooth[i]))
    best = None
    for a in range(len(peaks)):
        for b in range(a + 1, len(peaks)):
            x1, s1 = peaks[a]
            x2, s2 = peaks[b]
            box_w = (x2 - x1) / width
            score = min(s1, s2)
            if box_w < 0.12 or box_w > 0.42 or score < 100:
                continue
            if best is None or score > best["score"]:
                best = {
                    "cx": round(((x1 + x2) / 2) / width, 3),
                    "cy": 0.5,
                    "w": round(box_w, 3),
                    "score": round(score, 1),
                }
    # Covered far edge. The open edge has to be as strong as a clean ad
    # (measured 147 at 29 s, 146 at the 6 s ad). Hosts, the wall, the laptop
    # and the desk stay under 110, so they never enter this path.
    if best is None:
        for x1, s1 in peaks:
            if s1 < 130 or tall[x1] < 0.35:
                continue
            for sign in (1, -1):
                lo = int(round(x1 + sign * 0.18 * width))
                hi = int(round(x1 + sign * 0.32 * width))
                if lo > hi:
                    lo, hi = hi, lo
                lo = max(0, lo)
                hi = min(width - 1, hi)
                if hi - lo < 4:
                    continue
                segment = smooth[lo:hi + 1]
                j = int(np.argmax(segment))
                s2 = float(segment[j])
                if s2 < 50:
                    continue
                x2 = lo + j
                box_w = abs(x2 - x1) / width
                if box_w < 0.18 or box_w > 0.32:
                    continue
                score = min(s1, s2)
                if best is None or score > best["score"]:
                    best = {
                        "cx": round(((x1 + x2) / 2) / width, 3),
                        "cy": 0.5,
                        "w": round(box_w, 3),
                        "score": round(score, 1),
                    }
    return [best] if best else []


def open_pipe(video, start, dur, fps, width, height, hwaccel):
    cmd = [ffmpeg_bin(), "-v", "error", "-nostdin"]
    if hwaccel:
        cmd += ["-hwaccel", "cuda"]
    cmd += ["-ss", str(start), "-t", str(dur), "-i", video,
            "-vf", f"fps={fps},scale={width}:{height}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def read_frames(video, start, dur, fps, width, height):
    probe = cv2.VideoCapture(video)
    src_h = int(probe.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    src_w = int(probe.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    probe.release()
    height = int(round(src_h * width / max(1, src_w)))
    height -= height % 2
    size = width * height * 3
    for hwaccel in (True, False):
        proc = open_pipe(video, start, dur, fps, width, height, hwaccel)
        frames = []
        while True:
            buf = proc.stdout.read(size)
            if not buf or len(buf) < size:
                break
            frames.append(np.frombuffer(buf, dtype=np.uint8).reshape((height, width, 3)))
        proc.stdout.close()
        proc.wait()
        if frames:
            return frames, width, height
    return [], width, height


def main():
    if len(sys.argv) < 4:
        sys.exit("usage: local_layout_scan.py <video> <start> <dur> [fps]")
    video, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    fps = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
    if not os.path.exists(video):
        sys.exit(f"video not found: {video}")
    if not os.path.exists(YUNET):
        sys.exit(f"model not found: {YUNET}")
    frames, width, height = read_frames(video, start, dur, fps, 640, 360)
    face = cv2.FaceDetectorYN.create(YUNET, "", (width, height), 0.6, 0.3, 5000)
    yolo = None
    if os.path.exists(YOLO_WEIGHTS):
        try:
            from ultralytics import YOLO
            yolo = YOLO(YOLO_WEIGHTS)
        except Exception as exc:
            print(f"yolo skipped: {exc}", file=sys.stderr)
            yolo = None
    out = []
    prev_small = None
    for n, frame in enumerate(frames):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Same size as the measurement that set the still-card thresholds.
        small = cv2.resize(gray, (160, 90), interpolation=cv2.INTER_AREA)
        if prev_small is None:
            motion = 0.0
        else:
            motion = float(np.mean(cv2.absdiff(small, prev_small)))
        prev_small = small
        panels = find_panels(gray)
        _, det = face.detect(frame)
        faces = []
        for row in (det if det is not None else []):
            x, y, w, h = (float(v) for v in row[:4])
            x0, y0 = max(0, int(x)), max(0, int(y))
            x1, y1 = min(width, int(x + w)), min(height, int(y + h))
            patch = gray[y0:y1, x0:x1]
            # Variance of the Laplacian: a soft background face (a title card,
            # a whip pan) scores near 0, while the in-focus host stays high.
            sharp = float(cv2.Laplacian(patch, cv2.CV_64F).var()) if patch.size else 0.0
            faces.append({
                "cx": round((x + w / 2) / width, 3),
                "cy": round((y + h / 2) / height, 3),
                "w": round(w / width, 3),
                "sharp": round(sharp, 1),
            })
        people = []
        if yolo is not None:
            res = yolo.predict(frame, imgsz=640, classes=[0], conf=0.30, verbose=False)
            for box in (res[0].boxes if res else []):
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0].tolist())
                people.append({
                    "cx": round((x1 + x2) / 2 / width, 3),
                    "cy": round((y1 + 0.15 * (y2 - y1)) / height, 3),
                    "w": round((x2 - x1) / width, 3),
                })
        # A real face is at least 0.06 of the frame wide on this scan. The
        # false face on a drawn figure measured 0.03 and must not block the
        # ink pair. Dark-canvas pairs stay first, so a scoreboard is unchanged.
        pair = find_side_pair(frame)
        pair_kind = "side" if pair else ""
        real_face = any(box["w"] >= 0.06 for box in faces)
        if not pair and not real_face:
            pair = find_ink_pair(frame)
            if pair:
                pair_kind = "ink"
        if not pair and not real_face:
            pair = find_round_pair(frame)
            if pair:
                pair_kind = "round"
        # A bright page with one face and a wide dark board. The dark-canvas
        # pair already ran and found nothing. A second real face stays out.
        if not pair and sum(1 for box in faces if box["w"] >= 0.06) == 1:
            pair = find_face_board(frame, faces)
            if pair:
                pair_kind = "side"
        out.append({
            "t": round(n / fps, 2),
            "faces": sorted(faces, key=lambda p: p["cx"]),
            "people": sorted(people, key=lambda p: p["cx"]),
            "panels": panels,
            "pair": pair,
            "pairKind": pair_kind,
            "motion": round(motion, 1),
        })
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
