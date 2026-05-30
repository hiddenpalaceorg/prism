"""Self-contained acoustic fingerprint for CD audio (Tier-4).

A Shazam-style **constellation** fingerprint: pick spectral peaks in the
time–frequency plane, then hash *pairs* of nearby peaks keyed by their frequencies
and the time delta between them. Because the hash encodes Δt (not absolute time), a
constant time offset between two rips — different pregap, leading silence, a shifted
`.cue` INDEX — cancels out, so the fingerprints still match. The output is a *set* of
integer hashes, so similarity is still Jaccard (reuses the Tier-2/3 set machinery).

No libchromaprint dependency — just numpy. Hash values stay < 2**26 (JSON-number safe).

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
FRAME = 1024         # STFT window (~93 ms at 11025 Hz)
HOP = 512            # ~46 ms hop
NBINS = FRAME // 2 + 1

# Peak picking / pairing.
N_BANDS = 6          # log-spaced bands; one candidate peak per band per frame
FAN = 3              # target peaks paired with each anchor
FQ_SHIFT = 2         # coarsen peak freq bins (>>2): absorbs sub-frame STFT jitter,
                     # big robustness win to offset/re-encode with no loss of discrimination
DT_MIN = 1           # frames (skip same-frame pairs)
DT_MAX = 63          # frames (~2.9 s target zone); fits Δt in 6 bits
MAX_PEAKS = 6000     # cap landmarks (bounds set size on dense/noisy audio)
MAX_HASHES = 12000   # hard cap on the emitted set
_MASK = (1 << 63) - 1

# raw CDDA sector = 2352 bytes of 16-bit stereo PCM (no sync/header)
SECTOR = 2352
# fingerprint at most the first ~90s of a track (90 * 75 sectors) for speed;
# a deterministic prefix still matches the same track across builds.
MAX_FP_BYTES = 90 * 75 * SECTOR
# data-track sectors start with this 12-byte sync pattern
DATA_SYNC = b"\x00" + b"\xff" * 10 + b"\x00"

# Log-spaced band edges (bin indices) over the musically useful 55–4000 Hz range.
_LO_BIN = max(1, int(55 * FRAME / SR))
_HI_BIN = min(NBINS - 1, int(4000 * FRAME / SR))
_BAND_EDGES = np.unique(
    np.geomspace(_LO_BIN, _HI_BIN, N_BANDS + 1).astype(int)
)


def is_audio_track(head: bytes, size: int) -> bool:
    """Heuristic: raw CDDA track = whole sectors and no data-track sync pattern."""
    if size <= 0 or size % SECTOR != 0:
        return False
    return not head.startswith(DATA_SYNC)


def _spectrogram(x: np.ndarray) -> np.ndarray:
    """Magnitude STFT, shape (frames, NBINS)."""
    nf = 1 + (len(x) - FRAME) // HOP
    if nf <= 0:
        return np.empty((0, NBINS), np.float32)
    win = np.hanning(FRAME).astype(np.float32)
    out = np.empty((nf, NBINS), np.float32)
    for i in range(nf):
        out[i] = np.abs(np.fft.rfft(x[i * HOP : i * HOP + FRAME] * win))
    return out


def _peaks(S: np.ndarray):
    """Constellation points as a time-ordered list of (frame, freq_bin)."""
    nf = S.shape[0]
    edges = _BAND_EDGES
    nb = len(edges) - 1
    if nf == 0 or nb <= 0:
        return []

    peak_bin = np.zeros((nf, nb), np.int32)
    peak_val = np.zeros((nf, nb), np.float32)
    for b in range(nb):
        lo, hi = int(edges[b]), int(edges[b + 1])
        if hi <= lo:
            continue
        seg = S[:, lo:hi]
        am = seg.argmax(axis=1)
        peak_bin[:, b] = am + lo
        peak_val[:, b] = seg[np.arange(nf), am]

    # Keep the stronger half of each frame's band peaks, and drop near-silent frames.
    frame_mean = peak_val.mean(axis=1, keepdims=True)
    floor = peak_val.mean() * 0.1
    mask = (peak_val >= frame_mean) & (peak_val > floor)

    ti, bi = np.nonzero(mask)  # row-major => already sorted by frame, then band
    fb = peak_bin[ti, bi]
    pts = list(zip(ti.tolist(), fb.tolist()))
    if len(pts) > MAX_PEAKS:
        pts = pts[:MAX_PEAKS]  # earliest-in-time prefix (deterministic)
    return pts


def fingerprint_pcm(raw: bytes) -> list[int]:
    """Return the constellation sub-fingerprint set for raw 16-bit stereo 44.1kHz PCM."""
    if len(raw) < FRAME * DECIM * 4:
        return []
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    x = x.reshape(-1, 2).mean(axis=1)[::DECIM]  # stereo -> mono, decimate
    pts = _peaks(_spectrogram(x))
    if len(pts) < 2:
        return []

    hashes = set()
    n = len(pts)
    for i in range(n):
        t1, f1 = pts[i]
        fan = 0
        j = i + 1
        while j < n and fan < FAN:
            t2, f2 = pts[j]
            dt = t2 - t1
            if dt < DT_MIN:
                j += 1
                continue
            if dt > DT_MAX:
                break
            # (f1>>2) | (f2>>2) | Δt  — translation-invariant via Δt, freq coarsened.
            q1, q2 = (f1 >> FQ_SHIFT) & 0x3FF, (f2 >> FQ_SHIFT) & 0x3FF
            h = (q1 << 16) | (q2 << 6) | (dt & 0x3F)
            hashes.add(h & _MASK)
            fan += 1
            j += 1
        if len(hashes) >= MAX_HASHES:
            break
    return sorted(hashes)
