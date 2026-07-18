"""Tests for the streaming content-defined chunker (prism_adapter.cli).

The streaming chunker must produce byte-identical output to running fastcdc() over the
whole file at once (so files no longer need to fit in memory), and it must localize a
mid-file insertion to a few chunks — the byte-shift independence that lets successive
game builds still match via chunk similarity.
"""

import random

import pytest

from prism_adapter.cli import (
    _CDC_AVG,
    _CDC_MAX,
    _CDC_MIN,
    _CHUNK_FLUSH,
    _StreamingChunker,
    _chunk_pair,
    fastcdc,
)


def _oneshot(data):
    return [
        _chunk_pair(c.data)
        for c in fastcdc(bytes(data), min_size=_CDC_MIN, avg_size=_CDC_AVG, max_size=_CDC_MAX, fat=True)
    ]


def _streamed(data, read_size):
    ch = _StreamingChunker()
    for i in range(0, len(data), read_size):
        ch.update(data[i : i + read_size])
    return ch.finish()


def _blob(size, seed):
    # Genuinely non-repeating bytes — periodic data would give FastCDC too few distinct
    # chunks to be a realistic stand-in for file content.
    return random.Random(seed).randbytes(size)


# Sizes straddling chunk bounds and the flush threshold; read granularities that don't
# align to any boundary.
@pytest.mark.parametrize(
    "size",
    [0, 1, 100, _CDC_MIN, _CDC_AVG, _CDC_MAX, _CDC_MAX + 1, _CHUNK_FLUSH - 1, _CHUNK_FLUSH, _CHUNK_FLUSH + 5000, 3 * _CHUNK_FLUSH + 12345],
)
@pytest.mark.parametrize("read_size", [65536, 1000, 7])
def test_streaming_matches_oneshot(size, read_size):
    data = _blob(size, seed=1234)
    assert _streamed(data, read_size) == _oneshot(data)


def test_no_size_cap_and_shift_tolerant():
    # A blob larger than the old 256 MB cap (which yielded zero chunks) still chunks,
    # and a mid-file insertion stays highly similar instead of missing entirely.
    base = _blob(20 * 1024 * 1024 + 7, seed=99)
    ins = _blob(5000, seed=5)
    cut = 8 * 1024 * 1024
    v2 = base[:cut] + ins + base[cut:]

    a = {h for h, _ in _streamed(base, 65536)}
    b = {h for h, _ in _streamed(v2, 65536)}
    assert a, "large file must produce chunks (no cap)"
    jaccard = len(a & b) / len(a | b)
    assert jaccard > 0.9, jaccard
