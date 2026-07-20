"""Builds the small press-kit ISO the CI screenshot step feeds to PrismWin,
so the design-review screenshots show a populated build. Deterministic output:
gradient PNGs, a readme, and an opaque binary, authored with pycdlib.

Usage: uv run --with pycdlib --no-project python windows/make-sample-iso.py OUT.iso
"""

import struct
import sys
import zlib
from io import BytesIO

from pycdlib import PyCdlib


def png(w, h, top, bottom):
    """A vertical-gradient truecolor PNG, stdlib only."""

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    rows = []
    for y in range(h):
        f = y / (h - 1)
        pixel = bytes(int(a + (b - a) * f) for a, b in zip(top, bottom))
        rows.append(b"\x00" + pixel * w)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


PORTRAITS = {
    "AJANTIS": ((60, 90, 200), (235, 120, 130)),
    "BGSC1": ((200, 70, 90), (250, 210, 120)),
    "BGSC2": ((40, 140, 110), (180, 230, 160)),
    "SAFANA": ((120, 60, 180), (240, 160, 200)),
    "BALDR000": ((30, 60, 120), (140, 200, 240)),
    "BALDR001": ((200, 120, 40), (250, 230, 150)),
}


def main(out):
    iso = PyCdlib()
    iso.new(interchange_level=3, joliet=3, vol_ident="PRESSKIT")
    iso.add_directory("/IMAGES", joliet_path="/Images")
    entries = {
        "/README.TXT;1": ("/README.txt", b"Sample press kit for CI screenshots.\r\n"),
        "/DATA.BIN;1": ("/DATA.bin", bytes((i * 197 + 13) % 256 for i in range(4096))),
    }
    for name, (top, bottom) in PORTRAITS.items():
        entries[f"/IMAGES/{name}.PNG;1"] = (f"/Images/{name}.png", png(320, 240, top, bottom))
    for iso_path, (joliet_path, payload) in entries.items():
        iso.add_fp(BytesIO(payload), len(payload), iso_path, joliet_path=joliet_path)
    iso.write(out)
    iso.close()


if __name__ == "__main__":
    main(sys.argv[1])
