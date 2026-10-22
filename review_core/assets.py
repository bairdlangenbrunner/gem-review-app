"""
Pictures a review page shows (map snapshots, trace overlays) kept out of the page itself (docs/plan.md, "Geo").

A source image is copied once to <root>/work/review_assets/<sha256 of the source file>.<ext>, the name the
dataset carries as `images[].asset`:

    a PNG that is at most LONG_EDGE px on its long edge and at most PNG_KEEP bytes  -> copied as it is (.png)
    any other PNG                                                                  -> downscaled, kept as PNG when that is under PNG_KEEP bytes
    everything else (and a downscaled PNG still too big)                           -> JPEG, long edge LONG_EDGE, quality QUALITY, transparency over white

The loopback server serves that folder at /asset/<name>. The artifact page cannot reach it: the files go up as
assets of the page (Artifact tool, `asset: true`) and the manifest records what each upload returned, per page,
because an uploaded asset belongs to one artifact:

    {"<sha256>": {"<artifact url>": {"url": "...", "uploaded": "2026-10-22", "bytes": 123456}}}

The manifest lives in the researcher repo (pipelines: review_app/assets.json, committed) so any session's
rebuild reuses the uploads. Pillow is needed only to make a copy.
"""
import hashlib
import json
import re
import shutil
from datetime import date
from pathlib import Path

ASSET_DIR = Path("work") / "review_assets"
LONG_EDGE = 1600
QUALITY = 80
PNG_KEEP = 1_000_000
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff", ".bmp"}
ASSET_RE = re.compile(r"^[0-9a-f]{64}\.(jpg|png)$")
MAX_PIXELS = 600_000_000       # scanned wall maps run to a few hundred megapixels; Pillow's default refuses them


def asset_dir(root):
    return Path(root) / ASSET_DIR


def is_image(path):
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


def source_sha(path, cache=None):
    """sha256 of the source file ('' when missing). A pages.FileCache skips the read when size and mtime are unchanged."""
    def read(p):
        p = Path(p)
        if not p.is_file():
            return ""
        h = hashlib.sha256()
        with p.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    return read(path) if cache is None else cache.file("asset-sha", path, read)


def existing(sha, root):
    """The asset name already made for this source sha, or ''."""
    d = asset_dir(root)
    for ext in ("png", "jpg"):
        if (d / f"{sha}.{ext}").is_file():
            return f"{sha}.{ext}"
    return ""


def _flat(img):
    from PIL import Image
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        return bg
    return img.convert("RGB")


def _make(src, sha, out_dir):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = max(Image.MAX_IMAGE_PIXELS or 0, MAX_PIXELS)
    out_dir.mkdir(parents=True, exist_ok=True)
    size = src.stat().st_size
    with Image.open(src) as img:
        png = (img.format or "").upper() == "PNG"
        if png and max(img.size) <= LONG_EDGE and size <= PNG_KEEP:
            dest = out_dir / f"{sha}.png"
            shutil.copyfile(src, dest)
            return dest
        if img.format == "JPEG":
            img.draft("RGB", (LONG_EDGE, LONG_EDGE))      # decode at a reduced scale: fast on huge scans
        img.load()
        small = img.copy()
        small.thumbnail((LONG_EDGE, LONG_EDGE), Image.LANCZOS)
    if png:
        tmp = out_dir / f"{sha}.png.part"
        small.save(tmp, "PNG", optimize=True)
        if tmp.stat().st_size <= PNG_KEEP:
            dest = out_dir / f"{sha}.png"
            tmp.replace(dest)
            return dest
        tmp.unlink()
    tmp = out_dir / f"{sha}.jpg.part"
    _flat(small).save(tmp, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    dest = out_dir / f"{sha}.jpg"
    tmp.replace(dest)
    return dest


def prepare(src, root, cache=None):
    """{"asset", "width", "height", "bytes"} for one source image, making the copy when it is not there yet; None when
    the source is missing, is not an image, or cannot be read."""
    src = Path(src)
    if not src.is_file() or not is_image(src):
        return None
    sha = source_sha(src, cache)
    name = existing(sha, root)
    try:
        dest = asset_dir(root) / name if name else _make(src, sha, asset_dir(root))
        from PIL import Image
        with Image.open(dest) as im:
            w, h = im.size
    except (OSError, ValueError, SyntaxError):
        return None
    return {"asset": dest.name, "width": w, "height": h, "bytes": dest.stat().st_size}


def load_manifest(path):
    p = Path(path)
    if not p.is_file():
        return {}
    return json.loads(p.read_text(encoding="utf-8") or "{}")


def save_manifest(path, manifest):
    text = json.dumps({k: manifest[k] for k in sorted(manifest)}, indent=1, sort_keys=True, ensure_ascii=False)
    Path(path).write_text(text + "\n", encoding="utf-8")


def _sha(asset):
    return str(asset).split(".", 1)[0]


def url_for(manifest, asset, artifact):
    """The uploaded url of `asset` (a name like <sha>.jpg) on page `artifact`, or ''."""
    return ((manifest.get(_sha(asset)) or {}).get(artifact) or {}).get("url", "")


def record(path, artifact, uploads, root=None, today=None):
    """Write upload results into the manifest at `path`: uploads is {asset name: url} for page `artifact`. Returns the count written."""
    m = load_manifest(path)
    n = 0
    for asset, url in uploads.items():
        if not ASSET_RE.match(str(asset)) or not url:
            raise ValueError(f"not an asset name and url: {asset!r} {url!r}")
        f = asset_dir(root) / asset if root else None
        entry = {"url": url, "uploaded": today or date.today().isoformat()}
        if f is not None and f.is_file():
            entry["bytes"] = f.stat().st_size
        m.setdefault(_sha(asset), {})[artifact] = entry
        n += 1
    save_manifest(path, m)
    return n


def images_in(obj):
    """Every image dict (one carrying an `asset` name) anywhere in a dataset, in order."""
    out = []

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("asset"), str) and ASSET_RE.match(o["asset"]):
                out.append(o)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(obj)
    return out


def fill_urls(obj, manifest, artifact):
    """Set `url` on every image in the dataset that page `artifact` has uploaded; returns the asset names still missing."""
    missing = []
    for img in images_in(obj):
        u = url_for(manifest, img["asset"], artifact)
        if u:
            img["url"] = u
        else:
            img.pop("url", None)
            if img["asset"] not in missing:
                missing.append(img["asset"])
    return missing


def missing(assets, manifest, artifact):
    """The asset names in `assets` that page `artifact` has not uploaded, in order, once each."""
    out = []
    for a in assets:
        if a not in out and not url_for(manifest, a, artifact):
            out.append(a)
    return out
