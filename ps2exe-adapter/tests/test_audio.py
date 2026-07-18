"""Tests for the constellation audio fingerprint (prism_adapter.audio).

Synthesizes deterministic PCM (no real disc needed) and asserts the key properties:
identical match, offset tolerance (the whole point of the constellation design), and
discrimination against unrelated audio.
"""

import numpy as np
import pytest

from prism_adapter import audio

SR = audio.SR0


def jaccard(a, b):
    A, B = set(a), set(b)
    return len(A & B) / len(A | B) if (A or B) else 1.0


def song(seconds=25, seed=0, notes=None):
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    x = np.zeros(n, np.float32)
    notes = notes or [220, 247, 262, 294, 330, 349, 392]
    seg = int(0.5 * SR)
    for s0 in range(0, n, seg):
        base = notes[rng.integers(len(notes))]
        sl = slice(s0, min(s0 + seg, n))
        tt = t[sl]
        chord = sum(np.sin(2 * np.pi * base * m * tt) for m in (1.0, 1.25, 1.5))
        x[sl] += (chord * np.hanning(len(tt))).astype(np.float32)
    x += 0.02 * rng.standard_normal(n).astype(np.float32)
    x /= np.max(np.abs(x)) + 1e-9
    return x


def to_pcm(x, prepend=0):
    if prepend:
        pad = 0.001 * np.random.default_rng(9).standard_normal(prepend).astype(np.float32)
        x = np.concatenate([pad, x])
    i16 = np.clip(x * 30000, -32768, 32767).astype("<i2")
    return np.repeat(i16[:, None], 2, axis=1).reshape(-1).tobytes()


@pytest.fixture(scope="module")
def base_fp():
    return audio.fingerprint_pcm(to_pcm(song(seed=1)))


def test_identical_is_one(base_fp):
    again = audio.fingerprint_pcm(to_pcm(song(seed=1)))
    assert jaccard(base_fp, again) == 1.0


def test_integer_frame_offset_is_invariant(base_fp):
    # an exact whole-frame shift must barely change the fingerprint
    shifted = audio.fingerprint_pcm(to_pcm(song(seed=1), prepend=audio.HOP * audio.DECIM * 3))
    assert jaccard(base_fp, shifted) > 0.9


def test_sub_frame_and_sector_offsets_tolerated(base_fp):
    arb = audio.fingerprint_pcm(to_pcm(song(seed=1), prepend=5000))
    sector = audio.fingerprint_pcm(to_pcm(song(seed=1), prepend=588))  # 1 CD sector
    assert jaccard(base_fp, arb) > 0.45
    assert jaccard(base_fp, sector) > 0.5


def test_different_songs_discriminated(base_fp):
    other = audio.fingerprint_pcm(to_pcm(song(seed=99, notes=[523, 587, 659, 698, 784, 880, 988])))
    assert jaccard(base_fp, other) < 0.4


def test_hashes_are_json_number_safe_sorted_unique(base_fp):
    assert base_fp == sorted(base_fp)
    assert len(base_fp) == len(set(base_fp))
    assert all(0 <= h < (1 << 26) for h in base_fp)  # fit a JSON number comfortably


def test_silence_and_short_input_empty():
    assert audio.fingerprint_pcm(b"") == []
    assert audio.fingerprint_pcm((b"\x00" * 1000)) == []  # below the minimum length


def test_is_audio_track():
    assert audio.is_audio_track(b"\x01" * 32, audio.SECTOR * 4)       # whole sectors, no sync
    assert not audio.is_audio_track(audio.DATA_SYNC + b"\x00" * 20, audio.SECTOR)  # data sync
    assert not audio.is_audio_track(b"\x01" * 32, audio.SECTOR + 1)   # not a sector multiple


def test_parse_cue():
    cue = (
        'FILE "game.bin" BINARY\n'
        "  TRACK 01 MODE1/2352\n"
        "    INDEX 01 00:00:00\n"
        "  TRACK 02 AUDIO\n"
        "    INDEX 01 03:30:00\n"
    )
    files = audio.parse_cue(cue)
    assert len(files) == 1
    assert files[0]["file"] == "game.bin"
    tracks = files[0]["tracks"]
    assert [t["num"] for t in tracks] == [1, 2]
    assert tracks[1]["type"] == "AUDIO"
    assert tracks[1]["start_frame"] == (3 * 60 + 30) * 75  # mm:ss:ff -> frames
