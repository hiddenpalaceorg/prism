"""Analyze a disc image, container, or folder (a split multi-track dump opened as
one build) with ps2exe and emit canonical-raw JSON on stdout.

Progress is streamed as NDJSON on stderr (see progress.ProgressManager). All ps2exe
logging/prints are forced to stderr so stdout carries only the final JSON document.
"""

import argparse
import contextlib
import datetime as _dt
import hashlib
import json
import logging
import os
import pathlib
import re
import sys

import blake3
import numpy as np
from fastcdc import fastcdc

from .progress import ProgressManager

# FastCDC parameters — part of fingerprint_profile "v1". Changing these is a re-scan.
_CDC_MIN = 16 * 1024
_CDC_AVG = 64 * 1024
_CDC_MAX = 256 * 1024
# Streaming chunker flush threshold: process once the buffer comfortably exceeds one
# max-size chunk, so every committed boundary is decided by bytes already in hand.
# Bounds chunker memory regardless of file size (no whole-file buffering / size cap).
_CHUNK_FLUSH = 8 * 1024 * 1024
_HASH63 = (1 << 63) - 1

# Byte-shingle resemblance — One Permutation Hashing over w-byte shingles.
# Where exact CDC chunk hashes collapse under many small *scattered* edits, this stays
# high: each edit only perturbs the ~w shingles spanning it. A new RawBytes component
# (slated for the next fingerprint_profile bump); changing w/k/the hash is a re-scan.
_SHINGLE_W = 16                          # shingle window (bytes)
_SHINGLE_K = 128                         # OPH bins == signature length (power of two)
_SHINGLE_MIN_SIZE = 1 * 1024 * 1024      # only signature files this big (all bins fill)
_SHINGLE_FLUSH = 2 * 1024 * 1024         # vectorize this many buffered bytes at a time
_SHINGLE_POLY = np.uint64(1099511628211)            # Rabin–Karp base (odd)
_SHINGLE_BINSHIFT = np.uint64(63 - _SHINGLE_K.bit_length() + 1)  # top bits → bin index
_U64 = np.uint64
_MASK63_NP = np.uint64(_HASH63)

# ps2exe's modules are top-level (common/, cdi/, ...); put its root on sys.path.
_DEFAULT_PS2EXE = pathlib.Path(__file__).resolve().parents[2] / "lib" / "ps2exe"
_PS2EXE_DIR = pathlib.Path(os.environ.get("PRISM_PS2EXE_DIR", _DEFAULT_PS2EXE))


def _import_ps2exe():
    sys.path.insert(0, str(_PS2EXE_DIR))
    from common.factory import IsoProcessorFactory  # noqa: E402
    from common.processor import BaseIsoProcessor, GenericIsoProcessor  # noqa: E402
    from common.iso_path_reader.methods.compressed import CompressedPathReader  # noqa: E402
    from common.iso_path_reader.methods.directory import DirectoryPathReader  # noqa: E402
    from patches import apply_patches  # noqa: E402

    apply_patches()
    return {
        "factory": IsoProcessorFactory,
        "base": BaseIsoProcessor,
        "generic": GenericIsoProcessor,
        "compressed": CompressedPathReader,
        "directory": DirectoryPathReader,
    }


_VOLUME_PRIORITY = {
    "udf": 6,
    "rock_ridge": 5,
    "joliet": 4,
    "iso9660 (HD)": 3,
    "iso9660 (LD)": 2,
    "iso9660": 1,
}

_VERSION_SUFFIX = re.compile(r";\d+$")


# Fixed-width disc-header fields are NUL/garbage-padded: ps2exe decodes the
# whole field, so trailing (or embedded) control bytes ride along. Strip C0
# controls and DEL — they carry no meaning here and a literal NUL cannot even
# be stored in the downstream Postgres jsonb/text columns. Archive member names
# get the same scrub (see _clean_component): a crafted name must not smuggle a
# control byte into a `path` and abort the whole record's insert.
_CONTROL_CHARS = {c: None for c in range(0x20)}
_CONTROL_CHARS[0x7F] = None


def _clean_component(c):
    return _VERSION_SUFFIX.sub("", c.translate(_CONTROL_CHARS))


def _clean_path(p):
    # "." / ".." only occur in archive member names (never in disc paths); drop
    # them so a hostile or sloppy member name can't dress the tree up with fake
    # parent components.
    parts = [_clean_component(c) for c in p.strip("/").split("/") if c and c not in (".", "..")]
    return "/" + "/".join(parts)


def _nullify(v):
    # These header/volume/SFO fields are string-typed in the consumer's schema,
    # but ps2exe hands a few back as ints (e.g. SFO parental_level). Coerce any
    # non-None, non-str scalar to a string so a numeric value can't break the
    # consumer's string deserialization; None stays None.
    if v is None:
        return None
    if not isinstance(v, str):
        v = str(v)
    v = v.translate(_CONTROL_CHARS).strip()
    return v or None


def _fmt_date(d):
    if not isinstance(d, _dt.datetime):
        return None
    try:
        if d.tzinfo is not None:
            d = d.astimezone(_dt.timezone.utc)
        return d.strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OverflowError):
        return None


def _safe_dict(fn):
    try:
        result = fn()
        return result if isinstance(result, dict) else {}
    except Exception as e:  # noqa: BLE001 — ps2exe raises a wide variety
        logging.getLogger("prism-adapter").warning("metadata step failed: %s", e)
        return {}


# Capped so ranking never walks a whole multi-thousand-file DVD tree; any real
# game clears it, while a Dreamcast low-density track tops out at its 3 boilerplate
# files — enough to lose the tiebreaker to the high-density game volume.
_SCORE_FILE_CAP = 256


def _score_volume(reader):
    """Rank a candidate volume for selection as the disc's primary filesystem.

    Richer volume types win first (UDF/Joliet over bare ISO 9660); ties break on
    file count. The tiebreaker is what rescues Dreamcast GD-ROMs: the low-density
    track holds only three boilerplate ISO files, while the high-density track —
    same `iso9660` type — carries the actual game, so it wins on count."""
    priority = _VOLUME_PRIORITY.get(getattr(reader, "volume_type", ""), 0)
    count = 0
    try:
        for _ in reader.iso_iterator(reader.get_root_dir(), recursive=True):
            count += 1
            if count >= _SCORE_FILE_CAP:
                break
    except Exception:  # noqa: BLE001
        pass
    return (priority, count)


