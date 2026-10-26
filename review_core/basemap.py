"""
The gray basemap picture a route map shows on the artifact page (docs/plan.md, "Geo").

The artifact page may load images only from itself, so Esri's live tiles never reach it. For each route the build
stitches the Esri Light Gray Canvas tiles (base and reference labels) around the route's bbox into one JPEG, keeps it
in <root>/work/review_assets/ like the map pictures (review_core/assets.py), and sets `geo.basemap`:

    {"asset": "<sha256>.jpg", "bounds": [[south, west], [north, east]], "zoom": z, "width": px, "height": px}

The asset then goes up with the page's other pictures and geo.js draws it under the route as an image overlay. The
name is the sha256 of the tile range (not of the pixels), so a rebuild reuses the copy and the upload; a route whose
bbox moves gets a new picture. The loopback server ignores it and draws live tiles. Nothing here fails a build: a
tile that will not load leaves the route without a basemap.
"""
import hashlib
import io
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from review_core import assets

ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/"
LAYERS = ("Canvas/World_Light_Gray_Base", "Canvas/World_Light_Gray_Reference")
VERSION = "esri-gray-1"          # part of the asset name: change it when the picture's recipe changes
TILE = 256
MAX_EDGE = 2048                 # long edge in pixels; one zoom level sharper than the map's fit at 760 px wide
MAX_ZOOM = 16                   # the gray canvas has native tiles to 16
PAD = 1.4                       # the picture spans this much of the route's extent around its center
WIDE, TALL = 2.8, 1.2           # it is at least as wide as a 2.8:1 map and as tall as a 1.2:1 one, so a fitted map is covered
MIN_SPAN = 8e-4                 # world widths: about a zoom-12 view, for a route that is nearly a point
QUALITY = 82
TIMEOUT = 20
WORKERS = 8
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"


def world_xy(lon, lat):
    """Web Mercator position as fractions of the world width (x east, y south), the same math as geo.js tileXY at z 0."""
    r = math.radians(max(-85.05112878, min(85.05112878, lat)))
    return (lon + 180) / 360, (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2


def lonlat(x, y):
    """The inverse of world_xy."""
    return x * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y))))


def plan(bbox):
    """(zoom, x0, y0, x1, y1) tile range covering the padded bbox [w, s, e, n], or None for a bbox that cannot be drawn."""
    if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4 and all(isinstance(v, (int, float)) for v in bbox)):
        return None
    w, s, e, n = bbox
    if w > e or s > n:
        return None
    ax, ay = world_xy(w, n)
    bx, by = world_xy(e, s)
    cx, cy = (ax + bx) / 2, (ay + by) / 2
    sx, sy = max(bx - ax, MIN_SPAN), max(by - ay, MIN_SPAN)
    half_w = max(sx, sy * WIDE) * PAD / 2
    half_h = max(sy, sx / TALL) * PAD / 2
    x0, x1 = max(0.0, cx - half_w), min(1.0, cx + half_w)
    y0, y1 = max(0.0, cy - half_h), min(1.0, cy + half_h)
    z = MAX_ZOOM
    while z > 0 and max(x1 - x0, y1 - y0) * TILE * 2 ** z > MAX_EDGE:
        z -= 1
    n_tiles = 2 ** z
    return (z, int(x0 * n_tiles), int(y0 * n_tiles),
            min(n_tiles - 1, int(x1 * n_tiles)), min(n_tiles - 1, int(y1 * n_tiles)))


def asset_name(p):
    return hashlib.sha256(("%s|%d|%d|%d|%d|%d" % ((VERSION,) + tuple(p))).encode()).hexdigest() + ".jpg"


def bounds(p):
    """[[south, west], [north, east]] of the tile range's outer edges: where the picture goes on the map."""
    z, x0, y0, x1, y1 = p
    n = 2 ** z
    west, north = lonlat(x0 / n, y0 / n)
    east, south = lonlat((x1 + 1) / n, (y1 + 1) / n)
    return [[round(south, 6), round(west, 6)], [round(north, 6), round(east, 6)]]


def _fetch(url, tries=3):
    """One tile's bytes; a failed load is tried again (a build's first run asks for a few thousand tiles and a few drop)."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/*"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read()
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(1 + 2 * i)


def _make(p, dest, fetch):
    from PIL import Image
    z, x0, y0, x1, y1 = p
    jobs = [(layer, x, y) for layer in LAYERS for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
    with ThreadPoolExecutor(WORKERS) as pool:
        tiles = list(pool.map(lambda j: fetch(f"{ESRI}{j[0]}/MapServer/tile/{z}/{j[2]}/{j[1]}"), jobs))
    out = Image.new("RGB", ((x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE), (224, 224, 224))
    for (layer, x, y), raw in zip(jobs, tiles):
        with Image.open(io.BytesIO(raw)) as t:
            t = t.convert("RGBA")
            out.paste(t, ((x - x0) * TILE, (y - y0) * TILE), t)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    out.save(tmp, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    tmp.replace(dest)
    return out.size


def make(bbox, root, fetch=None):
    """The `geo.basemap` dict for a route's bbox, making the picture when it is not there yet; None when the bbox cannot
    be drawn or a tile will not load."""
    p = plan(bbox)
    if p is None:
        return None
    name = asset_name(p)
    dest = assets.asset_dir(root) / name
    z, x0, y0, x1, y1 = p
    size = ((x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE)
    if not dest.is_file():
        try:
            size = _make(p, dest, fetch or _fetch)
        except (OSError, ValueError):
            return None
    return {"asset": name, "bounds": bounds(p), "zoom": z, "width": size[0], "height": size[1]}


def attach(data, root, fetch=None):
    """Set `basemap` on every route `geo` (a dict with a bbox and a candidate) in a dataset. Returns (made or reused, failed)."""
    done = failed = 0

    def walk(o):
        nonlocal done, failed
        if isinstance(o, dict):
            g = o.get("geo")
            if isinstance(g, dict) and g.get("bbox") and g.get("candidate"):
                b = make(g["bbox"], root, fetch)
                if b:
                    g["basemap"] = b
                    done += 1
                else:
                    g.pop("basemap", None)
                    failed += 1
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data)
    return done, failed
