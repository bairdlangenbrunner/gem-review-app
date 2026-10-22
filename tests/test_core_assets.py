"""review_core/assets.py: the downscaled copies a page shows, and the manifest of what each page has uploaded."""
import os
import random
from pathlib import Path

import pytest

pytest.importorskip("PIL")
from PIL import Image

from review_core import assets

ART = "https://claude.ai/artifact/x"


def noise(size, mode="RGB", seed=1):
    rnd = random.Random(seed)
    raw = bytes(rnd.getrandbits(8) for _ in range(size[0] * size[1] * len(mode)))
    return Image.frombytes(mode, size, raw)


def dims(path):
    with Image.open(path) as im:
        return im.size, im.format


def test_small_png_is_copied_byte_identical(tmp_path):
    src = tmp_path / "small.png"
    Image.new("RGB", (300, 200), (10, 120, 200)).save(src)
    r = assets.prepare(src, tmp_path)
    sha = assets.source_sha(src)
    assert r == {"asset": f"{sha}.png", "width": 300, "height": 200, "bytes": src.stat().st_size}
    assert (assets.asset_dir(tmp_path) / r["asset"]).read_bytes() == src.read_bytes()


def test_big_png_is_downscaled_to_the_long_edge(tmp_path):
    src = tmp_path / "big.png"
    Image.new("RGB", (3200, 1600), (200, 30, 30)).save(src)          # flat colors: the downscale stays a small PNG
    r = assets.prepare(src, tmp_path)
    assert r["asset"].endswith(".png") and (r["width"], r["height"]) == (1600, 800)
    assert dims(assets.asset_dir(tmp_path) / r["asset"]) == ((1600, 800), "PNG")


def test_photo_like_png_that_stays_over_a_megabyte_becomes_a_jpeg(tmp_path):
    src = tmp_path / "photo.png"
    noise((1800, 1000)).save(src)
    r = assets.prepare(src, tmp_path)
    assert r["asset"].endswith(".jpg") and (r["width"], r["height"]) == (1600, 889)
    assert dims(assets.asset_dir(tmp_path) / r["asset"])[1] == "JPEG"
    assert not list(assets.asset_dir(tmp_path).glob("*.part"))


def test_big_jpeg_is_downscaled(tmp_path):
    src = tmp_path / "big.jpg"
    Image.new("RGB", (4000, 3000), (30, 90, 160)).save(src, "JPEG")
    r = assets.prepare(src, tmp_path)
    assert r["asset"].endswith(".jpg") and max(r["width"], r["height"]) == 1600 and r["width"] > r["height"]


def test_rgba_is_flattened_when_written_as_jpeg(tmp_path):
    src = tmp_path / "alpha.png"
    noise((1700, 1000), "RGBA").save(src)                              # random alpha too: the downscale is still over a megabyte
    r = assets.prepare(src, tmp_path)
    assert r["asset"].endswith(".jpg")
    with Image.open(assets.asset_dir(tmp_path) / r["asset"]) as out:
        assert out.mode == "RGB"


def test_transparent_pixels_become_white():
    out = assets._flat(Image.new("RGBA", (4, 4), (255, 0, 0, 0)))
    assert out.mode == "RGB" and out.getpixel((1, 1)) == (255, 255, 255)
    assert assets._flat(Image.new("RGBA", (4, 4), (255, 0, 0, 255))).getpixel((1, 1)) == (255, 0, 0)


def test_second_prepare_reuses_the_copy(tmp_path):
    src = tmp_path / "small.png"
    Image.new("RGB", (50, 50), (1, 2, 3)).save(src)
    first = assets.prepare(src, tmp_path)
    dest = assets.asset_dir(tmp_path) / first["asset"]
    os.utime(dest, (1_000_000, 1_000_000))
    second = assets.prepare(src, tmp_path)
    assert second == first and dest.stat().st_mtime == 1_000_000


def test_cache_skips_hashing_an_unchanged_source(tmp_path):
    from review_core.pages import FileCache
    src = tmp_path / "a.png"
    Image.new("RGB", (20, 20), (1, 2, 3)).save(src)
    cache = FileCache()
    assert assets.source_sha(src, cache) == assets.source_sha(src)
    assert assets.prepare(src, tmp_path, cache)["asset"] == assets.prepare(src, tmp_path)["asset"]


def test_non_images_and_missing_files_give_none(tmp_path):
    txt = tmp_path / "notes.txt"
    txt.write_text("hello")
    bad = tmp_path / "broken.png"
    bad.write_bytes(b"not a png")
    assert assets.prepare(txt, tmp_path) is None
    assert assets.prepare(tmp_path / "nope.png", tmp_path) is None
    assert assets.prepare(bad, tmp_path) is None


def test_record_url_for_and_missing(tmp_path):
    a, b = "a" * 64 + ".jpg", "b" * 64 + ".png"
    manifest = tmp_path / "assets.json"
    assets.asset_dir(tmp_path).mkdir(parents=True)
    (assets.asset_dir(tmp_path) / a).write_bytes(b"12345")
    assert assets.load_manifest(manifest) == {}
    assert assets.record(manifest, ART, {a: "https://u/a"}, root=tmp_path, today="2026-10-22") == 1
    m = assets.load_manifest(manifest)
    assert m["a" * 64][ART] == {"url": "https://u/a", "uploaded": "2026-10-22", "bytes": 5}
    assert assets.url_for(m, a, ART) == "https://u/a"
    assert assets.url_for(m, a, "https://claude.ai/artifact/other") == ""
    assert assets.url_for(m, b, ART) == ""
    assets.record(manifest, "https://claude.ai/artifact/other", {a: "https://u/a2"}, today="2026-10-22")
    m = assets.load_manifest(manifest)
    assert set(m["a" * 64]) == {ART, "https://claude.ai/artifact/other"} and "bytes" not in m["a" * 64]["https://claude.ai/artifact/other"]
    assert assets.missing([b, a, b], m, ART) == [b]


@pytest.mark.parametrize("name, url", [("../x.jpg", "https://u"), ("a" * 63 + ".jpg", "https://u"), ("A" * 64 + ".jpg", "https://u"),
                                       ("a" * 64 + ".gif", "https://u"), ("a" * 64 + ".jpg", "")])
def test_record_rejects_a_bad_asset_name_or_url(tmp_path, name, url):
    with pytest.raises(ValueError):
        assets.record(tmp_path / "assets.json", ART, {name: url})
    assert not (tmp_path / "assets.json").exists()


def test_fill_urls_sets_clears_and_reports_missing_once(tmp_path):
    a, b = "a" * 64 + ".jpg", "b" * 64 + ".png"
    manifest = tmp_path / "assets.json"
    assets.record(manifest, ART, {a: "https://u/a"}, today="2026-10-22")
    data = {"lines": [{"provenance": {"images": [{"asset": a}, {"asset": b, "url": "https://stale"}]}},
                      {"provenance": {"images": [{"asset": b}, {"caption": "no asset"}]}}]}
    missing = assets.fill_urls(data, assets.load_manifest(manifest), ART)
    imgs = [i for i in assets.images_in(data)]
    assert missing == [b]
    assert [i.get("url") for i in imgs] == ["https://u/a", None, None]
    assert len(imgs) == 3
    # a page that uploaded nothing: the stale url goes, everything is missing
    other = assets.fill_urls(data, assets.load_manifest(manifest), "https://claude.ai/artifact/other")
    assert other == [a, b] and not any("url" in i for i in assets.images_in(data))
