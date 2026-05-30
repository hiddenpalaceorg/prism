#!/usr/bin/env python3
"""Build a self-contained adapter bundle for the current OS.

Produces dist/bundle/: a relocatable standalone CPython 3.10 with the locked deps,
the adapter + ps2exe source, an archive tool, and a launcher the desktop app invokes
with no uv/Python/dev-tools on the target. Runs on macOS *or* Windows.
Code-signing/notarization are out of scope.

Usage:  python bundle.py     (with uv on PATH; works under `uv run` too)
"""

import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "dist" / "bundle"
WINDOWS = sys.platform.startswith("win")

# Discover the *standalone managed* interpreter, not whatever venv is active — running
# this under `uv run` would otherwise point uv at the project .venv (symlinked, not
# relocatable). Strip venv markers for the uv discovery calls.
UV_ENV = {k: v for k, v in os.environ.items()
          if k not in ("VIRTUAL_ENV", "CONDA_PREFIX", "UV_PROJECT_ENVIRONMENT")}

# GUI/dev-only packages pyisotools drags in; PySide6 alone is the ~1.1 GB win. We must
# keep its runtime deps (chardet/requests/...), so prune only the clearly-unused ones.
PRUNE = [
    "pyside6", "pyside6-addons", "pyside6-essentials", "shiboken6", "qdarkstyle", "qtpy",
    "pyinstaller", "pyinstaller-hooks-contrib", "altgraph", "macholib",
    "pylint", "astroid", "dill", "isort", "mccabe",
]


def run(cmd, **kw):
    print(f"   $ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(cmd, check=True, **kw)


def capture(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout.strip()


def main():
    print(">> standalone CPython 3.10 (uv-managed, relocatable)")
    run(["uv", "python", "install", "--managed-python", "3.10"], env=UV_ENV)
    pybin = Path(capture(["uv", "python", "find", "--managed-python", ">=3.10,<3.11"], env=UV_ENV))
    # macOS layout: <root>/bin/python3.10 ; Windows layout: <root>/python.exe
    pydir = pybin.parent if WINDOWS else pybin.parent.parent
    print(f"   {pydir}")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    shutil.copytree(pydir, OUT / "python", symlinks=True)
    bpy = OUT / "python" / ("python.exe" if WINDOWS else "bin/python3.10")

    # This copy is ours; drop uv's "externally managed" marker so pip can install.
    for marker in (OUT / "python").rglob("EXTERNALLY-MANAGED"):
        marker.unlink()

    print(">> bootstrap pip (uv-managed CPython ships locked down)")
    env = {**os.environ, "PIP_BREAK_SYSTEM_PACKAGES": "1"}
    getpip = OUT / "get-pip.py"
    urllib.request.urlretrieve("https://bootstrap.pypa.io/get-pip.py", getpip)
    run([str(bpy), str(getpip), "--no-warn-script-location"], env=env)
    getpip.unlink()

    print(">> locked deps -> bundle interpreter")
    reqs = OUT / "requirements.txt"
    with open(reqs, "w") as f:
        subprocess.run(
            ["uv", "export", "--format", "requirements-txt", "--no-hashes", "--no-dev", "--no-emit-project"],
            cwd=HERE, check=True, stdout=f,
        )
    run([str(bpy), "-m", "pip", "install", "--no-warn-script-location",
         "--disable-pip-version-check", "-r", str(reqs)], env=env)

    print(">> prune GUI/dev deps the adapter never imports")
    for pkg in PRUNE:
        subprocess.run([str(bpy), "-m", "pip", "uninstall", "-y", "--break-system-packages", pkg],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print(">> bundle an archive tool (ps2exe needs a 7z/unrar tool at import)")
    bin_dir = OUT / "bin"
    bin_dir.mkdir()
    bundle_archive_tool(bin_dir)

    print(">> app + engine source")
    shutil.copytree(HERE / "curator_adapter", OUT / "curator_adapter")
    shutil.copytree(ROOT / "lib" / "ps2exe", OUT / "ps2exe")
    for cache in OUT.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)

    # Fail the build loudly if pruning removed a dep the adapter actually imports.
    run([str(bpy), "-c", "import curator_adapter"],
        env={**env, "PYTHONPATH": str(OUT)})

    print(">> launcher")
    write_launcher(OUT)

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f">> done: {OUT}  ({size / 1e6:.0f} MB)")
    print(f"   adapter launcher: {OUT / launcher_name()}")


def bundle_archive_tool(bin_dir: Path):
    """Copy a 7z/unrar binary into the bundle. unRAR is extraction-only redistributable."""
    if WINDOWS:
        for name in ("7z.exe", "7za.exe", "unrar.exe"):
            found = shutil.which(name)
            if found:
                shutil.copy2(found, bin_dir / name)
                print(f"   bundled {name}")
                return
        print(r"   WARNING: no 7z.exe/unrar.exe on PATH; place one in bin\ for .rar/.7z")
        return
    # macOS: prefer a native 7zz, else a Mach-O unrar (x86_64 runs via Rosetta).
    sevenzip = shutil.which("7zz")
    if sevenzip:
        shutil.copy2(sevenzip, bin_dir / "7zz")
        print("   bundled 7zz")
        return
    unrar = shutil.which("unrar") or "/usr/local/bin/unrar"
    if Path(unrar).exists() and b"Mach-O" in capture_file_type(unrar):
        shutil.copy2(unrar, bin_dir / "unrar")
        print("   bundled unrar")
    else:
        print(f"   WARNING: no standalone 7zz/unrar found; provide one in {bin_dir}")


def capture_file_type(path: str) -> bytes:
    try:
        return subprocess.run(["file", path], capture_output=True).stdout
    except OSError:
        return b""


def launcher_name() -> str:
    return "curator-adapter.cmd" if WINDOWS else "curator-adapter"


def write_launcher(out: Path):
    launcher = out / launcher_name()
    if WINDOWS:
        launcher.write_text(
            "@echo off\r\n"
            'set "DIR=%~dp0"\r\n'
            'set "CURATOR_PS2EXE_DIR=%DIR%ps2exe"\r\n'
            'set "PYTHONPATH=%DIR%"\r\n'
            'set "PATH=%DIR%bin;%PATH%"\r\n'
            '"%DIR%python\\python.exe" -m curator_adapter.cli %*\r\n'
        )
    else:
        launcher.write_text(
            "#!/bin/sh\n"
            'DIR=$(cd "$(dirname "$0")" && pwd)\n'
            'export CURATOR_PS2EXE_DIR="$DIR/ps2exe"\n'
            'export PYTHONPATH="$DIR"\n'
            'export PATH="$DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin"\n'
            'exec "$DIR/python/bin/python3.10" -m curator_adapter.cli "$@"\n'
        )
        launcher.chmod(0o755)


if __name__ == "__main__":
    main()
