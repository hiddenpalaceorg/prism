# PyInstaller runtime hook: point libarchive-c at the bundled libarchive before
# anything imports it.
#
# ps2exe (utils/archives.py) normally discovers the bundled libarchive lazily: it
# does `try: import libarchive except TypeError:` and, on the TypeError that
# libarchive-c's ffi.py raises when `ctypes.cdll.LoadLibrary(None)` is called with
# no library found, sets $LIBARCHIVE and retries. That works unfrozen — but in a
# PyInstaller build the bootloader's ctypes hook (pyimod03_ctypes) wraps CDLL and
# re-raises that TypeError as a PyInstallerImportError (an OSError subclass). The
# `except TypeError` no longer matches, so the env var is never set and the adapter
# crashes at startup with "argument of type 'NoneType' is not iterable".
#
# Setting $LIBARCHIVE here, before the first import, makes the load deterministic and
# sidesteps the swallowed-exception dance entirely. The spec bundles the matching DLL
# at lib/libarchive/<osdir>/ under sys._MEIPASS.
import os
import sys

# macOS is intentionally absent: it ships a native libarchive that libarchive-c loads via
# find_library('archive'), so no env var is needed — and the spec doesn't bundle one there
# (the vendored macosx dylib is x86_64-only and would crash on Apple Silicon).
if hasattr(sys, "_MEIPASS") and not os.environ.get("LIBARCHIVE"):
    if sys.platform == "win32":
        _osdir = "win64" if sys.maxsize > 2**32 else "win32"
        _oslib = "libarchive.dll"
    elif sys.platform == "linux":
        _osdir, _oslib = "linux", "libarchive.so"
    else:
        _osdir = _oslib = None
    if _osdir:
        _path = os.path.join(sys._MEIPASS, "lib", "libarchive", _osdir, _oslib)
        if os.path.exists(_path):
            os.environ["LIBARCHIVE"] = _path
