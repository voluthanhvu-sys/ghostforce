"""Local pyannote diarization helper. JSON only on stdout."""

import json
import os
import sys
import wave

import numpy as np
import torch
from pyannote.audio import Pipeline


MODEL_ID = "pyannote/speaker-diarization-community-1"


def read_pcm_wav(filename):
    with wave.open(filename, "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())
    if channels != 1 or sample_width != 2 or sample_rate != 16000:
        raise RuntimeError("expected mono 16kHz PCM s16le WAV")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0), sample_rate


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("usage: local_listen_diarize.py <wav>")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable")
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_HUB_TOKEN")
    pipeline = Pipeline.from_pretrained(MODEL_ID, token=token)
    pipeline.to(torch.device("cuda"))
    waveform, sample_rate = read_pcm_wav(sys.argv[1])
    output = pipeline({"waveform": waveform, "sample_rate": sample_rate})
    annotation = getattr(output, "speaker_diarization", output)
    turns = [
        {"start": round(segment.start, 3), "end": round(segment.end, 3), "speakerId": str(speaker)}
        for segment, _, speaker in annotation.itertracks(yield_label=True)
        if segment.end > segment.start
    ]
    print(json.dumps(turns, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Local Listen error: {exc}", file=sys.stderr)
        raise
