"""Analyze a disc image/container with ps2exe and emit canonical-raw JSON on stdout.

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
_PS2EXE_DIR = pathlib.Path(os.environ.get("CURATOR_PS2EXE_DIR", _DEFAULT_PS2EXE))


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


def _clean_component(c):
    return _VERSION_SUFFIX.sub("", c)


def _clean_path(p):
    parts = [_clean_component(c) for c in p.strip("/").split("/") if c]
    return "/" + "/".join(parts)


# Fixed-width disc-header fields are NUL/garbage-padded: ps2exe decodes the
# whole field, so trailing (or embedded) control bytes ride along. Strip C0
# controls and DEL — they carry no meaning here and a literal NUL cannot even
# be stored in the downstream Postgres jsonb/text columns.
_CONTROL_CHARS = {c: None for c in range(0x20)}
_CONTROL_CHARS[0x7F] = None


def _nullify(v):
    if isinstance(v, str):
        v = v.translate(_CONTROL_CHARS).strip()
        return v or None
    return v


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
        logging.getLogger("curator-adapter").warning("metadata step failed: %s", e)
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


def _enumerate_volumes(fp, basename, parent, mods, manager):
    """Every leaf filesystem volume reachable from `fp`, paired with the list of
    archive-member names ('locator') needed to re-reach it (empty = top level).

    Reading member *directories* in a single archive pass is fine; reading member
    *content* is not, on a one-pass stream. So callers select a volume here, then
    reopen it via `_open_volume` to actually read bytes."""
    factory = mods["factory"]
    readers, _exc = factory.get_iso_path_readers(fp, basename, parent, manager)
    found = []

    def walk(reader, locator, depth):
        if not isinstance(reader, mods["compressed"]):
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


def _open_volume(fp, basename, parent, locator, vtype, mods, manager):
    """Reopen the volume identified by (`locator`, `vtype`) on a fresh `fp`, opening
    *only* the members along `locator`. Touching sibling members first would strand
    a Dreamcast high-density track's content on a single-pass archive stream."""
    factory = mods["factory"]
    readers, _exc = factory.get_iso_path_readers(fp, basename, parent, manager)

    def pick(candidates):
        if not candidates:
            return None
        match = [r for r in candidates if getattr(r, "volume_type", None) == vtype]
        return (match or candidates)[0]

    if not locator:
        fs = [r for r in readers if not isinstance(r, mods["compressed"])]
        return pick(fs or readers)

    current = readers
    for name in locator:
        container = next((r for r in current if isinstance(r, mods["compressed"])), None)
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


def _process_streaming(path, basename, parent_dir, locator, vtype, mods, manager):
    """Fingerprint the already-chosen volume by reopening straight to it. Used for
    every disc whose game lives in a single self-contained volume (PS1/2/3, Saturn,
    Mega CD, 3DO, combined Dreamcast images, …)."""
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    with open(path, "rb") as fp:
        parent = mods["directory"](parent_dir)
        reader = _open_volume(fp, basename, parent, locator, vtype, mods, manager)
        if reader is None:
            raise SystemExit(f"could not reopen chosen volume in {path!r}")
        system = base.get_system_type(reader) or "unknown"
        processor_class = factory.get_iso_processor_class(system) or generic
        processor = _safe_processor(processor_class, reader, basename, system, manager, mods)
        info = _gather_info(processor, reader, system, mods)
        files = _hash_files(reader, manager)
        exe_fp = _exe_fp_for(info, reader)
    return info, files, exe_fp, system


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


def _process_gdrom(path, basename, parent_dir, mods, manager):
    """Fingerprint a Dreamcast GD-ROM whose game spans the high-density area.

    The boot volume's files can straddle several tracks, so we let the Dreamcast
    processor reassemble the image from the .cue/.gdi. That assembly reopens sibling
    tracks, which a single-pass archive only permits while we are still on the
    triggering member — so the processor must be built in the same pass that opens
    the high-density track (no prior enumeration of this stream). The reassembled
    reader is seekable (its tracks are mmapped), so we rank candidates by file count
    and hash only the richest."""
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    with open(path, "rb") as fp:
        parent = mods["directory"](parent_dir)
        readers, _exc = factory.get_iso_path_readers(fp, basename, parent, manager)
        container = next((r for r in readers if isinstance(r, mods["compressed"])), None)
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
        info = _gather_info(processor, reader, system, mods)
        files = _hash_files(reader, manager)
        exe_fp = _exe_fp_for(info, reader)
    return info, files, exe_fp, system


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


def _hash_files(reader, manager):
    files = []
    file_list = list(reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=True))
    with manager.counter(total=len(file_list), desc="Hashing files", unit="files") as pbar, \
            manager.counter(total=0, unit="B", file_name="") as hbar:
        for f in file_list:
            path = reader.get_file_path(f)
            is_dir = bool(reader.is_directory(f))
            rec = {"path": _clean_path(path), "is_dir": is_dir}
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

            if not is_dir:
                _hash_one(reader, f, rec, size, hbar)

            files.append(rec)
            pbar.update()
    return files


