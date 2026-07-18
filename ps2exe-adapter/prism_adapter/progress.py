"""A duck-typed stand-in for enlighten's Manager/Counter that emits NDJSON progress
events on stderr instead of drawing terminal bars.

ps2exe constructs counters via ``manager.counter(total=, desc=, unit=, file_name=, ...)``
and drives them with ``counter.update(incr=1, **fields)``; ``HashProgressWrapper``
increments by ``len(data)`` for byte-level hashing progress. We reproduce only that
surface. Output is throttled so byte updates don't flood the pipe.
"""

import json
import sys
import time

_THROTTLE_SECONDS = 0.05


def _emit(obj):
    sys.stderr.write(json.dumps(obj))
    sys.stderr.write("\n")
    sys.stderr.flush()


class _Counter:
    def __init__(self, manager, total=None, unit="", desc=None, file_name=None, **_kw):
        self.manager = manager
        self.id = manager._next_id()
        self._total = float(total) if total is not None else None
        self.count = 0.0
        self.unit = unit or ""
        self.label = desc or file_name or ""
        self._last_emit = 0.0
        # ps2exe's ArchiveWrapper inspects `counter._closed` during cleanup.
        self._closed = False
        self._emit_open()

    # ps2exe sets `.total` and `.count` directly between files; re-announce on retotal.
    @property
    def total(self):
        return self._total

    @total.setter
    def total(self, value):
        self._total = float(value) if value is not None else None
        self._emit_open()

    def _emit_open(self):
        _emit({
            "ev": "counter_open",
            "id": self.id,
            "label": self.label,
            "unit": self.unit,
            "total": self._total,
        })

    def update(self, incr=1, **fields):
        relabel = False
        if "file_name" in fields:
            self.label = fields["file_name"] or ""
            relabel = True
        if "desc" in fields:
            self.label = fields["desc"] or ""
            relabel = True
        if relabel:
            self._emit_open()
        self.count += incr
        now = time.monotonic()
        if now - self._last_emit >= _THROTTLE_SECONDS or (
            self._total is not None and self.count >= self._total
        ):
            self._last_emit = now
            _emit({"ev": "progress", "id": self.id, "count": self.count})

    def close(self):
        if self._closed:
            return
        self._closed = True
        _emit({"ev": "counter_close", "id": self.id})

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
        return False


class ProgressManager:
    """Minimal enlighten.Manager replacement."""

    def __init__(self):
        self._id = 0
        self.counters = {}

    def _next_id(self):
        self._id += 1
        return self._id

    def counter(self, **kwargs):
        return _Counter(self, **kwargs)
