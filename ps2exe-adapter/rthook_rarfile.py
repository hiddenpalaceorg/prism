# PyInstaller runtime hook: let rarfile fall back to the system bsdtar on macOS.
#
# ps2exe (utils/archives.py) eagerly runs, at import time:
#     rarfile.tool_setup(sevenzip=True, sevenzip2=True, unrar=True, unar=False, bsdtar=False)
# which demands a system 7-Zip/unrar on PATH. Its except handler points rarfile at a
# bundled UnRAR for Windows/Linux but has NO macOS branch, so it just re-runs the same
# call. On a frozen Curator.app — where no Homebrew 7z/unrar is on PATH — both calls
# raise rarfile.RarCannotExec and the adapter dies at import, before any RAR is touched.
#
# RAR extraction itself doesn't need that external tool: the primary path decodes RARs
# through libarchive (macOS ships a system libarchive with rar/rar5 read support), the
# same way the bundled libarchive.dll handles them on Windows. rarfile's tool is only the
# recovery fallback for archives libarchive can't decode. So we just stop the eager setup
# from crashing: when the strict call finds nothing, retry permissively so /usr/bin/bsdtar
# — always present on macOS, linking that same libarchive — satisfies it.
import sys

if hasattr(sys, "_MEIPASS") and sys.platform == "darwin":
    import rarfile

    _orig_tool_setup = rarfile.tool_setup

    def _tool_setup(*args, **kwargs):
        try:
            return _orig_tool_setup(*args, **kwargs)
        except rarfile.RarCannotExec:
            # The strict call (bsdtar disabled) found no tool. Retry with rarfile's
            # permissive defaults so system bsdtar qualifies; force=True bypasses the
            # negative cache left by the failed call above.
            return _orig_tool_setup(force=True)

    rarfile.tool_setup = _tool_setup