def _is_container(reader, mods):
    """Containers hold member files rather than a filesystem volume: an archive,
    or a directory (a folder opened as one multi-track build)."""
    return isinstance(reader, (mods["compressed"], mods["directory"]))


@contextlib.contextmanager
def _source_readers(path, basename, parent_dir, mods, manager):
    """Top-level path readers for a source. A directory becomes a directory
    container whose members are the folder's files (so a split multi-track dump
    processes like an archive of its tracks); a file goes through the factory's
    magic sniffing."""
    if os.path.isdir(path):
        yield [mods["directory"](pathlib.Path(path))]
    else:
        with open(path, "rb") as fp:
            parent = mods["directory"](parent_dir)
            readers, _exc = mods["factory"].get_iso_path_readers(fp, basename, parent, manager)
            yield readers


def _member_path(reader, entry, mods):
    """A member's path within its container. Directory members come back as host
    paths, so relativize them against the container root, with / separators."""
    path = reader.get_file_path(entry)
    if isinstance(reader, mods["directory"]):
        path = os.path.relpath(path, str(reader.get_root_dir())).replace(os.sep, "/")
    return path


def _enumerate_volumes(readers, mods, manager):
    """Every leaf filesystem volume reachable from the top-level `readers`, paired
    with the list of container-member names ('locator') needed to re-reach it
    (empty = top level).

    Reading member *directories* in a single archive pass is fine; reading member
    *content* is not, on a one-pass stream. So callers select a volume here, then
    reopen it via `_open_volume` to actually read bytes."""
    factory = mods["factory"]
    found = []

    def walk(reader, locator, depth):
        if not _is_container(reader, mods):
            found.append((locator, reader))
            return
        if depth > 4:
            return
        for entry in reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=False):
            name = os.path.basename(reader.get_file_path(entry))
            try:
                fh = reader.open_file(entry)
                if hasattr(fh, "__enter__"):
                    fh.__enter__()
                sub_readers, _e = factory.get_iso_path_readers(fh, name, reader, manager)
            except Exception:  # noqa: BLE001
                continue
            for sr in sub_readers:
                walk(sr, locator + [name], depth + 1)

    for r in readers:
        walk(r, [], 0)
    return found


def _open_volume(readers, locator, vtype, mods, manager):
    """Reopen the volume identified by (`locator`, `vtype`) from fresh top-level
    `readers`, opening *only* the members along `locator`. Touching sibling members
    first would strand a Dreamcast high-density track's content on a single-pass
    archive stream."""
    factory = mods["factory"]

    def pick(candidates):
        if not candidates:
            return None
        match = [r for r in candidates if getattr(r, "volume_type", None) == vtype]
        return (match or candidates)[0]

    if not locator:
        fs = [r for r in readers if not _is_container(r, mods)]
        return pick(fs or readers)

    current = readers
    for name in locator:
        container = next((r for r in current if _is_container(r, mods)), None)
        if container is None:
            return None
        target = next(
            (e for e in container.iso_iterator(container.get_root_dir(), recursive=True, include_dirs=False)
             if os.path.basename(container.get_file_path(e)) == name),
            None,
        )
        if target is None:
            return None
        fh = container.open_file(target)
        if hasattr(fh, "__enter__"):
            fh.__enter__()
        current, _e = factory.get_iso_path_readers(fh, name, container, manager)
    return pick(current)


class _NoHighDensityVolume(Exception):
    """Raised when a disc flagged for GD-ROM assembly exposes no high-density volume
    on the processing pass — the caller falls back to a plain streaming read."""


def _exe_fp_for(info, reader):
    exe = info.get("exe")
    if exe and exe.get("filename"):
        return _exe_fingerprint(reader, exe["filename"])
    return None


def _safe_processor(processor_class, reader, name, system, manager, mods):
    """Build the processor, falling back to the base initializer if the subclass one
    raises. Dreamcast's __init__ reassembles GD-ROM tracks from the .cue/.gdi; on
    non-standard discs (MIL-CD, cheat carts, demos) whose data track sits outside the
    expected slot that assembly can throw, and a plain read of the chosen volume is
    the best we can still do."""
    try:
        return processor_class(reader, name, system, manager)
    except Exception:  # noqa: BLE001
        proc = processor_class.__new__(processor_class)
        mods["base"].__init__(proc, reader, name, system, manager)
        return proc


def _process_streaming(path, basename, parent_dir, locator, vtype, mods, manager, work):
    """Run `work(processor, reader, system)` on the already-chosen volume by
    reopening straight to it. Used for every disc whose game lives in a single
    self-contained volume (PS1/2/3, Saturn, Mega CD, 3DO, combined Dreamcast
    images, …)."""
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    with _source_readers(path, basename, parent_dir, mods, manager) as readers:
        reader = _open_volume(readers, locator, vtype, mods, manager)
        if reader is None:
            raise SystemExit(f"could not reopen chosen volume in {path!r}")
        system = base.get_system_type(reader) or "unknown"
        processor_class = factory.get_iso_processor_class(system) or generic
        processor = _safe_processor(processor_class, reader, basename, system, manager, mods)
        return work(processor, reader, system)


def _has_boot_exe(processor, reader):
    """1 if this volume's filesystem holds the boot executable IP.BIN names, else 0.

    Dreamcast's IP.BIN bootstrap (shared across every high-density volume) records
    the boot filename at offset 0x60; the volume that actually *boots* is the one
    whose filesystem contains that file. Ranking on this is deterministic — the
    chosen volume is, by construction, the one hash_exe() can read the date from.
    File count stays only as a tiebreaker/fallback (see _process_gdrom), so a
    multi-partition disc's asset volume no longer outvotes the boot volume on sheer
    file count, and demos with no resolvable boot file still fall through cleanly."""
    get_name = getattr(processor, "get_exe_filename", None)
    if get_name is None:
        return 0
    try:
        boot = get_name()
    except Exception:  # noqa: BLE001 — garbage IP.BIN region on a non-boot volume
        return 0
    if not boot:
        return 0
    try:
        reader.get_file(boot.strip())
        return 1
    except Exception:  # noqa: BLE001 — boot file is not in this volume's filesystem
        return 0


