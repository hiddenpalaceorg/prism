"""Classify build files that a stock browser can display inline.

Extension names the candidate type; the header bytes confirm it (a binary
renamed to README.TXT must not ship as a text asset). Everything text-like is
served as text/plain — never text/html — so a crafted HTML file in a dump
can't script against the web origin.
"""

# Hard cap on extracted asset size. Files past this fall back to a head snippet.
MAX_ASSET_SIZE = 20 * 1024 * 1024

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
    [(_IMAGE, "image")] + [(_AUDIO, "audio")] + [(_VIDEO, "video")]
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


_MAGIC = {
    "image/png": lambda h: h.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda h: h.startswith(b"\xff\xd8\xff"),
    "image/gif": lambda h: h.startswith((b"GIF87a", b"GIF89a")),
    "image/bmp": lambda h: h.startswith(b"BM"),
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
    "text/plain": _looks_text,
}


def sniff(head, mime):
    """True when the leading bytes are plausibly the claimed mime."""
    check = _MAGIC.get(mime)
    return bool(check and check(head))
