import hashlib
import io

from curator_adapter import viewable
from curator_adapter.cli import _extract_assets
from curator_adapter.progress import ProgressManager


class FakeReader:
    """Minimal reader: files as {path: bytes}."""

    def __init__(self, files):
        self.files = list(files.items())

    def get_root_dir(self):
        return None

    def iso_iterator(self, _root, recursive=True, include_dirs=False):
        return iter(range(len(self.files)))

    def get_file_path(self, f):
        return self.files[f][0]

    def get_file_size(self, f):
        return len(self.files[f][1])

    def open_file(self, f):
        return io.BytesIO(self.files[f][1])


def extract(files, tmp_path):
    out = _extract_assets(FakeReader(files), str(tmp_path), ProgressManager())
    return {a["path"]: a for a in out}


def blob(tmp_path, sha):
    return (tmp_path / sha[:2] / sha).read_bytes()


def test_viewable_files_ship_whole(tmp_path):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    assets = extract({"/GFX/TITLE.PNG": png}, tmp_path)
    a = assets["/GFX/TITLE.PNG"]
    assert (a["kind"], a["mime"], a["size"]) == ("image", "image/png", len(png))
    assert blob(tmp_path, a["sha256"]) == png


def test_tga_ships_as_image_and_imposter_degrades(tmp_path):
    # Bare 2x1 24bpp truecolor TGA — no magic bytes, header checks only.
    tga = bytes([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 24, 0]) + bytes(6)
    fake = b"Just a text file wearing the extension, longer than a header."
    assets = extract({"/GFX/LOADING.TGA": tga, "/GFX/FAKE.TGA": fake}, tmp_path)
    a = assets["/GFX/LOADING.TGA"]
    assert (a["kind"], a["mime"], a["size"]) == ("image", "image/x-tga", len(tga))
    assert blob(tmp_path, a["sha256"]) == tga
    assert assets["/GFX/FAKE.TGA"]["kind"] == viewable.SNIPPET_KIND


def test_tiff_ships_as_image(tmp_path):
    # Sniffing needs only the magic; the uppercase name pins case-insensitive
    # extension matching.
    tif = b"II*\x00" + bytes(60)
    assets = extract({"/GFX/TITLE.TIF": tif}, tmp_path)
    a = assets["/GFX/TITLE.TIF"]
    assert (a["kind"], a["mime"], a["size"]) == ("image", "image/tiff", len(tif))
    assert blob(tmp_path, a["sha256"]) == tif


def test_documents_ship_whole_and_imposter_degrades(tmp_path):
    pdf = b"%PDF-1.4\r%\xe2\xe3\xcf\xd3\r\n1 0 obj\r<<>>\rendobj\r%%EOF"
    eps = b"%!PS-Adobe-3.0 \r\n%%Creator: Adobe Illustrator(TM) 5.0\r\n%%EOF\r\n"
    fake = b"\x00\x00\x00\x00\x00\x18\x00\x00\x00\x00C\xfa\x02\xae0<" + bytes(50)
    assets = extract({"/COMIC/BOOK.PDF": pdf, "/ART/CLIP0001.AI": eps, "/BLAD.AI": fake}, tmp_path)
    a = assets["/COMIC/BOOK.PDF"]
    assert (a["kind"], a["mime"], a["size"]) == ("document", "application/pdf", len(pdf))
    assert blob(tmp_path, a["sha256"]) == pdf
    a = assets["/ART/CLIP0001.AI"]
    assert (a["kind"], a["mime"], a["size"]) == ("document", "application/postscript", len(eps))
    # Game data squatting on .ai stays a hex snippet.
    assert assets["/BLAD.AI"]["kind"] == viewable.SNIPPET_KIND


def test_unidentified_files_ship_head_snippet(tmp_path):
    data = bytes(range(256)) * 20  # 5120 bytes of binary
    assets = extract({"/DATA/GAME.TIM": data}, tmp_path)
    a = assets["/DATA/GAME.TIM"]
    assert (a["kind"], a["mime"]) == (viewable.SNIPPET_KIND, viewable.SNIPPET_MIME)
    assert a["size"] == viewable.SNIPPET_BYTES
    head = data[: viewable.SNIPPET_BYTES]
    assert a["sha256"] == hashlib.sha256(head).hexdigest()
    assert blob(tmp_path, a["sha256"]) == head


