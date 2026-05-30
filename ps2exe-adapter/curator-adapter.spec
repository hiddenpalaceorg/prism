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
# that logic find it. macOS finds the system libarchive, so this only matters off-mac.
_osdir = {"win32": "win64", "darwin": "macosx", "linux": "linux"}.get(sys.platform)
_oslib = {"win32": "libarchive.dll", "darwin": "libarchive.dylib", "linux": "libarchive.so"}.get(sys.platform)
if _osdir:
    _src = ps2exe / "lib" / "libarchive" / _osdir / _oslib
    if _src.exists():
        binaries.append((str(_src), f"lib/libarchive/{_osdir}"))

a = Analysis(
    ["pyinstaller_entry.py"],
    pathex=[str(here), str(ps2exe)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
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
