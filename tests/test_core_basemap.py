"""review_core/basemap.py: the gray basemap picture each route map shows on the artifact page. Tiles come from a stub, never the network."""
import io

import pytest

from review_core import assets, basemap

PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402


def tile_bytes(color, alpha=255):
    b = io.BytesIO()
    Image.new("RGBA", (256, 256), color + (alpha,)).save(b, "PNG")
    return b.getvalue()


def stub_fetch(seen):
    def fetch(url):
        seen.append(url)
        return tile_bytes((200, 200, 200)) if "Gray_Base" in url else tile_bytes((0, 0, 0), 0)
    return fetch


def test_world_xy_and_lonlat_round_trip():
    for lon, lat in ((0, 0), (-88.9, 39.77), (151.2, -33.87), (179.9, 84)):
        x, y = basemap.world_xy(lon, lat)
        lo, la = basemap.lonlat(x, y)
        assert abs(lo - lon) < 1e-9 and abs(la - lat) < 1e-9


def test_plan_covers_the_padded_bbox_within_the_pixel_budget():
    for bbox in ([-100.33, 32.04, -100.26, 35.41], [-97.67, 37.33, -97.35, 37.34], [-88.9, 39.77, -88.8, 39.91], [10, 20, 10, 20]):
        z, x0, y0, x1, y1 = basemap.plan(bbox)
        assert 0 <= z <= basemap.MAX_ZOOM
        assert max(x1 - x0 + 1, y1 - y0 + 1) * basemap.TILE <= basemap.MAX_EDGE + 2 * basemap.TILE
        (s, w), (n, e) = basemap.bounds((z, x0, y0, x1, y1))
        assert w <= bbox[0] and e >= bbox[2] and s <= bbox[1] and n >= bbox[3]


def test_plan_refuses_a_bad_bbox():
    assert basemap.plan(None) is None
    assert basemap.plan([1, 2, 3]) is None
    assert basemap.plan([10, 0, 5, 1]) is None       # crosses the antimeridian (west > east)


def test_make_stitches_once_and_reuses_the_copy(tmp_path):
    seen = []
    b = basemap.make([-88.9, 39.77, -88.8, 39.91], tmp_path, stub_fetch(seen))
    assert assets.ASSET_RE.match(b["asset"]) and b["asset"].endswith(".jpg")
    z, x0, y0, x1, y1 = basemap.plan([-88.9, 39.77, -88.8, 39.91])
    assert len(seen) == 2 * (x1 - x0 + 1) * (y1 - y0 + 1)          # base and reference
    with Image.open(assets.asset_dir(tmp_path) / b["asset"]) as im:
        assert im.size == (b["width"], b["height"])
        assert abs(im.getpixel((5, 5))[0] - 200) <= 3              # the transparent reference keeps the base
    again = basemap.make([-88.9, 39.77, -88.8, 39.91], tmp_path, stub_fetch(seen))
    assert again == b and len(seen) == 2 * (x1 - x0 + 1) * (y1 - y0 + 1)


def test_attach_sets_basemap_on_route_geo_and_survives_a_failed_tile(tmp_path):
    def broken(url):
        raise OSError("blocked")
    route = {"geo": {"bbox": [-88.9, 39.77, -88.8, 39.91], "candidate": {"features": []}}}
    other = {"geo": {"bbox": [-97.67, 37.33, -97.35, 37.34], "candidate": {"features": []}, "basemap": {"asset": "x"}}}
    data = {"pipelines": [{"lines": [route, {"geo": None}]}]}
    assert basemap.attach(data, tmp_path, stub_fetch([])) == (1, 0)
    assert route["geo"]["basemap"]["asset"] in [i["asset"] for i in assets.images_in(data)]
    assert basemap.attach({"lines": [other]}, tmp_path, broken) == (0, 1)
    assert "basemap" not in other["geo"]
