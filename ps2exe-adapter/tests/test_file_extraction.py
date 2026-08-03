import datetime as dt
import io
import os
import zipfile

from prism_adapter.cli import _extract_reader_files
from prism_adapter.progress import ProgressManager


class TreeReader:
    def __init__(self, entries):
        self.entries = entries

    def get_root_dir(self):
        return None

    def iso_iterator(self, _root, recursive=True, include_dirs=False):
        return iter(range(len(self.entries)))

    def get_file_path(self, entry):
        return self.entries[entry][0]

    def is_directory(self, entry):
        return self.entries[entry][1] is None

    def get_file_date(self, entry):
        return self.entries[entry][2]

    def get_file_size(self, entry):
        return len(self.entries[entry][1])

    def open_file(self, entry):
        return io.BytesIO(self.entries[entry][1])


class PartialStream(io.BytesIO):
    def __init__(self, data, readable):
        super().__init__(data)
        self.readable = readable

    def read(self, size=-1):
        if self.tell() >= self.readable:
            raise OSError("simulated bad sector")
        return super().read(min(size, self.readable - self.tell()))


class FaultyReader(TreeReader):
    def open_file(self, entry):
        if entry == 0:
            return PartialStream(self.entries[entry][1], readable=4)
        if entry == 1:
            raise OSError("simulated unreadable file")
        return super().open_file(entry)


def make_zip(members):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return out.getvalue()


def extract(reader, out, recursive=False, inherited=None):
    return _extract_reader_files(
        reader,
        str(out),
        ProgressManager(),
        mods=None,
        recursive=recursive,
        inherited_date=inherited,
    )


def test_one_level_copies_archives_verbatim(tmp_path):
    packed = make_zip({"inside.txt": b"hello"})
    count = extract(TreeReader([("/DATA.ZIP", packed, None)]), tmp_path)

    assert count == 1
    assert (tmp_path / "DATA.ZIP").is_file()
    assert (tmp_path / "DATA.ZIP").read_bytes() == packed


def test_recursive_replaces_archive_with_its_file_tree(tmp_path):
    inner = make_zip({"deep.txt": b"bottom"})
    outer = make_zip({"plain.bin": b"top", "inner.zip": inner})
    count = extract(TreeReader([("/PACK.ZIP", outer, None)]), tmp_path, recursive=True)

    assert count == 2
    assert (tmp_path / "PACK.ZIP").is_dir()
    assert (tmp_path / "PACK.ZIP" / "plain.bin").read_bytes() == b"top"
    assert (tmp_path / "PACK.ZIP" / "inner.zip" / "deep.txt").read_bytes() == b"bottom"


def test_corrupt_archive_magic_stays_a_file(tmp_path):
    broken = b"PK\x03\x04" + b"not really a zip"
    count = extract(TreeReader([("/BROKEN.ZIP", broken, None)]), tmp_path, recursive=True)

    assert count == 1
    assert (tmp_path / "BROKEN.ZIP").read_bytes() == broken


def test_dates_inherit_from_parent_directory_and_volume(tmp_path):
    volume_date = dt.datetime(2001, 2, 3, 4, 5, 6, tzinfo=dt.timezone.utc)
    directory_date = dt.datetime(2002, 3, 4, 5, 6, 7, tzinfo=dt.timezone.utc)
    reader = TreeReader(
        [
            ("/DIR", None, directory_date),
            ("/DIR/CHILD.BIN", b"child", None),
            ("/ROOT.BIN", b"root", None),
        ]
    )

    extract(reader, tmp_path, inherited=volume_date)

    assert os.stat(tmp_path / "DIR" / "CHILD.BIN").st_mtime == directory_date.timestamp()
    assert os.stat(tmp_path / "ROOT.BIN").st_mtime == volume_date.timestamp()
    assert os.stat(tmp_path / "DIR").st_mtime == directory_date.timestamp()


def test_unreadable_files_keep_partial_bytes_get_bad_suffix_and_do_not_stop(tmp_path):
    file_date = dt.datetime(2003, 4, 5, 6, 7, 8, tzinfo=dt.timezone.utc)
    reader = FaultyReader(
        [
            ("/PARTIAL.DAT", b"four-more-bytes", file_date),
            ("/MISSING.BIN", b"unavailable", None),
            ("/AFTER.TXT", b"still extracted", None),
        ]
    )

    count = extract(reader, tmp_path)

    assert count == 3
    assert not (tmp_path / "PARTIAL.DAT").exists()
    assert (tmp_path / "PARTIAL_BAD.DAT").read_bytes() == b"four"
    assert os.stat(tmp_path / "PARTIAL_BAD.DAT").st_mtime == file_date.timestamp()
    assert (tmp_path / "MISSING_BAD.BIN").read_bytes() == b""
    assert (tmp_path / "AFTER.TXT").read_bytes() == b"still extracted"
