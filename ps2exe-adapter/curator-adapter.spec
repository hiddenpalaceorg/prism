# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec: freeze the curator adapter into one self-contained binary.
#   pyinstaller curator-adapter.spec        (run from ps2exe-adapter/)
# Replaces the old bundle.py (which copied a whole CPython tree + ran get-pip):
# this is ~60 MB vs ~180 MB, needs no network bootstrap, and is a single file the
# GUIs invoke directly (adapter/curator-adapter[.exe]).
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_all

here = Path(SPECPATH)
ps2exe = (here.parent / "lib" / "ps2exe").resolve()

# ps2exe's modules are top-level (common/, cdi/, dreamcast/, ...). Its factory imports
# every console handler statically, so collecting these packages freezes them all.
ps2exe_pkgs = [
    "common", "cdi", "dreamcast", "gamecube", "p3do", "cd32", "pc", "ps3",
    "psx", "psp", "saturn", "megacd", "wii", "xbox", "utils", "post_psx", "lzxd",
]
hiddenimports = ["patches", "iso_accessor", "dates", "exceptions", "iso_dir"]
for pkg in ps2exe_pkgs:
    hiddenimports += collect_submodules(pkg)

datas, binaries = [], []
for dep in ("pycdlib", "pyisotools"):
    d, b, h = collect_all(dep)
    datas += d
    binaries += b
    hiddenimports += h

# ps2exe (utils/archives.py) loads libarchive from <ps2exe>/lib/libarchive/<os>/ via the
# LIBARCHIVE env var when `import libarchive` can't find a system copy. When frozen,
# __file__ resolves under sys._MEIPASS, so placing the lib at the same relative path lets
# that logic find it. macOS is deliberately excluded: it ships a native libarchive that
# libarchive-c finds via find_library('archive'), and the vendored macosx dylib is
# x86_64-only — bundling it would force a load that fails on Apple Silicon (arm64).
_osdir = {"win32": "win64", "linux": "linux"}.get(sys.platform)
if _osdir:
    # Bundle the whole dir, not just libarchive.* — it ships the sibling libraries
    # (libcrypto, liblzma, libzstd, libbz2, …) that libarchive dlopen's at load time.
    # rthook_libarchive.py then points $LIBARCHIVE at the main lib in this dir.
    _libdir = ps2exe / "lib" / "libarchive" / _osdir
    for _f in sorted(_libdir.glob("*")):
        if _f.is_file():
            binaries.append((str(_f), f"lib/libarchive/{_osdir}"))

# rarfile (utils/archives.py) shells out to a bundled UnRAR tool when no system
# 7-Zip/unrar is found, via lib/unrar/<bitness>/UnRAR.exe at the same _MEIPASS-relative
# path. Only Windows ships a bundled tool (win64, matching our 64-bit builds); off-Windows
# rarfile finds a system tool. Added as data (an invoked exe, not a linked library).
if sys.platform == "win32":
    _unrar = ps2exe / "lib" / "unrar" / "win64"
    for _f in sorted(_unrar.glob("*")):
        if _f.is_file():
            datas.append((str(_f), "lib/unrar/win64"))

a = Analysis(
    ["pyinstaller_entry.py"],
    pathex=[str(here), str(ps2exe)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    # Set $LIBARCHIVE to the bundled lib before the first import. ps2exe's lazy
    # fallback (catch TypeError, set env, retry) breaks when frozen because the
    # bootloader's ctypes hook re-raises that TypeError as PyInstallerImportError.
    runtime_hooks=["rthook_libarchive.py"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="curator-adapter",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
)
