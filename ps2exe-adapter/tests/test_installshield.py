"""InstallShield cabinets inside a volume expand like archives.

These run the real InstallShieldCabWrapper/InstallShieldPathReader stack from
lib/ps2exe over synthetic single-volume IS5 cabinets served through a minimal
fake volume reader. The builder writes just the format subset the parser needs:
common header, V5 volume header, file table, V5 file descriptors, stored and
zlib-chunk file data.
"""

import hashlib
import io
import struct
import zlib

from prism_adapter import viewable
from prism_adapter.cli import _extract_assets, _hash_files
from prism_adapter.progress import ProgressManager

_COMMON = struct.Struct("<4sIIII")
_VOLHDR = struct.Struct("<I4x8I")
_FD_V5 = struct.Struct("<IH2xHII4xH2xH2x8xI")

_VERSION_IS5 = 0x01005000  # (version >> 12) & 0xF == 5
_FILE_COMPRESSED = 4

# 1999-06-15 12:30:00 in DOS date/time fields.
_DOS_DATE = (19 << 9) | (6 << 5) | 15
_DOS_TIME = (12 << 11) | (30 << 5)


def deflate_chunk(data):
    """One new-style chunk: 2-byte length prefix + a complete raw-deflate stream."""
    co = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    stream = co.compress(data) + co.flush()
    return struct.pack("<H", len(stream)) + stream


def make_iscab(files, compress=()):
    """A minimal single-volume InstallShield 5 cabinet.

    `files` maps member path (at most one directory level) to bytes; paths in
    `compress` are stored as new-style zlib chunks, the rest stored plain.
    """
    items = []  # (dir, name, plain, blob, flags)
    dirs = []
    for path, data in files.items():
        d, _, n = path.rpartition("/")
        if d and d not in dirs:
            dirs.append(d)
        if path in compress:
            items.append((d, n, data, deflate_chunk(data), _FILE_COMPRESSED))
        else:
            items.append((d, n, data, data, 0))

    data_off = _COMMON.size + _VOLHDR.size
    offsets, pos = [], data_off
    for _d, _n, _plain, blob, _fl in items:
        offsets.append(pos)
        pos += len(blob)
    desc_off = pos

    # Descriptor region: CabDescriptor at +0, the 71 file-group list heads at
    # +0x3E left zero (no groups), file table just past them.
    table_off = 0x3E + 71 * 4 + 6
    count = len(dirs) + len(items)
    heap = bytearray()
    heap_base = count * 4

    def put(blob):
        off = heap_base + len(heap)
        heap.extend(blob)
        return off

    table = []
    for d in dirs:
        table.append(put(d.encode("cp1252") + b"\x00"))
    for (d, n, plain, blob, flags), off in zip(items, offsets):
        name_off = put(n.encode("cp1252") + b"\x00")
        fd = _FD_V5.pack(name_off, dirs.index(d) if d else 0xFFFF, flags,
                         len(plain), len(blob), _DOS_DATE, _DOS_TIME, off)
        table.append(put(fd + b"\x00" * 16))  # V5 reads a trailing md5 slot
    table_size = count * 4 + len(heap)

    descriptor = bytearray(table_off)
    descriptor[:48] = struct.pack("<12xI4xIII8xII", table_off, table_size,
                                  table_size, len(dirs), len(items), 0)
    descriptor.extend(struct.pack("<%dI" % count, *table) if table else b"")
    descriptor.extend(heap)

    # Sized so the FILE_SPLIT derivation sees whole files in this volume.
    first_sizes = (len(items[0][2]), len(items[0][3])) if items else (0, 0)
    last_sizes = (len(items[-1][2]), len(items[-1][3])) if items else (0, 0)
    volhdr = _VOLHDR.pack(data_off, 0, max(len(items) - 1, 0),
                          offsets[0] if items else 0, *first_sizes,
                          offsets[-1] if items else 0, *last_sizes)

    out = bytearray(_COMMON.pack(b"ISc(", _VERSION_IS5, 0, desc_off, len(descriptor)))
    out.extend(volhdr)
    for _d, _n, _plain, blob, _fl in items:
        out.extend(blob)
    out.extend(descriptor)
    return bytes(out)


