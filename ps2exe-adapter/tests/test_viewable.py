from curator_adapter import viewable


def test_classify_by_extension():
    assert viewable.classify("/DATA/TITLE.PNG") == ("image", "image/png")
    assert viewable.classify("/readme.txt") == ("text", "text/plain")
    assert viewable.classify("/BGM/track.ogg") == ("audio", "audio/ogg")
    assert viewable.classify("/movie.mp4") == ("video", "video/mp4")
    # Served as text/plain, never text/html (see viewable.py docstring).
    assert viewable.classify("/docs/index.html") == ("text", "text/plain")


def test_classify_source():
    assert viewable.classify("/SRC/GFXCORE.C") == ("source", "text/plain")
    assert viewable.classify("/SRC/DEFS.H") == ("source", "text/plain")
    assert viewable.classify("/SCRIPTS/INTRO.SSL") == ("source", "text/plain")
    assert viewable.classify("/tools/mkiso.bat") == ("source", "text/plain")
    assert viewable.classify("/SRC/VECMATH.S") == ("source", "text/plain")
    # Build files count as source, including extensionless makefiles.
    assert viewable.classify("/SRC/MAKEFILE") == ("source", "text/plain")
    assert viewable.classify("/proj/Makefile") == ("source", "text/plain")
    assert viewable.classify("/proj/win32.mak") == ("source", "text/plain")
    # Docs and configs stay plain text; other extensionless names stay rejected.
    assert viewable.classify("/prefs.ini") == ("text", "text/plain")
    assert viewable.classify("/notes.md") == ("text", "text/plain")


def test_classify_rejects_unknown_and_extensionless():
    assert viewable.classify("/SLPS_123.45") is None
    assert viewable.classify("/GAME.TIM") is None
    assert viewable.classify("/README") is None


def test_sniff_confirms_magic():
    assert viewable.sniff(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8, "image/png")
    assert not viewable.sniff(b"MZ\x90\x00", "image/png")
    assert viewable.sniff(b"RIFF\x24\x08\x00\x00WAVEfmt ", "audio/wav")
    assert not viewable.sniff(b"RIFF\x24\x08\x00\x00WEBP", "audio/wav")
    assert viewable.sniff(b'<?xml version="1.0"?><svg xmlns="x">', "image/svg+xml")


def test_sniff_text_accepts_legacy_encodings_rejects_binary():
    # Shift-JIS bytes are >= 0x80 — must pass the text heuristic.
    assert viewable.sniff("日本語のテキスト".encode("shift_jis"), "text/plain")
    assert viewable.sniff(b"plain ascii\r\nwith lines\r\n", "text/plain")
    # A renamed binary: NUL bytes or dense C0 controls mark it non-text.
    assert not viewable.sniff(b"MZ\x00\x01\x02\x03binary", "text/plain")
    assert not viewable.sniff(bytes(range(1, 32)) * 4, "text/plain")
    assert not viewable.sniff(b"", "text/plain")
