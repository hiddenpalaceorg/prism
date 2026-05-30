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
from fastcdc import fastcdc

from .progress import ProgressManager

# FastCDC parameters — part of fingerprint_profile "v1". Changing these is a re-scan.
_CDC_MIN = 16 * 1024
_CDC_AVG = 64 * 1024
_CDC_MAX = 256 * 1024
# Only chunk files we can buffer in memory; larger files are whole-file hashed only.
_CHUNK_CAP = 256 * 1024 * 1024
_HASH63 = (1 << 63) - 1

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


def _nullify(v):
    if isinstance(v, str):
        v = v.strip()
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


def _choose_primary(readers):
    return max(readers, key=lambda r: _VOLUME_PRIORITY.get(getattr(r, "volume_type", ""), 0))


def _find_filesystem_reader(reader, mods, manager, depth=0):
    """Return a non-archive (filesystem) reader, descending into archives if needed."""
    if not isinstance(reader, mods["compressed"]):
        return reader
    if depth > 4:
        return None
    factory = mods["factory"]
    for entry in reader.iso_iterator(reader.get_root_dir(), recursive=True, include_dirs=False):
        name = os.path.basename(reader.get_file_path(entry))
        try:
            fh = reader.open_file(entry)
            if hasattr(fh, "__enter__"):
                fh.__enter__()
        except Exception:  # noqa: BLE001
            continue
        try:
            sub_readers, _exc = factory.get_iso_path_readers(fh, name, reader, manager)
        except Exception:  # noqa: BLE001
            sub_readers = []
        for sr in sub_readers:
            leaf = _find_filesystem_reader(sr, mods, manager, depth + 1)
            if leaf is not None:
                return leaf
    return None


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
    }
    exe_out = None
    if _nullify(exe.get("exe_filename")):
        exe_out = {
            "filename": _clean_path(exe["exe_filename"]),
            "date": _fmt_date(exe.get("exe_date")),
        }
    return {
        "system": system,
        "system_identifier": _nullify(pvd.get("system_identifier")),
        "header": header,
        "volume": volume,
        "exe": exe_out,
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
    md5, sha1, sha256 = hashlib.md5(), hashlib.sha1(), hashlib.sha256()
    read = 0
    # Buffer the file for content-defined chunking when it fits; otherwise hash only.
    buffer_it = size is not None and size <= _CHUNK_CAP
    buf = bytearray() if buffer_it else None
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
                if buf is not None:
                    buf.extend(chunk)
                read += len(chunk)
                hbar.update(len(chunk))
        finally:
            with contextlib.suppress(Exception):
                fh.__exit__(None, None, None) if is_ctx else fh.close()
    except Exception:  # noqa: BLE001
        rec["unreadable"] = True
        return

    if read:
        rec["md5"] = md5.hexdigest()
        rec["sha1"] = sha1.hexdigest()
        rec["sha256"] = sha256.hexdigest()
        if size is not None and read != size:
            rec["unreadable"] = True
        if buf is not None and read:
            rec["chunks"] = _chunk(bytes(buf))
    elif size:
        rec["unreadable"] = True


def _chunk(data):
    """Content-defined chunks as [blake3_63bit, length] pairs (Tier-3 fingerprint)."""
    out = []
    for c in fastcdc(data, min_size=_CDC_MIN, avg_size=_CDC_AVG, max_size=_CDC_MAX, fat=True):
        h = int.from_bytes(blake3.blake3(c.data).digest()[:8], "little") & _HASH63
        out.append([h, c.length])
    return out


def analyze(path):
    mods = _import_ps2exe()
    factory, base, generic = mods["factory"], mods["base"], mods["generic"]
    manager = ProgressManager()

    basename = os.path.basename(path)
    fp = open(path, "rb")
    parent = mods["directory"](pathlib.Path(path).resolve().parent)

    readers, _exc = factory.get_iso_path_readers(fp, basename, parent, manager)
    if not readers:
        raise SystemExit(f"no readable volume found in {path!r} (unsupported format?)")

    fs_readers = [r for r in readers if not isinstance(r, mods["compressed"])]
    if fs_readers:
        reader = _choose_primary(fs_readers)
    else:
        reader = None
        for r in readers:
            reader = _find_filesystem_reader(r, mods, manager)
            if reader is not None:
                break
        if reader is None:
            reader = _choose_primary(readers)

    system = base.get_system_type(reader)
    processor_class = factory.get_iso_processor_class(system) or generic
    processor = processor_class(reader, basename, system, manager)

    info = _gather_info(processor, reader, system, mods)
    files = _hash_files(reader, manager)
    return {"info": info, "files": files}


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