class FakeVolume:
    """Minimal volume reader: files as {path: bytes}. Unlike the archive tests'
    fake this also resolves paths, which the cab wrapper uses to find the other
    pieces of a volume set (data2.cab, a .hdr anchor)."""

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

    def get_file(self, path):
        for i, (name, _data) in enumerate(self.files):
            if name.lstrip("/") == path.lstrip("/"):
                return i
        raise FileNotFoundError(path)

    def open_file(self, f):
        return io.BytesIO(self.files[f][1])


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
INI = b"[Setup]\nTitle=Proto\n"
EXE = b"MZ" + bytes(range(256)) * 8


def hash_files(files):
    recs = _hash_files(FakeVolume(files), ProgressManager())
    return {r["path"]: r for r in recs}


def test_cab_members_are_listed_as_directory_contents():
    cab = make_iscab({"SETUP.INI": INI, "prog/GAME.EXE": EXE},
                     compress={"prog/GAME.EXE"})
    recs = hash_files({"/DATA1.CAB": cab, "/README.TXT": b"hello"})

    # The cabinet itself stays a normal, fully hashed file (identity input).
    c = recs["/DATA1.CAB"]
    assert "in_archive" not in c
    assert c["sha1"] == hashlib.sha1(cab).hexdigest()

    # Members ride under the cabinet's path, hashed but unfingerprinted.
    ini = recs["/DATA1.CAB/SETUP.INI"]
    assert ini["in_archive"] is True
    assert ini["size"] == len(INI)
    assert ini["sha1"] == hashlib.sha1(INI).hexdigest()
    assert ini["date"] == "1999-06-15 12:30:00"
    assert "chunks" not in ini and "shingle" not in ini

    # A compressed member decodes through the zlib chunk path.
    exe = recs["/DATA1.CAB/prog/GAME.EXE"]
    assert exe["sha256"] == hashlib.sha256(EXE).hexdigest()
    assert "unreadable" not in exe


def test_secondary_volume_stays_a_plain_file():
    cab = make_iscab({"SETUP.INI": INI})
    # A data volume: valid signature, but the set is anchored at DATA1.CAB.
    data2 = _COMMON.pack(b"ISc(", _VERSION_IS5, 0, 0, 0) + b"\x00" * 64
    recs = hash_files({"/DATA1.CAB": cab, "/DATA2.CAB": data2})

    assert recs["/DATA1.CAB/SETUP.INI"]["in_archive"] is True
    assert recs["/DATA2.CAB"]["sha1"] == hashlib.sha1(data2).hexdigest()
    assert [p for p in recs if p.startswith("/DATA2.CAB/")] == []


def test_empty_and_corrupt_cabs_stay_plain_files():
    empty = make_iscab({})
    corrupt = b"ISc(" + b"\xde\xad\xbe\xef" * 20
    recs = hash_files({"/EMPTY.CAB": empty, "/BROKEN.CAB": corrupt, "/OK.BIN": b"fine"})

    assert recs["/EMPTY.CAB"]["sha1"] == hashlib.sha1(empty).hexdigest()
    assert recs["/BROKEN.CAB"]["sha1"] == hashlib.sha1(corrupt).hexdigest()
    assert "unreadable" not in recs["/BROKEN.CAB"]
    assert [p for p in recs if "/EMPTY.CAB/" in p or "/BROKEN.CAB/" in p] == []


def test_cab_member_assets_are_extracted(tmp_path):
    cab = make_iscab({"ART/TITLE.PNG": PNG}, compress={"ART/TITLE.PNG"})
    out = _extract_assets(FakeVolume({"/DATA1.CAB": cab}), str(tmp_path), ProgressManager())
    assets = {a["path"]: a for a in out}

    # The cabinet keeps its own head-snippet asset (hex view) …
    assert assets["/DATA1.CAB"]["kind"] == viewable.SNIPPET_KIND

    # … and its viewable members ship whole under prefixed paths.
    png = assets["/DATA1.CAB/ART/TITLE.PNG"]
    assert (png["kind"], png["mime"], png["size"]) == ("image", "image/png", len(PNG))
    blob = (tmp_path / png["sha256"][:2] / png["sha256"]).read_bytes()
    assert blob == PNG
