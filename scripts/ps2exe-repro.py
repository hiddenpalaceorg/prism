"""Deterministic ps2exe-library reproduction driver (no enlighten CLI).

Drives ps2exe's own archive readers over every entry in a container, reading each
entry's bytes through the exact get_blocks() path the adapter uses. If a single
forward pass wedges (libarchive ARCHIVE_WARN loop), faulthandler dumps the stack
every 30s so we can see exactly where. If it finishes, prints DONE.

Usage: ps2exe-repro.py <file> [--rewalk]
  --rewalk  also try to parse each entry as a nested sub-archive first
            (mimics the adapter's _find_filesystem_reader re-iteration)
"""
import faulthandler
import logging
import os
import pathlib
import sys
import time

faulthandler.dump_traceback_later(30, repeat=True)
logging.basicConfig(level=logging.WARNING)

sys.path.insert(0, os.path.expanduser("~/curator/ps2exe-adapter"))
sys.path.insert(0, os.path.expanduser("~/curator/lib/ps2exe"))

from common.factory import IsoProcessorFactory  # noqa: E402
from common.iso_path_reader.methods.compressed import CompressedPathReader  # noqa: E402
from common.iso_path_reader.methods.directory import DirectoryPathReader  # noqa: E402
from patches import apply_patches  # noqa: E402
from curator_adapter.progress import ProgressManager  # noqa: E402

apply_patches()


def read_all(reader, rewalk):
    n = 0
    t0 = time.time()
    for entry in reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=False):
        name = reader.get_file_path(entry)
        if rewalk:
            # adapter-style: try to interpret each entry as a nested archive
            try:
                fh = reader.open_file(entry)
                if hasattr(fh, "__enter__"):
                    fh.__enter__()
                IsoProcessorFactory.get_iso_path_readers(fh, os.path.basename(name), reader, MGR)
            except Exception:
                pass
        try:
            fh = reader.open_file(entry)
            b = 0
            for chunk in iter(lambda: fh.read(65536), b""):
                b += len(chunk)
        except Exception as e:
            print(f"  entry err {name}: {e}", flush=True)
            continue
        n += 1
        if n % 200 == 0:
            print(f"  {n} entries read, last={name} ({b}B) @ {time.time()-t0:.0f}s", flush=True)
    print(f"DONE: read {n} entries in {time.time()-t0:.0f}s", flush=True)


MGR = ProgressManager()
path = sys.argv[1]
rewalk = "--rewalk" in sys.argv[2:]
print(f"file={path} rewalk={rewalk}", flush=True)
with open(path, "rb") as fp:
    parent = DirectoryPathReader(pathlib.Path(path).resolve().parent)
    readers, _exc = IsoProcessorFactory.get_iso_path_readers(fp, os.path.basename(path), parent, MGR)
    print(f"readers: {[type(r).__name__ for r in readers]}", flush=True)
    reader = readers[0]
    read_all(reader, rewalk)