def _process_gdrom(path, basename, parent_dir, mods, manager, work):
    """Run `work` on a Dreamcast GD-ROM whose game spans the high-density area.

    The boot volume's files can straddle several tracks, so we let the Dreamcast
    processor reassemble the image from the .cue/.gdi. That assembly reopens sibling
    tracks, which a single-pass archive only permits while we are still on the
    triggering member — so the processor must be built in the same pass that opens
    the high-density track (no prior enumeration of this stream). The reassembled
    reader is seekable (its tracks are mmapped), so we rank candidates by file count
    and hash only the richest."""
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    with _source_readers(path, basename, parent_dir, mods, manager) as readers:
        container = next((r for r in readers if _is_container(r, mods)), None)
        members = (
            list(container.iso_iterator(container.get_root_dir(), recursive=True, include_dirs=False))
            if container else [None]
        )
        best = None  # (score, processor, reader, system); score = (has_boot_exe, file_count)
        for entry in members:
            if container is not None:
                name = os.path.basename(container.get_file_path(entry))
                try:
                    fh = container.open_file(entry)
                    if hasattr(fh, "__enter__"):
                        fh.__enter__()
                    volumes, _e = factory.get_iso_path_readers(fh, name, container, manager)
                except Exception:  # noqa: BLE001
                    continue
            else:
                name, volumes = basename, readers
            for vol in volumes:
                # Only high-density volumes carry the boot game and trigger assembly.
                if not getattr(getattr(vol, "fp", None), "starting_sector", 0):
                    continue
                system = base.get_system_type(vol) or "dreamcast"
                processor_class = factory.get_iso_processor_class(system) or generic
                try:
                    processor = _safe_processor(processor_class, vol, name, system, manager, mods)
                except Exception:  # noqa: BLE001 — a later HD volume can't reopen consumed tracks
                    continue
                reader = processor.iso_path_reader  # reassembled (or the raw volume on fallback)
                # Prefer the volume that holds the IP.BIN-named boot exe (deterministic);
                # break ties / fall back on file count for discs with no resolvable boot.
                score = (_has_boot_exe(processor, reader), _score_volume(reader)[1])
                if best is None or score > best[0]:
                    best = (score, processor, reader, system)
        if best is None:
            raise _NoHighDensityVolume(path)
        _score, processor, reader, system = best
        return work(processor, reader, system)


def _gather_info(processor, reader, system, mods):
    disc = _safe_dict(processor.get_disc_type)
    pvd = _safe_dict(processor.get_pvd_info)
    if not pvd:
        pvd = _safe_dict(reader.get_pvd_info)
    extra = _safe_dict(processor.get_extra_fields)
    exe = _safe_dict(processor.hash_exe)

    header = {
        "title": _nullify(extra.get("header_title")),
        "product_number": _nullify(extra.get("header_product_number")),
        "product_version": _nullify(extra.get("header_product_version")),
        "release_date": _nullify(extra.get("header_release_date")),
        "maker_id": _nullify(extra.get("header_maker_id")),
        "device_info": _nullify(extra.get("header_device_info")),
        "regions": _nullify(extra.get("header_regions")),
    }
    volume = {
        "identifier": _nullify(pvd.get("volume_identifier")),
        "set_identifier": _nullify(pvd.get("volume_set_identifier")),
        "creation_date": _fmt_date(pvd.get("volume_creation_date")),
        "modification_date": _fmt_date(pvd.get("volume_modification_date")),
        "expiration_date": _fmt_date(pvd.get("volume_expiration_date")),
        "effective_date": _fmt_date(pvd.get("volume_effective_date")),
    }

    # Boot executable. `exe_signing_type`/`exe_num_symbols` ride in get_extra_fields, so
    # the block can exist even when hash_exe() found no filename (e.g. Xbox).
    exe_filename = _nullify(exe.get("exe_filename"))
    signing_type = _nullify(extra.get("exe_signing_type"))
    num_symbols = extra.get("exe_num_symbols")
    if not isinstance(num_symbols, int):
        num_symbols = None
    exe_out = None
    if exe_filename or signing_type or num_symbols is not None:
        exe_out = {
            "filename": _clean_path(exe_filename) if exe_filename else None,
            "date": _fmt_date(exe.get("exe_date")),
            "signing_type": signing_type,
            "num_symbols": num_symbols,
        }

    # Alternate/decrypted boot executable: PSP BOOT.BIN, PS3 decrypted EBOOT, Xbox(360)
    # decrypted PE. md5 is the stable identity since the on-disc exe is encrypted.
    alt_filename = _nullify(extra.get("alt_exe_filename"))
    alt_md5 = _nullify(extra.get("alt_md5"))
    alt_exe = None
    if alt_filename or alt_md5:
        alt_exe = {
            "filename": _clean_path(alt_filename) if alt_filename else None,
            "date": _fmt_date(extra.get("alt_exe_date")),
            "md5": alt_md5,
        }

    # PARAM.SFO metadata — PSP/PS3 carry this instead of a header_* block.
    sfo = {
        "title": _nullify(extra.get("sfo_title")),
        "disc_id": _nullify(extra.get("sfo_disc_id")),
        "disc_version": _nullify(extra.get("sfo_disc_version")),
        "category": _nullify(extra.get("sfo_category")),
        "parental_level": _nullify(extra.get("sfo_parental_level")),
        "system_version": _nullify(extra.get("sfo_psp_system_version")),
    }
    if not any(sfo.values()):
        sfo = None

    return {
        "system": system,
        "system_identifier": _nullify(pvd.get("system_identifier")),
        "header": header,
        "volume": volume,
        "exe": exe_out,
        "alt_exe": alt_exe,
        "sfo": sfo,
        "disc_type": _nullify(disc.get("disc_type")),
    }


# Archives found *inside* a volume are listed and asset-extracted as if they
# were directories: members ride under "<archive path>/..." with in_archive on,
# so they show up in the contents tree and the asset store. Identity stays
# untouched — composite hashing sees only the archive file's own hashes (the
# consumer skips in_archive records there), and members carry no chunk/shingle
# fingerprints. Detection is by leading bytes (plus
# tar's magic at offset 257). InstallShield cabinets expand the same way, with
# one twist: a multi-volume set is anchored at one member (the .hdr on IS6+,
# data1.cab before that) whose expansion pulls the sibling volumes in through
# the containing reader, while the secondary volumes themselves stay plain
# files. Anything that can't be opened (bare gzip of a single file,
# passworded/corrupt archives, a data-only cab volume) quietly stays a plain file.
_ARCHIVE_SNIFF_BYTES = 512
_ARCHIVE_MAX_DEPTH = 3

_ISHIELD_MAGIC = b"ISc("    # installshield cabinet/header

