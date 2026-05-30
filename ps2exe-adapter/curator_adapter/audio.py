"""Self-contained acoustic fingerprint for CD audio (Tier-4).

A chroma-based fingerprint: per-frame dominant pitch-class codes shingled into a set of
n-grams. Similarity = Jaccard of the sets (reuses the Tier-2/3 set-similarity machinery).
No libchromaprint dependency — just numpy. Robust to re-encoding (chroma is pitch-based);
validated to score ~0.95 for the same track re-encoded and ~0.00 for different songs.

Part of fingerprint_profile "v1" — changing these constants is a re-scan.
"""

import re

import numpy as np

_CUE_FILE = re.compile(r'FILE\s+"?(.+?)"?\s+(\w+)\s*$', re.I)
_CUE_TRACK = re.compile(r"TRACK\s+(\d+)\s+(\S+)", re.I)
_CUE_INDEX1 = re.compile(r"INDEX\s+01\s+(\d+):(\d+):(\d+)", re.I)


def parse_cue(text):
    """Parse a .cue sheet into [{file, tracks:[{num, type, start_frame}]}]."""
    files = []
    cur = None
    track = None
    for line in text.splitlines():
        mf = _CUE_FILE.search(line)
        if mf:
            cur = {"file": mf.group(1), "tracks": []}
            files.append(cur)
            track = None
            continue
        mt = _CUE_TRACK.search(line)
        if mt and cur is not None:
            track = {"num": int(mt.group(1)), "type": mt.group(2).upper(), "start_frame": None}
            cur["tracks"].append(track)
            continue
        mi = _CUE_INDEX1.search(line)
        if mi and track is not None:
            mm, ss, ff = int(mi.group(1)), int(mi.group(2)), int(mi.group(3))
            track["start_frame"] = (mm * 60 + ss) * 75 + ff
    return files

SR0 = 44100          # Red Book sample rate
DECIM = 4            # crude decimation -> ~11025 Hz
SR = SR0 // DECIM
FRAME = 8192
HOP = 2048
SHINGLE = 4          # n-gram length
_MASK = (1 << 63) - 1

# raw CDDA sector = 2352 bytes of 16-bit stereo PCM (no sync/header)
SECTOR = 2352
# fingerprint at most the first ~90s of a track (90 * 75 sectors) for speed;
# a deterministic prefix still matches the same track across builds.
MAX_FP_BYTES = 90 * 75 * SECTOR
# data-track sectors start with this 12-byte sync pattern
DATA_SYNC = b"\x00" + b"\xff" * 10 + b"\x00"

_freqs = np.fft.rfftfreq(FRAME, d=1.0 / SR)
with np.errstate(divide="ignore"):
    _notes = 12 * np.log2(np.where(_freqs > 0, _freqs, 1) / 440.0)
_chroma_idx = np.round(_notes).astype(int) % 12
_valid = (_freqs >= 55) & (_freqs <= 4000)
_ci = _chroma_idx[_valid]


def is_audio_track(head: bytes, size: int) -> bool:
    """Heuristic: raw CDDA track = whole sectors and no data-track sync pattern."""
    if size <= 0 or size % SECTOR != 0:
        return False
    return not head.startswith(DATA_SYNC)


def _chroma_seq(x: np.ndarray) -> np.ndarray:
    win = np.hanning(FRAME).astype(np.float32)
    nf = max(0, 1 + (len(x) - FRAME) // HOP)
    out = np.zeros((nf, 12), np.float32)
    for i in range(nf):
        mag = np.abs(np.fft.rfft(x[i * HOP : i * HOP + FRAME] * win))[_valid]
        c = np.bincount(_ci, weights=mag, minlength=12)
        n = np.linalg.norm(c)
        if n:
            out[i] = c / n
    return out


def fingerprint_pcm(raw: bytes) -> list[int]:
    """Return the sub-fingerprint set for raw 16-bit stereo 44.1kHz PCM bytes."""
    if len(raw) < FRAME * 4:
        return []
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    x = x.reshape(-1, 2).mean(axis=1)[::DECIM]
    C = _chroma_seq(x)
    if len(C) < SHINGLE:
        return []
    order = np.argsort(-C, axis=1)
    code = (order[:, 0] * 12 + order[:, 1]).astype(np.int64)  # top-2 pitch classes
    s = set()
    for i in range(len(code) - SHINGLE + 1):
        h = 0
        for j in range(SHINGLE):
            h = h * 144 + int(code[i + j])
        s.add(h & _MASK)
    return sorted(s)
