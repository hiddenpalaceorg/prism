"""Tests for the byte-shingle resemblance signature (curator_adapter.cli).

Validates the vectorized OPH against an independent pure-Python reference, that the
streaming feed matches a one-shot feed, and the defining property: resemblance stays
~1.0 under many small *scattered* edits (where exact CDC chunks collapse) while unrelated
data scores ~0.
"""

import random

import pytest

from curator_adapter.cli import (
    _SHINGLE_K,
    _SHINGLE_W,
    _ShingleSignature,
)

_POLY = 1099511628211
_M64 = (1 << 64) - 1
_M63 = (1 << 63) - 1
_BINSHIFT = 63 - _SHINGLE_K.bit_length() + 1


def _ref(data, w=_SHINGLE_W, k=_SHINGLE_K):
    """Plain-Python OPH over w-shingles — the spec the numpy version must match."""
    if len(data) < w:
        return None
    sig = [_M63] * k
    for i in range(len(data) - w + 1):
        h = 0
        for b in data[i : i + w]:
            h = (h * _POLY + b) & _M64
        h ^= h >> 33
        h = (h * 0xFF51AFD7ED558CCD) & _M64
        h ^= h >> 33
        h &= _M63
        b = h >> _BINSHIFT
        if h < sig[b]:
            sig[b] = h
    return sig


def _oneshot(data):
    s = _ShingleSignature()
    s.update(data)
    return s.finish()


def _streamed(data, read_size):
    s = _ShingleSignature()
    for i in range(0, len(data), read_size):
        s.update(data[i : i + read_size])
    return s.finish()


def _agree(a, b):
    return sum(1 for x, y in zip(a, b) if x == y) / len(a)


def test_matches_pure_python_reference():
    data = random.Random(1).randbytes(300 * 1024)
    assert _oneshot(data) == _ref(data)


@pytest.mark.parametrize("read_size", [65536, 4096, 1, _SHINGLE_W - 1, _SHINGLE_W + 1])
def test_streaming_matches_oneshot(read_size):
    data = random.Random(2).randbytes(257 * 1024)
    assert _streamed(data, read_size) == _oneshot(data)


def test_too_small_returns_none():
    assert _ShingleSignature().finish() is None
    assert _oneshot(b"\x00" * (_SHINGLE_W - 1)) is None


def test_resembles_under_scattered_edits_but_not_unrelated():
    rnd = random.Random(7)
    base = rnd.randbytes(2 * 1024 * 1024)

    # 200 single-byte edits sprinkled across the file (dense — one per ~10KB).
    ba = bytearray(base)
    for _ in range(200):
        ba[rnd.randrange(len(ba))] ^= 0x5A
    scattered = _oneshot(bytes(ba))

    # A handful of multi-byte insertions (shifts everything downstream).
    parts, pos = [], 0
    for _ in range(5):
        nxt = pos + len(base) // 6
        parts.append(base[pos:nxt] + rnd.randbytes(40))
        pos = nxt
    parts.append(base[pos:])
    inserted = _oneshot(b"".join(parts))

    unrelated = _oneshot(rnd.randbytes(2 * 1024 * 1024))
    ref = _oneshot(base)

    assert _agree(ref, scattered) > 0.95, _agree(ref, scattered)
    assert _agree(ref, inserted) > 0.95, _agree(ref, inserted)
    assert _agree(ref, unrelated) < 0.05, _agree(ref, unrelated)