_ARCHIVE_MAGICS = (
    b"PK\x03\x04",          # zip
    b"7z\xBC\xAF\x27\x1C",  # 7z
    b"Rar\x21\x1A\x07",     # rar (v4 prefix of v5)
    b"MSCF",                # microsoft cabinet
    b"\x1F\x8B\x08",        # gzip (a .tar.gz; a bare .gz fails to open and stays a file)
    b"BZh",                 # bzip2
    b"\xFD7zXZ\x00",        # xz
    _ISHIELD_MAGIC,
)


def _looks_like_archive(head):
    return bool(head) and (head.startswith(_ARCHIVE_MAGICS) or head[257:262] == b"ustar")


class _ArchiveSource:
    """Member handle wrapper giving ArchiveWrapper the `.name` it expects;
    everything else (read/readinto/seek/…) proxies to the handle."""

    def __init__(self, fh, name):
        self._fh = fh
        self.name = name

    def __getattr__(self, attr):
        return getattr(self._fh, attr)


def _open_member_archive(reader, entry, path, manager, head=b""):
    """A CompressedPathReader over an archive or InstallShield-cabinet member, or
    None when the member can't be opened as one (unsupported/corrupt/passworded/a
    secondary cab volume). The caller must hand the result to
    _close_member_archive, which also releases the decompression spool and the
    member handle."""
    if str(_PS2EXE_DIR) not in sys.path:  # set by _import_ps2exe in normal runs
        sys.path.insert(0, str(_PS2EXE_DIR))
    from common.iso_path_reader.methods.compressed import (  # noqa: E402
        CompressedPathReader,
        InstallShieldPathReader,
    )
    from utils.archives import ArchiveWrapper  # noqa: E402
    from utils.installshield import InstallShieldCabWrapper  # noqa: E402

    fh = None
    try:
        fh = reader.open_file(entry)
        if hasattr(fh, "__enter__"):
            fh.__enter__()
        if head.startswith(_ISHIELD_MAGIC):
            # The wrapper resolves the set's other pieces (the .hdr anchor,
            # data2.cab, external files) by name through `reader`, so it gets
            # the reader-native member path, not the display path.
            native = str(reader.get_file_path(entry))
            src = _ArchiveSource(fh, native)
            name = os.path.basename(native.replace("\\", "/"))
            return InstallShieldPathReader(
                InstallShieldCabWrapper(src, name, reader, manager), src, reader
            )
        src = fh if getattr(fh, "name", None) else _ArchiveSource(fh, path)
        return CompressedPathReader(ArchiveWrapper(src, reader, manager), src, reader)
    except Exception as e:  # noqa: BLE001 — any failure means "not an archive we can read"
        logging.getLogger("prism-adapter").debug("could not open %s as archive: %s", path, e)
        if fh is not None:
            _close_handle(fh)
        return None


def _close_handle(fh):
    with contextlib.suppress(Exception):
        fh.__exit__(None, None, None) if hasattr(fh, "__exit__") else fh.close()


def _close_member_archive(child):
    with contextlib.suppress(Exception):
        child.close()
    if child.fp is not None:
        _close_handle(child.fp)


# Ceiling on decompressed bytes read from *nested archive members* across one
# analyze/extract pass. The top-level volume is bounded by its own file size;
# this bounds the amplification a decompression bomb (or a wide archive fan-out)
# can inflict, so a small hostile input can't pin the CPU streaming terabytes.
# Generous by default — real nested archives stay well under it. Env override:
# PRISM_ARCHIVE_BYTE_BUDGET (bytes).
_ARCHIVE_BYTE_BUDGET = 16 * 1024 * 1024 * 1024


def _archive_byte_budget():
    raw = os.environ.get("PRISM_ARCHIVE_BYTE_BUDGET")
    if raw:
        try:
            n = int(raw)
            if n >= 0:
                return n
        except ValueError:
            pass
    return _ARCHIVE_BYTE_BUDGET


class _ByteBudget:
    """Shared, mutable remaining-bytes counter for the nested-archive walk."""

    def __init__(self, remaining):
        self.remaining = remaining

    def take(self, n):
        """Charge `n` bytes; True while the budget still holds."""
        self.remaining -= n
        return self.remaining >= 0

    @property
    def exhausted(self):
        return self.remaining <= 0


def _dir_member_escapes(reader, entry, mods):
    """True when a directory-container member resolves (through a symlink or
    junction) outside the container root. A folder opened as one build must not
    let a member link out to arbitrary host files, whose bytes would otherwise
    be hashed and copied into the served asset store. Only directory readers
    have a host path to escape; archive/ISO readers never do (mods is passed
    only at the top level, where a directory source can appear)."""
    if mods is None or not isinstance(reader, mods["directory"]):
        return False
    try:
        root = os.path.realpath(str(reader.get_root_dir()))
        target = os.path.realpath(str(reader.get_file_path(entry)))
    except Exception:  # noqa: BLE001
        return True  # can't resolve it safely -> treat as an escape
    return os.path.commonpath([root, target]) != root


def _hash_files(reader, manager, mods=None, prefix="", depth=0, budget=None):
    files = []
    if budget is None and depth == 0:
        budget = _ByteBudget(_archive_byte_budget())
    file_list = list(reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=True))
    with manager.counter(total=len(file_list), desc="Hashing files", unit="files") as pbar, \
            manager.counter(total=0, unit="B", file_name="") as hbar:
        for f in file_list:
            path = prefix + _clean_path(reader.get_file_path(f).replace("\\", "/"))
            is_dir = bool(reader.is_directory(f))
            rec = {"path": path, "is_dir": is_dir}
            if _dir_member_escapes(reader, f, mods):
                rec["unreadable"] = True
                files.append(rec)
                pbar.update()
                continue
            if depth:
                rec["in_archive"] = True
            date = None
            try:
                date = reader.get_file_date(f)
            except Exception:  # noqa: BLE001
                pass
            d = _fmt_date(date)
            if d:
                rec["date"] = d
            size = None
            try:
                size = int(reader.get_file_size(f))
                rec["size"] = size
            except Exception:  # noqa: BLE001
                pass

            head = None
            if not is_dir:
                # Members skip the chunk/shingle fingerprints: build-level
                # similarity must keep seeing the archive as one opaque file.
                # Nested members (depth > 0) draw on the shared byte budget.
                head = _hash_one(
                    reader, f, rec, size, hbar,
                    fingerprints=depth == 0,
                    budget=budget if depth > 0 else None,
                )

            files.append(rec)
            if (
                head is not None
                and depth < _ARCHIVE_MAX_DEPTH
                and _looks_like_archive(head)
                and (budget is None or not budget.exhausted)
            ):
                files.extend(_archive_member_files(reader, f, path, manager, depth, head, budget))
            pbar.update()
    return files