def _hash_one(reader, f, rec, size, hbar):
    md5 = hashlib.md5(usedforsecurity=False)
    sha1 = hashlib.sha1(usedforsecurity=False)
    sha256 = hashlib.sha256()
    read = 0
    # Content-defined chunks, streamed so even multi-GB files are chunked
    # without buffering them whole.
    chunker = _StreamingChunker()
    # Byte-shingle resemblance signature for large files only — the big blobs
    # where scattered small edits matter; tiny files lean on their whole-file hash.
    shingler = _ShingleSignature() if size is not None and size >= _SHINGLE_MIN_SIZE else None
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
                chunker.update(chunk)
                if shingler is not None:
                    shingler.update(chunk)
                read += len(chunk)
                hbar.update(len(chunk))
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception as e:  # noqa: BLE001
        logging.getLogger("curator-adapter").debug("hash failed for %s: %s", rec["path"], e)
        rec["unreadable"] = True
        return

    if read:
        rec["md5"] = md5.hexdigest()
        rec["sha1"] = sha1.hexdigest()
        rec["sha256"] = sha256.hexdigest()
        if size is not None and read != size:
            rec["unreadable"] = True
        chunks = chunker.finish()
        if chunks:
            rec["chunks"] = chunks
        if shingler is not None:
            sig = shingler.finish()
            if sig is not None:
                rec["shingle"] = sig
    elif size:
        rec["unreadable"] = True


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


def analyze(path):
    mods = _import_ps2exe()
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    manager = ProgressManager()

    basename = os.path.basename(path)
    parent_dir = pathlib.Path(path).resolve().parent

    # Selection pass: enumerate every candidate volume (directory level only — a
    # one-pass archive can't seek back to member *content* later) and choose the
    # richest. This is what rescues Dreamcast GD-ROMs: the boot game lives in the
    # high-density volume, not the first (low-density) one the old "first readable"
    # pick returned. A non-zero start sector marks that high-density volume, whose
    # files may span several tracks needing .cue/.gdi reassembly.
    with open(path, "rb") as fp:
        parent = mods["directory"](parent_dir)
        candidates = _enumerate_volumes(fp, basename, parent, mods, manager)
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

    # Processing pass: read the chosen volume's bytes. GD-ROM high-density volumes go
    # through track reassembly; everything else reopens straight to its volume.
    if needs_assembly:
        try:
            info, files, exe_fp, system = _process_gdrom(path, basename, parent_dir, mods, manager)
        except _NoHighDensityVolume:
            # Non-standard disc: assembly found nothing. Read the chosen volume plainly.
            info, files, exe_fp, system = _process_streaming(
                path, basename, parent_dir, locator, vtype, mods, manager
            )
    else:
        info, files, exe_fp, system = _process_streaming(
            path, basename, parent_dir, locator, vtype, mods, manager
        )

    # Audio pass: CDDA scan over the container, on its own fresh pass since processing
    # consumed the stream. Only CD/GD-ROM systems carry red-book audio worth
    # fingerprinting; gating here also avoids the DVD/UMD/Blu-ray/STFS systems whose
    # content packages trip ps2exe's re-iteration bug (ConsumedArchiveEntry).
    media = []
    if system in AUDIO_SYSTEMS:
        with open(path, "rb") as fp:
            parent = mods["directory"](parent_dir)
            audio_readers, _exc = factory.get_iso_path_readers(fp, basename, parent, manager)
            media = _scan_audio_tracks(audio_readers, mods, manager)

    return {"info": info, "files": files, "media": media, "exe_fp": exe_fp}


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
            data = fh.read()
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception:  # noqa: BLE001
        return None

    if not data or len(data) < 256:
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
    """Fingerprint raw CDDA audio tracks.

    Two layouts: a single combined .bin described by a .cue (Redump), or one .bin per
    track sitting beside the data track."""
    media = []
    containers = [r for r in readers if isinstance(r, mods["compressed"])]
    for r in containers:
        cue_media = _scan_cue_audio(r)
        if cue_media is not None:
            media.extend(cue_media)
        else:
            media.extend(_scan_member_audio(r))
    return media


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


def _scan_member_audio(r):
    """Per-member: separate raw-CDDA .bin tracks beside the data track."""
    from . import audio

    out = []
    for entry in r.iso_iterator(r.get_root_dir(), recursive=True, include_dirs=False):
        path = r.get_file_path(entry)
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
            logging.getLogger("curator-adapter").debug("audio read failed for %s: %s", path, e)
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
                cue_text = _read_entry(r, entry).decode("utf-8", "replace")
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
    parser = argparse.ArgumentParser(prog="curator-adapter")
    sub = parser.add_subparsers(dest="command", required=True)
    p_an = sub.add_parser("analyze", help="analyze a disc image/container")
    p_an.add_argument("--path", required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    if args.command == "analyze":
        # Force any ps2exe stdout chatter to stderr; stdout is reserved for the result.
        real_stdout = sys.stdout
        sys.stdout = sys.stderr
        try:
            result = analyze(args.path)
        finally:
            sys.stdout = real_stdout
        json.dump(result, real_stdout)
        real_stdout.write("\n")
        real_stdout.flush()


if __name__ == "__main__":
    main()
