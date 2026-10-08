"""Word clock for Unique captions.

Prints one JSON object on stdout:
{"language":"pt","languageProbability":0.97,"words":[{"word":"oi","start":0.0,"end":0.54}]}

faster-whisper small, CPU int8. CUDA on this machine fails without
cublas64_12.dll, so this script does not try the GPU. Language detection is
part of the same pass. Google spelling is applied later, in Node.
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: caption_words.py <audio.wav>\n")
        return 2
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "faster-whisper is not installed in this Python. "
            "Run: .venv-diar\\Scripts\\python.exe -m pip install faster-whisper\n"
        )
        return 2
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, info = model.transcribe(sys.argv[1], word_timestamps=True, vad_filter=True)
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = (w.word or "").strip()
            if not text or w.start is None or w.end is None:
                continue
            words.append({"word": text, "start": float(w.start), "end": float(w.end)})
    json.dump(
        {
            "language": info.language or "",
            "languageProbability": float(info.language_probability or 0),
            "words": words,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