def _archive_member_files(reader, entry, path, manager, depth, head=b"", budget=None):
    """Hash an archive member's own members as `<path>/...` records. Best-effort:
    an archive that can't be opened or dies mid-listing just stays a plain file."""
    child = _open_member_archive(reader, entry, path, manager, head)
    if child is None:
        return []
    try:
        return _hash_files(child, manager, prefix=path, depth=depth + 1, budget=budget)
    except Exception as e:  # noqa: BLE001 — passworded/unsupported/corrupt
        logging.getLogger("prism-adapter").warning("archive listing failed for %s: %s", path, e)
        return []
    finally:
        _close_member_archive(child)


def _hash_one(reader, f, rec, size, hbar, fingerprints=True, budget=None):
    """Hash one file into `rec`, returning its leading bytes (for archive
    sniffing), or None when the file was unreadable. When a `budget` is given
    (nested archive members), a member that exhausts it is abandoned as
    unreadable rather than streamed to the end — a decompression-bomb guard."""
    md5 = hashlib.md5(usedforsecurity=False)
    sha1 = hashlib.sha1(usedforsecurity=False)
    sha256 = hashlib.sha256()
    read = 0
    head = b""
    # Content-defined chunks, streamed so even multi-GB files are chunked
    # without buffering them whole.
    chunker = _StreamingChunker() if fingerprints else None
    # Byte-shingle resemblance signature for large files only — the big blobs
    # where scattered small edits matter; tiny files lean on their whole-file hash.
    shingler = (
        _ShingleSignature()
        if fingerprints and size is not None and size >= _SHINGLE_MIN_SIZE
        else None
    )
    hbar.total = float(size or 0)
    hbar.count = 0.0
    hbar.update(incr=0, file_name=os.path.basename(rec["path"]))
    try:
        fh = reader.open_file(f)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            for chunk in iter(lambda: fh.read(65536), b""):
                md5.update(chunk)
                sha1.update(chunk)
                sha256.update(chunk)
                if len(head) < _ARCHIVE_SNIFF_BYTES:
                    head += chunk[: _ARCHIVE_SNIFF_BYTES - len(head)]
                if chunker is not None:
                    chunker.update(chunk)
                if shingler is not None:
                    shingler.update(chunk)
                read += len(chunk)
                hbar.update(len(chunk))
                if budget is not None and not budget.take(len(chunk)):
                    logging.getLogger("prism-adapter").warning(
                        "archive byte budget exhausted; skipping remainder of %s", rec["path"]
                    )
                    rec["unreadable"] = True
                    return None
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception as e:  # noqa: BLE001
        logging.getLogger("prism-adapter").debug("hash failed for %s: %s", rec["path"], e)
        rec["unreadable"] = True
        return None

    if read:
        rec["md5"] = md5.hexdigest()
        rec["sha1"] = sha1.hexdigest()
        rec["sha256"] = sha256.hexdigest()
        if size is not None and read != size:
            rec["unreadable"] = True
        if chunker is not None:
            chunks = chunker.finish()
            if chunks:
                rec["chunks"] = chunks
        if shingler is not None:
            sig = shingler.finish()
            if sig is not None:
                rec["shingle"] = sig
    elif size:
        rec["unreadable"] = True
    return head


def _chunk_pair(data):
    """One content-defined chunk → [blake3_63bit, length] pair."""
    h = int.from_bytes(blake3.blake3(data).digest()[:8], "little") & _HASH63
    return [h, len(data)]


class _StreamingChunker:
    """Feed file bytes incrementally; collect content-defined [hash63, len] chunks
    without ever holding the whole file in memory.

    FastCDC's boundaries are stateless across chunks (the gear pattern resets at each
    cut) and depend only on the <= max_size bytes following a cut. So we buffer, and
    once the buffer holds well over one max-size chunk we run fastcdc and commit every
    chunk *except the last* — the last may extend past the current buffer, so we defer
    it and re-cut it together with the next bytes. The committed stream is therefore
    byte-identical to chunking the whole file at once, but memory stays bounded.
    """

    def __init__(self):
        self._buf = bytearray()
        self.chunks = []

    def update(self, data):
        self._buf.extend(data)
        if len(self._buf) >= _CHUNK_FLUSH:
            self._flush(final=False)

    def finish(self):
        self._flush(final=True)
        return self.chunks

    def _flush(self, final):
        if not self._buf:
            return
        cuts = list(
            fastcdc(bytes(self._buf), min_size=_CDC_MIN, avg_size=_CDC_AVG, max_size=_CDC_MAX, fat=True)
        )
        if not cuts:
            return
        # Defer the trailing chunk unless this is EOF — it may still grow.
        keep = cuts if final else cuts[:-1]
        for c in keep:
            self.chunks.append(_chunk_pair(c.data))
        if final:
            self._buf.clear()
        else:
            tail = cuts[-1].length
            del self._buf[: len(self._buf) - tail]


class _ShingleSignature:
    """Streaming One-Permutation-Hashing resemblance signature over w-byte shingles.

    Slides a w-byte window one byte at a time, hashes each window (Rabin–Karp + an
    avalanche mix), buckets the hashes into K bins by their top bits, and keeps the
    minimum per bin. The K-slot result is MinHash-comparable: the fraction of slots two
    files agree on estimates the Jaccard of their shingle sets — which stays ~1.0 even
    when edits are sprinkled across the file, because each edit only disturbs the ~w
    shingles spanning it.

    Bytes are fed incrementally and processed a buffer at a time (carrying a (w-1)-byte
    tail so every window is hashed exactly once), so even multi-GB files are summarized
    without being held in memory.
    """

    def __init__(self):
        self._sig = np.full(_SHINGLE_K, _HASH63, dtype=_U64)
        self._buf = bytearray()
        self._any = False

    def update(self, data):
        self._buf.extend(data)
        if len(self._buf) >= _SHINGLE_FLUSH:
            self._flush()

    def finish(self):
        self._flush(final=True)
        return [int(x) for x in self._sig] if self._any else None

    def _flush(self, final=False):
        buf = self._buf
        if len(buf) >= _SHINGLE_W:
            arr = np.frombuffer(bytes(buf), dtype=np.uint8).astype(_U64)
            nwin = len(arr) - _SHINGLE_W + 1
            # Horner over the window: h = b0·P^(w-1) + … + b_{w-1}  (mod 2^64).
            h = arr[:nwin].copy()
            for j in range(1, _SHINGLE_W):
                h *= _SHINGLE_POLY
                h += arr[j : j + nwin]
            # Avalanche-mix so overlapping windows decorrelate; keep low 63 bits.
            h ^= h >> _U64(33)
            h *= _U64(0xFF51AFD7ED558CCD)
            h ^= h >> _U64(33)
            h &= _MASK63_NP
            np.minimum.at(self._sig, (h >> _SHINGLE_BINSHIFT).astype(np.intp), h)
            self._any = True
        # Carry the trailing (w-1) bytes — they can't start a full window yet.
        if final:
            buf.clear()
        else:
            del buf[: len(buf) - (_SHINGLE_W - 1)]


