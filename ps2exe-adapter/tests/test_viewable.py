from prism_adapter import viewable


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


def test_sniff_tga_header_plausibility():
    assert viewable.classify("/GFX/LOADING.TGA") == ("image", "image/x-tga")
    # 18-byte header: bare 2x1 24bpp truecolor, then a 16-color color-mapped image.
    truecolor = bytes([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 24, 0])
    assert viewable.sniff(truecolor, "image/x-tga")
    cmapped = bytes([0, 1, 1, 0, 0, 16, 0, 24, 0, 0, 0, 0, 2, 0, 1, 0, 8, 0])
    assert viewable.sniff(cmapped, "image/x-tga")
    # No magic to lean on, so the header fields must reject imposters:
    # zero dimensions, junk image type, junk depth, text, short reads.
    assert not viewable.sniff(bytes(18), "image/x-tga")
    assert not viewable.sniff(b"An 18+ byte readme that is not an image.", "image/x-tga")
    assert not viewable.sniff(truecolor[:12], "image/x-tga")
    bad_type = bytearray(truecolor)
    bad_type[2] = 7
    assert not viewable.sniff(bytes(bad_type), "image/x-tga")
    bad_depth = bytearray(truecolor)
    bad_depth[16] = 13
    assert not viewable.sniff(bytes(bad_depth), "image/x-tga")


def test_sniff_tiff_magic_and_case_insensitive_extension():
    # Extensions match case-insensitively — dumps carry ASDF.TIF-style names.
    assert viewable.classify("/GFX/TITLE.TIF") == ("image", "image/tiff")
    assert viewable.classify("/GFX/title.tiff") == ("image", "image/tiff")
    assert viewable.sniff(b"II*\x00" + bytes(16), "image/tiff")
    assert viewable.sniff(b"MM\x00*" + bytes(16), "image/tiff")
    assert not viewable.sniff(b"II\x00*" + bytes(16), "image/tiff")
    assert not viewable.sniff(b"Not a TIFF at all, honest.", "image/tiff")


def test_classify_mpeg_video():
    assert viewable.classify("/MOVIE/OPENING.MPG") == ("video", "video/mpeg")
    assert viewable.classify("/movie/intro.mpeg") == ("video", "video/mpeg")
    assert viewable.classify("/VIDEO_TS/VTS_01_1.VOB") == ("video", "video/mpeg")
    assert viewable.classify("/FMV/DEMO.M2V") == ("video", "video/mpeg")


def test_sniff_mpeg_video():
    # Program stream pack header (.mpg, DVD .vob), MPEG-2 flavor bits vary.
    assert viewable.sniff(b"\x00\x00\x01\xba\x44\x00\x04\x00", "video/mpeg")
    # Elementary video stream sequence header (.m1v/.m2v).
    assert viewable.sniff(b"\x00\x00\x01\xb3\x16\x00\xf0\xc4", "video/mpeg")
    # Renamed junk must not ship as video.
    assert not viewable.sniff(b"RIFF\x24\x08\x00\x00CDXA", "video/mpeg")
    assert not viewable.sniff(b"MZ\x90\x00", "video/mpeg")


def test_classify_avi_video():
    assert viewable.classify("/MOVIES/TRAILER.AVI") == ("video", "video/x-msvideo")
    assert viewable.classify("/fmv/intro.avi") == ("video", "video/x-msvideo")


def test_sniff_avi_video():
    assert viewable.sniff(b"RIFF\x24\x08\x00\x00AVI LIST", "video/x-msvideo")
    # Other RIFF families (WAV, CDXA) must not pass as AVI.
    assert not viewable.sniff(b"RIFF\x24\x08\x00\x00WAVEfmt ", "video/x-msvideo")
    assert not viewable.sniff(b"RIFF\x24\x08\x00\x00CDXAfmt ", "video/x-msvideo")
    assert not viewable.sniff(b"MZ\x90\x00", "video/x-msvideo")


def test_classify_documents():
    assert viewable.classify("/COMIC/BOOK.PDF") == ("document", "application/pdf")
    assert viewable.classify("/ART/LOGO.EPS") == ("document", "application/postscript")
    assert viewable.classify("/ART/banner.ps") == ("document", "application/postscript")
    # Classic Illustrator files are EPS under the hood (Visual Park's clipart).
    assert viewable.classify("/CLIPART/CLIP0001.AI") == ("document", "application/postscript")


def test_sniff_documents():
    assert viewable.sniff(b"%PDF-1.4\r%\xe2\xe3\xcf\xd3\r\n176 0 obj", "application/pdf")
    assert not viewable.sniff(b"%!PS-Adobe-3.0 EPSF-3.0\r\n", "application/pdf")
    assert viewable.sniff(b"%!PS-Adobe-3.0 \r\n%%Creator: Adobe Illustrator(TM) 5.0", "application/postscript")
    # DOS EPS binary wrapper (preview + PostScript behind a 4-byte magic).
    assert viewable.sniff(b"\xc5\xd0\xd3\xc6\x20\x00\x00\x00", "application/postscript")
    # Game data squatting on .ai (Eternal Champions' 68k blobs) must not pass.
    assert not viewable.sniff(b"\x00\x00\x00\x00\x00\x18\x00\x00\x00\x00C\xfa\x02\xae0<", "application/postscript")
    assert not viewable.sniff(b"%PDF-1.4 pdf bytes under a .ai name", "application/postscript")


def test_classify_photoshop():
    assert viewable.classify("/ART/TITLE.PSD") == ("image", "image/vnd.adobe.photoshop")
    assert viewable.classify("/art/huge.psb") == ("image", "image/vnd.adobe.photoshop")


def test_sniff_photoshop():
    # 8BPS + version: 1 = PSD, 2 = PSB. Anything else is an imposter.
    assert viewable.sniff(b"8BPS\x00\x01" + bytes(20), "image/vnd.adobe.photoshop")
    assert viewable.sniff(b"8BPS\x00\x02" + bytes(20), "image/vnd.adobe.photoshop")
    assert not viewable.sniff(b"8BPS\x00\x03" + bytes(20), "image/vnd.adobe.photoshop")
    assert not viewable.sniff(b"MZ\x90\x00", "image/vnd.adobe.photoshop")


def test_resolve_confirms_and_remaps():
    # Plain confirmation passes through untouched.
    assert viewable.resolve(b"%!PS-Adobe-3.0 ", "document", "application/postscript") == (
        "document",
        "application/postscript",
    )
    # Modern Illustrator .ai is PDF under the hood — remapped, not rejected.
    assert viewable.resolve(b"%PDF-1.4\r%\xe2\xe3\xcf\xd3", "document", "application/postscript") == (
        "document",
        "application/pdf",
    )
    # Bytes that are neither: same rejection sniff() gives.
    assert viewable.resolve(b"\x00\x00\x00\x00C\xfa\x02\xae", "document", "application/postscript") is None
    assert viewable.resolve(b"MZ\x90\x00", "image", "image/png") is None


def test_sniff_text_accepts_legacy_encodings_rejects_binary():
    # Shift-JIS bytes are >= 0x80 — must pass the text heuristic.
    assert viewable.sniff("日本語のテキスト".encode("shift_jis"), "text/plain")
    assert viewable.sniff(b"plain ascii\r\nwith lines\r\n", "text/plain")
    # A renamed binary: NUL bytes or dense C0 controls mark it non-text.
    assert not viewable.sniff(b"MZ\x00\x01\x02\x03binary", "text/plain")
    assert not viewable.sniff(bytes(range(1, 32)) * 4, "text/plain")
    assert not viewable.sniff(b"", "text/plain")
