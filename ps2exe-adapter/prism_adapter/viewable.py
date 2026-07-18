"""Classify build files that a stock browser can display inline.

Extension names the candidate type; the header bytes confirm it (a binary
renamed to README.TXT must not ship as a text asset). Everything text-like is
served as text/plain — never text/html — so a crafted HTML file in a dump
can't script against the web origin.
"""

# Hard cap on extracted asset size. Files past this fall back to a head snippet.
MAX_ASSET_SIZE = 20 * 1024 * 1024

# Videos get a larger allowance: DVD-Video discs split a title into .VOB files
# of up to 1 GiB each, and demoting those to head snippets would drop the only
# viewable content such a disc carries. Files above MAX_ASSET_SIZE are streamed
# into the store (see cli._stream_to_store), never buffered whole.
MAX_VIDEO_SIZE = 1280 * 1024 * 1024


def max_size(kind):
    """Per-kind cap on shipping a file whole into the asset store."""
    return MAX_VIDEO_SIZE if kind == "video" else MAX_ASSET_SIZE

# How many leading bytes sniffing needs (SVG tag scan is the long pole).
SNIFF_BYTES = 4096

# Files nothing below claims (plus sniff failures and oversized candidates) are
# still shipped: their leading bytes go into the store raw, so the UIs can show
# a hex view — and change how they render it without re-analyzing collections.
SNIPPET_BYTES = 2048
SNIPPET_KIND = "binary"
SNIPPET_MIME = "application/octet-stream"

_IMAGE = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tga": "image/x-tga",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "webp": "image/webp",
    "ico": "image/x-icon",
    "svg": "image/svg+xml",
}

_AUDIO = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
}

_VIDEO = {
    "mp4": "video/mp4",
    "m4v": "video/mp4",
    "webm": "video/webm",
    # MPEG-1/2 program streams (and bare video elementary streams). No browser
    # plays these natively. The web viewer streams them through a server-side
    # MP4 transcode and degrades to a download card without it.
    "mpg": "video/mpeg",
    "mpeg": "video/mpeg",
    "m1v": "video/mpeg",
    "m2v": "video/mpeg",
    "vob": "video/mpeg",
}

# Print-format documents. Browsers render PDF natively; PostScript (.eps, .ps,
# and the classic Illustrator .ai, which is EPS under the hood) is rasterized
# server-side when Ghostscript is available. .ai needs the sniff more than
# anything: game discs reuse the extension for AI behavior data (Eternal
# Champions' 68k blobs, Wild Metal's AIDEF scripts) — only %!PS bytes pass.
_DOCUMENT = {
    "pdf": "application/pdf",
    "eps": "application/postscript",
    "ps": "application/postscript",
    "ai": "application/postscript",
}

# Docs, configs, data — the formats prototype discs actually carry. All are
# served as text/plain regardless of what they'd mean to a browser (html).
_TEXT = frozenset(
    """
    txt nfo diz me 1st doc readme md log ini cfg conf inf cue gdi lst csv tsv
    json xml htm html yml yaml toml srt
    """.split()
)

# Program sources and build files — split from _TEXT so the UIs can group and
# syntax-highlight them. Same posture: always served as text/plain.
_SOURCE = frozenset(
    """
    c h cc cpp cxx hpp hh hxx inc s asm pas bas lua py pl sh bat cmd js mjs css
    ssl mak mk rc def lnk prj
    """.split()
)

# Extensionless filenames that are still source (matched case-insensitively).
_SOURCE_NAMES = frozenset({"makefile", "gnumakefile"})

_KINDS = (
    [(_IMAGE, "image")] + [(_AUDIO, "audio")] + [(_VIDEO, "video")] + [(_DOCUMENT, "document")]
)


def classify(path):
    """(kind, mime) a browser could render for this filename, else None.

    Extension-only guess — callers must confirm with sniff() on real bytes.
    """
    name = path.rsplit("/", 1)[-1]
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if not ext:
        return ("source", "text/plain") if name.lower() in _SOURCE_NAMES else None
    for table, kind in _KINDS:
        mime = table.get(ext)
        if mime:
            return kind, mime
    if ext in _SOURCE:
        return "source", "text/plain"
    if ext in _TEXT:
        return "text", "text/plain"
    return None


def _looks_text(head):
    if not head:
        return False
    if b"\x00" in head:
        return False
    # Legacy encodings (Shift-JIS, Latin-1) live above 0x7f — only bare C0
    # control characters (not the whitespace/escape family) mark binary data.
    weird = sum(1 for b in head if b < 0x20 and b not in (0x09, 0x0A, 0x0D, 0x0C, 0x1B))
    return weird <= len(head) // 20


def _tga_header(head):
    """TGA has no leading magic — check the 18-byte header for plausibility."""
    if len(head) < 18:
        return False
    cmap_type, image_type = head[1], head[2]
    if cmap_type not in (0, 1):
        return False
    if image_type not in (1, 2, 3, 9, 10, 11):
        return False
    # Color-mapped image types require a color map with a sane entry size.
    if image_type in (1, 9) and (cmap_type != 1 or head[7] not in (15, 16, 24, 32)):
        return False
    width = head[12] | head[13] << 8
    height = head[14] | head[15] << 8
    return width > 0 and height > 0 and head[16] in (8, 15, 16, 24, 32)


_MAGIC = {
    "image/png": lambda h: h.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda h: h.startswith(b"\xff\xd8\xff"),
    "image/gif": lambda h: h.startswith((b"GIF87a", b"GIF89a")),
    "image/bmp": lambda h: h.startswith(b"BM"),
    "image/x-tga": _tga_header,
    "image/tiff": lambda h: h.startswith((b"II*\x00", b"MM\x00*")),
    "image/webp": lambda h: h[:4] == b"RIFF" and h[8:12] == b"WEBP",
    "image/x-icon": lambda h: h.startswith((b"\x00\x00\x01\x00", b"\x00\x00\x02\x00")),
    "image/svg+xml": lambda h: _looks_text(h) and b"<svg" in h.lower(),
    "audio/wav": lambda h: h[:4] == b"RIFF" and h[8:12] == b"WAVE",
    "audio/mpeg": lambda h: h.startswith(b"ID3")
    or (len(h) >= 2 and h[0] == 0xFF and (h[1] & 0xE0) == 0xE0),
    "audio/ogg": lambda h: h.startswith(b"OggS"),
    "audio/flac": lambda h: h.startswith(b"fLaC"),
    "audio/mp4": lambda h: h[4:8] == b"ftyp",
    "video/mp4": lambda h: h[4:8] == b"ftyp",
    "video/webm": lambda h: h.startswith(b"\x1aE\xdf\xa3"),
    # Program streams (.mpg, DVD .vob) open on a pack start code, elementary
    # video streams (.m1v/.m2v) on a sequence header.
    "video/mpeg": lambda h: h.startswith((b"\x00\x00\x01\xba", b"\x00\x00\x01\xb3")),
    "application/pdf": lambda h: h.startswith(b"%PDF-"),
    # ASCII PostScript/EPS, or the DOS EPS binary wrapper around one.
    "application/postscript": lambda h: h.startswith((b"%!PS", b"\xc5\xd0\xd3\xc6")),
    "text/plain": _looks_text,
}


def sniff(head, mime):
    """True when the leading bytes are plausibly the claimed mime."""
    check = _MAGIC.get(mime)
    return bool(check and check(head))