def _select_volume(path, basename, parent_dir, mods, manager):
    """Selection pass: enumerate every candidate volume (directory level only — a
    one-pass archive can't seek back to member *content* later) and choose the
    richest. This is what rescues Dreamcast GD-ROMs: the boot game lives in the
    high-density volume, not the first (low-density) one the old "first readable"
    pick returned. A non-zero start sector marks that high-density volume, whose
    files may span several tracks needing .cue/.gdi reassembly."""
    with _source_readers(path, basename, parent_dir, mods, manager) as readers:
        candidates = _enumerate_volumes(readers, mods, manager)
        if not candidates:
            raise SystemExit(f"no readable volume found in {path!r} (unsupported format?)")
        locator, chosen = max(candidates, key=lambda c: _score_volume(c[1]))
        vtype = getattr(chosen, "volume_type", None)
        # Route to GD-ROM assembly whenever ANY high-density volume exists — the
        # Dreamcast boot game always lives there. Keying on the richest volume's start
        # sector (old behaviour) mis-routes discs whose LOW-density area is a fat
        # PC/asset partition (jpg/bmp galleries) that outweighs the few-file boot
        # track: they got streamed from the wrong volume and lost the exe date.
        needs_assembly = any(
            getattr(getattr(r, "fp", None), "starting_sector", 0) for _loc, r in candidates
        )
    return locator, vtype, needs_assembly


def _process(path, basename, parent_dir, mods, manager, work):
    """Select the disc's primary volume, then run `work(processor, reader, system)`
    on it. GD-ROM high-density volumes go through track reassembly; everything else
    reopens straight to its volume. Both analyze and extract funnel through here so
    an extracted asset always comes from the same volume its record describes."""
    locator, vtype, needs_assembly = _select_volume(path, basename, parent_dir, mods, manager)
    if needs_assembly:
        try:
            return _process_gdrom(path, basename, parent_dir, mods, manager, work)
        except _NoHighDensityVolume:
            # Non-standard disc: assembly found nothing. Read the chosen volume plainly.
            pass
    return _process_streaming(path, basename, parent_dir, locator, vtype, mods, manager, work)


def analyze(path):
    mods = _import_ps2exe()
    manager = ProgressManager()

    path = os.path.normpath(path)  # a folder path may arrive with a trailing slash
    basename = os.path.basename(path)
    parent_dir = pathlib.Path(path).resolve().parent

    def work(processor, reader, system):
        info = _gather_info(processor, reader, system, mods)
        files = _hash_files(reader, manager, mods)
        exe_fp = _exe_fp_for(info, reader)
        return info, files, exe_fp, system

    info, files, exe_fp, system = _process(path, basename, parent_dir, mods, manager, work)

    # Audio pass: CDDA scan over the container, on its own fresh pass since processing
    # consumed the stream. Only CD/GD-ROM systems carry red-book audio worth
    # fingerprinting; gating here also avoids the DVD/UMD/Blu-ray/STFS systems whose
    # content packages trip ps2exe's re-iteration bug (ConsumedArchiveEntry).
    media = []
    if system in AUDIO_SYSTEMS:
        with _source_readers(path, basename, parent_dir, mods, manager) as audio_readers:
            media = _scan_audio_tracks(audio_readers, mods, manager)

    return {"info": info, "files": files, "media": media, "exe_fp": exe_fp}


def extract(path, out_dir):
    """Copy the image's browser-viewable files (see viewable.py) into the
    content-addressed store at `out_dir`, returning their metadata. Runs on the
    same volume analyze() chooses, so asset paths match the record's contents."""
    mods = _import_ps2exe()
    manager = ProgressManager()

    path = os.path.normpath(path)  # a folder path may arrive with a trailing slash
    basename = os.path.basename(path)
    parent_dir = pathlib.Path(path).resolve().parent

    def work(processor, reader, system):
        return _extract_assets(reader, out_dir, manager, mods)

    return {"assets": _process(path, basename, parent_dir, mods, manager, work)}


def _extract_assets(reader, out_dir, manager, mods=None, prefix="", depth=0):
    from . import viewable

    # Candidate list first, bytes second — the same two-step the hashing pass
    # uses, so one-pass archive streams see opens in iterator order only.
    # Every non-empty file is a candidate: viewable types ship whole, everything
    # else (unknown extension, oversized, sniff mismatch below) ships as a raw
    # head snippet the UIs render as a hex view. Archive members are candidates
    # too, extracted through the same recursion as the hashing pass.
    entries = []
    for f in reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=False):
        if _dir_member_escapes(reader, f, mods):
            continue  # symlink out of a folder source: never serve its target's bytes
        path = prefix + _clean_path(reader.get_file_path(f).replace("\\", "/"))
        try:
            size = int(reader.get_file_size(f))
        except Exception:  # noqa: BLE001
            size = None
        if size == 0:
            continue
        classified = viewable.classify(path)
        if classified is not None and size is not None and size > viewable.max_size(classified[0]):
            classified = None  # too big to serve whole — keep the head snippet only
        entries.append((f, path, size, classified))

    out = []
    with manager.counter(total=len(entries), desc="Extracting assets", unit="files") as pbar:
        for f, path, size, classified in entries:
            if classified is None:
                head = _read_head(reader, f, viewable.SNIPPET_BYTES)
                asset = (head, viewable.SNIPPET_MIME, viewable.SNIPPET_KIND) if head else None
                if head and depth < _ARCHIVE_MAX_DEPTH and _looks_like_archive(head):
                    out.extend(_archive_member_assets(reader, f, path, out_dir, manager, depth, head))
            else:
                kind, mime = classified
                if size is not None and size > viewable.MAX_ASSET_SIZE:
                    # Too big to buffer (a large video — max_size() demoted every
                    # other kind above): stream it into the store while hashing.
                    streamed = _stream_to_store(reader, f, out_dir, mime, viewable.max_size(kind))
                    if streamed is not None and streamed[0] == "stored":
                        _, sha, n = streamed
                        out.append({"path": path, "sha256": sha, "size": n, "mime": mime, "kind": kind})
                        pbar.update()
                        continue
                    if streamed is not None:  # ("mismatch", head)
                        asset = (streamed[1][: viewable.SNIPPET_BYTES], viewable.SNIPPET_MIME, viewable.SNIPPET_KIND)
                    else:
                        asset = None
                else:
                    data = _read_capped(reader, f, viewable.MAX_ASSET_SIZE)
                    resolved = viewable.resolve(data[: viewable.SNIFF_BYTES], kind, mime) if data else None
                    if resolved is not None:
                        kind, mime = resolved
                        asset = (data, mime, kind)
                    elif data:
                        # Extension claimed a viewable type but the bytes disagree —
                        # keep the head snippet, same as any unidentified file.
                        asset = (data[: viewable.SNIPPET_BYTES], viewable.SNIPPET_MIME, viewable.SNIPPET_KIND)
                    else:
                        asset = None
            pbar.update()
            if asset is None:
                continue
            data, mime, kind = asset
            sha = hashlib.sha256(data).hexdigest()
            _store_blob(out_dir, sha, data)
            out.append({"path": path, "sha256": sha, "size": len(data), "mime": mime, "kind": kind})
    return out


