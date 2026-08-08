"""Archives inside a volume list and asset-extract as if they were directories.

These run the real ArchiveWrapper/CompressedPathReader stack from lib/ps2exe over
in-memory zip fixtures served through a minimal fake volume reader.
"""

import hashlib
import io
import os
import pathlib
import subprocess
import sys
import zipfile

from prism_adapter import viewable
from prism_adapter.cli import _PS2EXE_DIR, _extract_assets, _hash_files
from prism_adapter.progress import ProgressManager


class FakeVolume:
    """Minimal volume reader: files as {path: bytes}, no directories."""

    def __init__(self, files):
        self.files = list(files.items())

    def get_root_dir(self):
        return None

    def iso_iterator(self, _root, recursive=True, include_dirs=False):
        return iter(range(len(self.files)))

    def is_directory(self, f):
        return False

    def get_file_date(self, f):
        return None

    def get_file_path(self, f):
        return self.files[f][0]

    def get_file_size(self, f):
        return len(self.files[f][1])

    def open_file(self, f):
        return io.BytesIO(self.files[f][1])


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
SRC = b"int main(void) { return 0; }\n"


def make_zip(members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    return buf.getvalue()


def hash_files(files):
    recs = _hash_files(FakeVolume(files), ProgressManager())
    return {r["path"]: r for r in recs}


def test_zip_members_are_listed_as_directory_contents():
    zip_bytes = make_zip({"src/main.c": SRC, "title.png": PNG})
    recs = hash_files({"/README.TXT": b"hello", "/DATA/PROTO.ZIP": zip_bytes})

    # The archive itself stays a normal, fully hashed file (identity input).
    z = recs["/DATA/PROTO.ZIP"]
    assert "in_archive" not in z
    assert z["sha1"] == hashlib.sha1(zip_bytes).hexdigest()

    # Members ride under the archive's path, hashed but unfingerprinted.
    m = recs["/DATA/PROTO.ZIP/src/main.c"]
    assert m["in_archive"] is True
    assert m["size"] == len(SRC)
    assert m["sha1"] == hashlib.sha1(SRC).hexdigest()
    assert m["sha256"] == hashlib.sha256(SRC).hexdigest()
    assert "chunks" not in m and "shingle" not in m
    assert recs["/DATA/PROTO.ZIP/title.png"]["md5"] == hashlib.md5(PNG).hexdigest()


def test_nested_archives_recurse():
    inner = make_zip({"deep.txt": b"bottom"})
    outer = make_zip({"inner.zip": inner})
    recs = hash_files({"/A.ZIP": outer})

    assert recs["/A.ZIP/inner.zip"]["in_archive"] is True
    deep = recs["/A.ZIP/inner.zip/deep.txt"]
    assert deep["in_archive"] is True
    assert deep["sha1"] == hashlib.sha1(b"bottom").hexdigest()


def test_corrupt_archive_stays_a_plain_file():
    fake = b"PK\x03\x04" + b"\xde\xad\xbe\xef" * 64
    recs = hash_files({"/BROKEN.ZIP": fake, "/OK.BIN": b"fine"})

    assert recs["/BROKEN.ZIP"]["sha1"] == hashlib.sha1(fake).hexdigest()
    assert "unreadable" not in recs["/BROKEN.ZIP"]
    assert [p for p in recs if p.startswith("/BROKEN.ZIP/")] == []


def test_parent_watchdog_can_skip_a_stalled_archive(monkeypatch):
    monkeypatch.setenv("PRISM_SKIP_ARCHIVES", '["/A.ZIP"]')
    recs = hash_files({"/A.ZIP": make_zip({"inside.txt": b"data"})})

    assert recs["/A.ZIP"]["sha1"]
    assert "/A.ZIP/inside.txt" not in recs


def test_member_assets_are_extracted(tmp_path):
    zip_bytes = make_zip({"art/title.png": PNG, "notes.txt": b"prototype notes\n"})
    out = _extract_assets(FakeVolume({"/DATA/PROTO.ZIP": zip_bytes}), str(tmp_path), ProgressManager())
    assets = {a["path"]: a for a in out}

    # The archive keeps its own head-snippet asset (hex view) …
    z = assets["/DATA/PROTO.ZIP"]
    assert z["kind"] == viewable.SNIPPET_KIND

    # … and its viewable members ship whole under prefixed paths.
    png = assets["/DATA/PROTO.ZIP/art/title.png"]
    assert (png["kind"], png["mime"], png["size"]) == ("image", "image/png", len(PNG))
    blob = (tmp_path / png["sha256"][:2] / png["sha256"]).read_bytes()
    assert blob == PNG
    assert assets["/DATA/PROTO.ZIP/notes.txt"]["kind"] == "text"


# Runs in a subprocess: the regression is process death, not a catchable exception.
_TEARDOWN_SRC = '''
import io, os, sys, zipfile
sys.path.insert(0, os.environ["PS2EXE_DIR"])
sys.path.insert(0, os.environ["ADAPTER_DIR"])

import libarchive
from prism_adapter.progress import ProgressManager
from utils.archives import ArchiveWrapper

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("big.bin", b"A" * (1 << 20))
    z.writestr("second.bin", b"B" * (1 << 20))
src = io.BytesIO(buf.getvalue())
src.name = "TEARDOWN.ZIP"

wrapper = ArchiveWrapper(src, None, ProgressManager())
wrapper.__enter__()
entry = next(iter(wrapper))
reader = entry.open()
reader[0:16]  # partial, the rest of the member is still inside libarchive

# An unlistable member archive tears the wrapper down with readers still open
wrapper.__exit__(None, None, None)

# close() drains to EOF and a further read asks outright, both used to walk
# into the freed handle
reader.close()
try:
    reader._closed = False
    reader[16:32]
except libarchive.ArchiveError:
    pass
print("OK")
'''


def test_reader_outliving_its_archive_does_not_kill_the_process(tmp_path):
    """A reader outliving its archive must not touch the freed libarchive
    handle: that kills the process, so one unreadable member used to cost the
    entire build."""
    script = tmp_path / "teardown.py"
    script.write_text(_TEARDOWN_SRC)
    env = {
        **os.environ,
        "PS2EXE_DIR": str(_PS2EXE_DIR),
        "ADAPTER_DIR": str(pathlib.Path(__file__).resolve().parents[1]),
    }
    proc = subprocess.run(
        [sys.executable, str(script)], env=env, capture_output=True, text=True
    )

    assert proc.returncode == 0, (
        f"adapter process died (returncode {proc.returncode})\n{proc.stderr}"
    )
    assert "OK" in proc.stdout