def test_snippet_of_short_file_is_whole_file(tmp_path):
    data = b"MZ\x90\x00tiny"
    assets = extract({"/BOOT.XBE": data}, tmp_path)
    a = assets["/BOOT.XBE"]
    assert a["kind"] == viewable.SNIPPET_KIND
    assert a["size"] == len(data)
    assert blob(tmp_path, a["sha256"]) == data


def test_sniff_mismatch_falls_back_to_snippet(tmp_path):
    renamed = b"MZ\x00\x01\x02\x03" + bytes(range(1, 32)) * 100  # binary named .TXT
    assets = extract({"/README.TXT": renamed}, tmp_path)
    a = assets["/README.TXT"]
    assert a["kind"] == viewable.SNIPPET_KIND
    assert a["size"] == viewable.SNIPPET_BYTES
    assert blob(tmp_path, a["sha256"]) == renamed[: viewable.SNIPPET_BYTES]


def test_oversized_viewable_demoted_to_snippet(tmp_path, monkeypatch):
    monkeypatch.setattr(viewable, "MAX_ASSET_SIZE", 64)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
    assets = extract({"/BIG.PNG": png}, tmp_path)
    a = assets["/BIG.PNG"]
    assert a["kind"] == viewable.SNIPPET_KIND
    assert blob(tmp_path, a["sha256"]) == png[: viewable.SNIPPET_BYTES]


# MPEG program-stream pack start code — what viewable.py sniffs video/mpeg by.
MPEG_PS = b"\x00\x00\x01\xba" + bytes(range(256)) * 40  # ~10KB


def test_video_above_buffer_cap_streams_whole(tmp_path, monkeypatch):
    # Past MAX_ASSET_SIZE a video takes the streaming path; it must still land
    # in the store whole, under its full-content hash, with no temp left over.
    monkeypatch.setattr(viewable, "MAX_ASSET_SIZE", 1024)
    assets = extract({"/VIDEO_TS/VTS_01_1.VOB": MPEG_PS}, tmp_path)
    a = assets["/VIDEO_TS/VTS_01_1.VOB"]
    assert (a["kind"], a["mime"], a["size"]) == ("video", "video/mpeg", len(MPEG_PS))
    assert a["sha256"] == hashlib.sha256(MPEG_PS).hexdigest()
    assert blob(tmp_path, a["sha256"]) == MPEG_PS
    assert not list(tmp_path.glob("*.part"))


def test_video_above_video_cap_demoted_to_snippet(tmp_path, monkeypatch):
    monkeypatch.setattr(viewable, "MAX_VIDEO_SIZE", 1024)
    assets = extract({"/VIDEO_TS/VTS_01_1.VOB": MPEG_PS}, tmp_path)
    a = assets["/VIDEO_TS/VTS_01_1.VOB"]
    assert a["kind"] == viewable.SNIPPET_KIND
    assert blob(tmp_path, a["sha256"]) == MPEG_PS[: viewable.SNIPPET_BYTES]


def test_streamed_sniff_mismatch_falls_back_to_snippet(tmp_path, monkeypatch):
    monkeypatch.setattr(viewable, "MAX_ASSET_SIZE", 1024)
    fake = b"not a program stream" * 600  # > MAX_ASSET_SIZE, wrong leading bytes
    assets = extract({"/MOVIE.VOB": fake}, tmp_path)
    a = assets["/MOVIE.VOB"]
    assert a["kind"] == viewable.SNIPPET_KIND
    assert blob(tmp_path, a["sha256"]) == fake[: viewable.SNIPPET_BYTES]
    assert not list(tmp_path.glob("*.part"))


def test_streamed_size_lie_is_dropped(tmp_path, monkeypatch):
    # The directory record understates the size; the stream overruns the cap
    # and the file must be dropped entirely, leaving no temp file behind.
    monkeypatch.setattr(viewable, "MAX_ASSET_SIZE", 1024)
    monkeypatch.setattr(viewable, "MAX_VIDEO_SIZE", 4096)

    class LyingReader(FakeReader):
        def get_file_size(self, f):
            return 2048  # over MAX_ASSET_SIZE (streams), under MAX_VIDEO_SIZE

    out = _extract_assets(LyingReader({"/MOVIE.VOB": MPEG_PS}), str(tmp_path), ProgressManager())
    assert out == []
    assert not list(tmp_path.glob("*.part"))


def test_empty_files_are_skipped(tmp_path):
    assert extract({"/EMPTY.BIN": b""}, tmp_path) == {}