def _archive_member_assets(reader, entry, path, out_dir, manager, depth, head=b""):
    """Extract an archive member's own members as `<path>/...` assets.
    Best-effort, like the listing pass."""
    child = _open_member_archive(reader, entry, path, manager, head)
    if child is None:
        return []
    try:
        return _extract_assets(child, out_dir, manager, prefix=path, depth=depth + 1)
    except Exception as e:  # noqa: BLE001 — passworded/unsupported/corrupt
        logging.getLogger("prism-adapter").warning("archive extraction failed for %s: %s", path, e)
        return []
    finally:
        _close_member_archive(child)


def _read_capped(reader, f, cap):
    """The file's bytes, or None when unreadable or larger than `cap` (a size
    the directory record understated must not smuggle an oversized asset in)."""
    buf = bytearray()
    try:
        fh = reader.open_file(f)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            while chunk := fh.read(65536):
                buf.extend(chunk)
                if len(buf) > cap:
                    return None
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception as e:  # noqa: BLE001
        logging.getLogger("prism-adapter").debug("asset read failed: %s", e)
        return None
    return bytes(buf)


def _stream_to_store(reader, f, out_dir, mime, cap):
    """Stream a large classified file into the store without buffering it:
    sniff the head, then hash while spooling to a temp file renamed into its
    content address. Returns ("stored", sha256, size); ("mismatch", head) when
    the leading bytes disagree with the claimed mime; or None when the file is
    unreadable or overruns `cap` (a size the directory record understated must
    not smuggle an oversized asset in)."""
    from . import viewable

    tmp = os.path.join(out_dir, f".stream{os.getpid()}.{os.urandom(4).hex()}.part")
    digest = hashlib.sha256()
    size = 0
    try:
        fh = reader.open_file(f)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            head = fh.read(viewable.SNIFF_BYTES)
            if not head:
                return None
            if not viewable.sniff(head, mime):
                return ("mismatch", head)
            os.makedirs(out_dir, exist_ok=True)
            with open(tmp, "wb") as spool:
                chunk = head
                while chunk:
                    size += len(chunk)
                    if size > cap:
                        return None
                    digest.update(chunk)
                    spool.write(chunk)
                    chunk = fh.read(1 << 20)
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
        sha = digest.hexdigest()
        final = os.path.join(out_dir, sha[:2], sha)
        if not os.path.exists(final):
            os.makedirs(os.path.dirname(final), exist_ok=True)
            os.replace(tmp, final)
        return ("stored", sha, size)
    except Exception as e:  # noqa: BLE001
        logging.getLogger("prism-adapter").debug("asset stream failed: %s", e)
        return None
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp)


def _read_head(reader, f, n):
    """The file's first `n` bytes (the whole file when shorter), or None when
    unreadable or empty."""
    buf = bytearray()
    try:
        fh = reader.open_file(f)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            while len(buf) < n and (chunk := fh.read(min(65536, n - len(buf)))):
                buf.extend(chunk)
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception as e:  # noqa: BLE001
        logging.getLogger("prism-adapter").debug("asset head read failed: %s", e)
        return None
    return bytes(buf) if buf else None


def _store_blob(out_dir, sha, data):
    """Write `data` as `<out_dir>/<sha[:2]>/<sha>`, atomically, once."""
    final = os.path.join(out_dir, sha[:2], sha)
    if os.path.exists(final):
        return
    os.makedirs(os.path.dirname(final), exist_ok=True)
    tmp = f"{final}.tmp{os.getpid()}.{os.urandom(4).hex()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, final)


# A real boot executable is small; anything past this is either not a boot exe
# or a hostile/decompression-bombed member. Cap the read so it can't buffer a
# multi-GB member into memory (read cap+1 to detect the overrun).
_EXE_FP_MAX_BYTES = 128 * 1024 * 1024


def _exe_fingerprint(reader, exe_path):
    """Boot-exe fingerprint: TLSH (any bytes) + imphash (PE only)."""
    import tlsh

    target = None
    for f in reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=False):
        if _clean_path(reader.get_file_path(f)) == exe_path:
            target = f
            break
    if target is None:
        return None
    try:
        fh = reader.open_file(target)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            data = fh.read(_EXE_FP_MAX_BYTES + 1)
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception:  # noqa: BLE001
        return None

    if not data or len(data) < 256:
        return None
    if len(data) > _EXE_FP_MAX_BYTES:
        logging.getLogger("prism-adapter").debug(
            "boot exe %s exceeds %d bytes; skipping fingerprint", exe_path, _EXE_FP_MAX_BYTES
        )
        return None

    th = tlsh.hash(data)
    if th in ("", "TNULL"):
        th = None

    imphash = None
    if data[:2] == b"MZ":  # PE
        try:
            import pefile

            pe = pefile.PE(data=data, fast_load=True)
            pe.parse_data_directories(
                directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]]
            )
            imphash = pe.get_imphash() or None
        except Exception:  # noqa: BLE001
            imphash = None

    if not th and not imphash:
        return None
    return {"tlsh": th, "imphash": imphash}


