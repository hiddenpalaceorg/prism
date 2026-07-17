"""Archives inside a volume list and asset-extract as if they were directories.

These run the real ArchiveWrapper/CompressedPathReader stack from lib/ps2exe over
in-memory zip fixtures served through a minimal fake volume reader.
"""

import hashlib
import io
import zipfile

from curator_adapter import viewable
from curator_adapter.cli import _extract_assets, _hash_files
from curator_adapter.progress import ProgressManager


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
