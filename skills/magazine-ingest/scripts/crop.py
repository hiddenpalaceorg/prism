#!/usr/bin/env python3
"""Cut QA sample crops from rendered pages using extract bboxes. See SKILL.md.

  crop.py <workdir> <extracts.jsonl...> [--sample 0.1] [--all] [--out DIR]

Samples ~10% of the extracts (stable per client_key, so re-runs pick the same
ones), cuts every region of each sampled extract from <workdir>/pages/p-<n>.jpg
with 1% padding, and writes <out>/<client_key>-r<i>.png (i = 0-based region
index; default out dir <workdir>/qa). Prints one manifest line per crop:

  client_key<TAB>kind<TAB>title<TAB>path

Run under `uv run --no-project --with pillow python3 crop.py ...`; plain
python3 works too when Pillow is installed.
"""

import argparse
import hashlib
import json
import os
import re
import sys

try:
    from PIL import Image
except ImportError:
    Image = None

PAD = 0.01  # normalized padding on every side

def note(msg):
    print(msg, file=sys.stderr)

def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)

def read_extracts(paths):
    """[(source, extract)] from JSONL files; malformed lines are fatal —
    the QA pass must not silently skip what pass 2 wrote."""
    out = []
    for path in paths:
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()
        except OSError as e:
            die(f"cannot read {path}: {e}")
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                v = json.loads(line)
            except json.JSONDecodeError as e:
                die(f"{path}:{i}: bad JSON: {e}")
            if not isinstance(v, dict) or not v.get("client_key"):
                die(f"{path}:{i}: extract must be an object with a client_key")
            out.append((f"{path}:{i}", v))
    return out

def sampled(client_key, fraction):
    """Stable inclusion: hash of the key under the threshold. Re-runs and
    appended files keep the same picks."""
    h = int.from_bytes(hashlib.sha1(client_key.encode()).digest()[:8], "big")
    return h / 2**64 < fraction

def safe_name(key):
    return re.sub(r"[^A-Za-z0-9._-]", "_", key)[:150]

def crop_region(pages_dir, out_dir, extract, i, region):
    n = region.get("pdf_index")
    if not isinstance(n, int) or n < 1:
        return None, f"regions[{i}].pdf_index invalid"
    src = os.path.join(pages_dir, f"p-{n}.jpg")
    if not os.path.exists(src):
        return None, f"no page render {src}"
    try:
        x, y = float(region["x"]), float(region["y"])
        w, h = float(region["w"]), float(region["h"])
    except (KeyError, TypeError, ValueError):
        return None, f"regions[{i}] bbox malformed"
    x0 = max(0.0, x - PAD)
    y0 = max(0.0, y - PAD)
    x1 = min(1.0, x + w + PAD)
    y1 = min(1.0, y + h + PAD)
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None, f"regions[{i}] is degenerate"
    with Image.open(src) as im:
        pw, ph = im.size
        box = (round(x0 * pw), round(y0 * ph),
               max(round(x0 * pw) + 1, round(x1 * pw)),
               max(round(y0 * ph) + 1, round(y1 * ph)))
        dst = os.path.join(out_dir, f"{safe_name(extract['client_key'])}-r{i}.png")
        im.crop(box).save(dst)
    return dst, None

def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("workdir", help="work dir holding pages/p-<n>.jpg")
    p.add_argument("jsonl", nargs="+", help="pass-2 checkpoint files (pages-*.jsonl)")
    p.add_argument("--sample", type=float, default=0.1, metavar="FRAC",
                   help="fraction of extracts to crop (default 0.1)")
    p.add_argument("--all", action="store_true", help="crop every extract")
    p.add_argument("--out", metavar="DIR", help="output dir (default <workdir>/qa)")
    args = p.parse_args()

    if Image is None:
        die("Pillow is required: run under `uv run --no-project --with pillow python3 ...`")
    if not args.all and not 0 < args.sample <= 1:
        die("--sample must be in (0, 1]")

    pages_dir = os.path.join(args.workdir, "pages")
    if not os.path.isdir(pages_dir):
        die(f"no pages dir: {pages_dir} (run render.py first)")
    out_dir = args.out or os.path.join(args.workdir, "qa")
    os.makedirs(out_dir, exist_ok=True)

    extracts = read_extracts(args.jsonl)
    if not extracts:
        die("no extracts in the given files")
    picked = [e for e in extracts if args.all or sampled(e[1]["client_key"], args.sample)]
    if not picked:
        picked = [extracts[0]]  # never sample zero
    note(f"{len(picked)} of {len(extracts)} extracts sampled")

    errors = 0
    crops = 0
    for source, extract in picked:
        regions = extract.get("regions")
        if not isinstance(regions, list) or not regions:
            note(f"ERROR {source}: {extract['client_key']}: no regions")
            errors += 1
            continue
        for i, region in enumerate(regions):
            if not isinstance(region, dict):
                note(f"ERROR {source}: {extract['client_key']}: regions[{i}] not an object")
                errors += 1
                continue
            path, err = crop_region(pages_dir, out_dir, extract, i, region)
            if err:
                note(f"ERROR {source}: {extract['client_key']}: {err}")
                errors += 1
                continue
            print(f"{extract['client_key']}\t{extract.get('kind', '?')}\t"
                  f"{extract.get('title') or ''}\t{path}")
            crops += 1

    note(f"{crops} crops written to {out_dir}" + (f", {errors} errors" if errors else ""))
    if errors:
        sys.exit(1)

if __name__ == "__main__":
    main()