# CD/GD-ROM systems whose dumps can carry red-book (CDDA) audio tracks. Other
# detected systems are DVD/UMD/Blu-ray/digital (no CDDA), so the audio scan is
# skipped for them — see analyze(). ps2exe system ids; ps2 is deliberately out
# (DVD-era, CDDA vanishingly rare, and its content packages trip the scan bug).
AUDIO_SYSTEMS = frozenset({"megacd", "saturn", "ps1", "3do", "cdi", "cd32", "dreamcast"})


def _scan_audio_tracks(readers, mods, manager):
    """Fingerprint raw CDDA audio tracks in an archive or folder container.

    Two layouts: a single combined .bin described by a .cue (Redump), or one .bin per
    track sitting beside the data track."""
    media = []
    containers = [r for r in readers if _is_container(r, mods)]
    for r in containers:
        cue_media = _scan_cue_audio(r)
        if cue_media is not None:
            media.extend(cue_media)
        else:
            media.extend(_scan_member_audio(r, mods))
    return media


# A cue sheet describes track layout in plain text — kilobytes at most.
_CUE_MAX_BYTES = 1 * 1024 * 1024


def _read_entry(reader, entry, length=None):
    fh = reader.open_file(entry)
    is_ctx = hasattr(fh, "__enter__")
    if is_ctx:
        fh.__enter__()
    try:
        return fh.read() if length is None else fh.read(length)
    finally:
        with contextlib.suppress(Exception):
            fh.__exit__(None, None, None) if is_ctx else fh.close()


_NATURAL_SPLIT = re.compile(r"(\d+)")


def _natural_key(s):
    """Sort key comparing embedded digit runs by value ("Track 2" < "Track 10")."""
    return [int(p) if p.isdigit() else p.lower() for p in _NATURAL_SPLIT.split(s)]


def _scan_member_audio(r, mods):
    """Per-member: separate raw-CDDA .bin tracks beside the data track."""
    from . import audio

    entries = r.iso_iterator(r.get_root_dir(), recursive=True, include_dirs=False)
    if isinstance(r, mods["directory"]):
        # Directory members come back in filesystem glob order; sort into track
        # order so media output is deterministic. (Archives keep iteration order —
        # a one-pass stream must be read in sequence.)
        entries = sorted(entries, key=lambda e: _natural_key(_member_path(r, e, mods)))

    out = []
    for entry in entries:
        if _dir_member_escapes(r, entry, mods):
            continue  # don't read a member symlinked out of the folder source
        path = _member_path(r, entry, mods)
        try:
            size = int(r.get_file_size(entry))
        except Exception:  # noqa: BLE001
            continue
        try:
            fh = r.open_file(entry)
            is_ctx = hasattr(fh, "__enter__")
            if is_ctx:
                fh.__enter__()
            try:
                head = fh.read(16)
                if not audio.is_audio_track(head, size):
                    continue
                raw = head + fh.read(audio.MAX_FP_BYTES - 16)
            finally:
                with contextlib.suppress(Exception):
                    fh.__exit__(None, None, None) if is_ctx else fh.close()
        except Exception as e:  # noqa: BLE001
            logging.getLogger("prism-adapter").debug("audio read failed for %s: %s", path, e)
            continue
        fp = audio.fingerprint_pcm(raw)
        if fp:
            out.append({"path": _clean_path(path), "kind": "audio", "audio_fp": fp})
    return out


def _scan_cue_audio(r):
    """Single combined .bin + .cue: split audio tracks by cue offsets and fingerprint.

    Returns None (not a single-bin+cue layout) so the caller can fall back."""
    from . import audio

    cue_text = None
    bins = {}
    for entry in r.iso_iterator(r.get_root_dir(), recursive=True, include_dirs=False):
        base = os.path.basename(r.get_file_path(entry))
        low = base.lower()
        if low.endswith(".cue"):
            try:
                # A real cue sheet is a few KB; cap the read so a member merely
                # named `*.cue` can't buffer gigabytes into memory.
                cue_text = _read_entry(r, entry, _CUE_MAX_BYTES).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                return None
        elif low.endswith(".bin"):
            bins[base.lower()] = entry

    if not cue_text:
        return None
    files = audio.parse_cue(cue_text)
    if len(files) != 1:
        return None  # per-track files -> member scan handles it

    spec = files[0]
    bin_entry = bins.get(os.path.basename(spec["file"]).lower())
    if bin_entry is None and len(bins) == 1:
        bin_entry = next(iter(bins.values()))
    if bin_entry is None:
        return None

    tracks = spec["tracks"]
    out = []
    for i, t in enumerate(tracks):
        if t["type"] != "AUDIO" or t["start_frame"] is None:
            continue
        start = t["start_frame"]
        nxt = tracks[i + 1]["start_frame"] if i + 1 < len(tracks) else None
        length = (nxt - start) * audio.SECTOR if nxt else audio.MAX_FP_BYTES
        if length <= 0:  # malformed cue with non-monotonic INDEX
            length = audio.MAX_FP_BYTES
        fh = r.open_file(bin_entry)
        is_ctx = hasattr(fh, "__enter__")
        if is_ctx:
            fh.__enter__()
        try:
            fh.seek(start * audio.SECTOR)
            raw = fh.read(min(length, audio.MAX_FP_BYTES))
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
        fp = audio.fingerprint_pcm(raw)
        if fp:
            out.append(
                {"path": f"{_clean_path(spec['file'])}#{t['num']:02d}", "kind": "audio", "audio_fp": fp}
            )
    return out


def main():
    parser = argparse.ArgumentParser(prog="prism-adapter")
    sub = parser.add_subparsers(dest="command", required=True)
    p_an = sub.add_parser("analyze", help="analyze a disc image/container/folder")
    p_an.add_argument("--path", required=True)
    p_ex = sub.add_parser("extract", help="extract browser-viewable assets into a store")
    p_ex.add_argument("--path", required=True)
    p_ex.add_argument("--out", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    # Force any ps2exe stdout chatter to stderr; stdout is reserved for the result.
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        if args.command == "analyze":
            result = analyze(args.path)
        else:
            result = extract(args.path, args.out)
    finally:
        sys.stdout = real_stdout
    json.dump(result, real_stdout)
    real_stdout.write("\n")
    real_stdout.flush()


if __name__ == "__main__":
    main()
