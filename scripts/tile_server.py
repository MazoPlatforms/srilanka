#!/usr/bin/env python3
"""
Sri Lanka Map Tile Server
=========================
Serves:
  - Vector tiles (PBF/MVT) extracted from PMTiles archives
  - Raster tiles (PNG) rendered on-the-fly from vector data
  - MapLibre GL style.json and TileJSON 3.0
  - Streets catalog JSON files (by-class, by-district, master index, custom features)
  - Routing network cells (A* navigation graph)

Compatible with:
  - Android: Google Maps Android SDK (via TileOverlay + UrlTileProvider for PNG)
  - Android: MapLibre Android SDK (via VectorSource for PBF or RasterSource for PNG)
  - Web: MapLibre GL JS, Leaflet, OpenLayers
  - iOS: MapLibre Native iOS, Apple MapKit (via MKTileOverlay)

Usage:
  pip install pmtiles pillow mapbox-vector-tile
  python scripts/tile_server.py [--port 8080] [--public public] [--host 0.0.0.0]

Endpoints:
  GET /                                     → Redirect to map viewer (index.html)
  GET /tiles/{z}/{x}/{y}.pbf                → Island-wide vector tile (MVT/PBF)
  GET /tiles/{district}/{z}/{x}/{y}.pbf     → District vector tile (MVT/PBF)
  GET /tiles/{z}/{x}/{y}.png                → Island-wide raster tile (PNG)
  GET /tiles/{district}/{z}/{x}/{y}.png     → District raster tile (PNG)
  GET /tiles/raster/{z}/{x}/{y}.png         → Standard XYZ raster tile (Google Maps SDK)
  GET /style.json                           → MapLibre GL style JSON (all districts)
  GET /tilejson.json                        → Combined TileJSON 3.0 (all districts)
  GET /tilejson/{district}.json             → TileJSON 3.0 for one district
  GET /streets/index.json                   → Streets master index
  GET /streets/by-class/{class}.json        → Street class data
  GET /streets/by-district/{district}.json  → District street data
  GET /streets/{any_subpath}.json           → Custom features / new JSON files
  GET /routing/manifest.json                → Routing manifest
  GET /routing/{path...}.json               → Any routing cell (e.g. 001/004/3148.json)
  GET /data/{path}                          → Static file passthrough
  GET /health                               → Health check (JSON)
"""

import argparse
import gzip
import io
import json
import logging
import math
import os
import sys
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# Optional dependencies (graceful fallback if not installed)
# ---------------------------------------------------------------------------
try:
    from pmtiles.reader import Reader, MmapSource  # type: ignore
    HAS_PMTILES = True
except ImportError:
    HAS_PMTILES = False

try:
    from PIL import Image, ImageDraw  # type: ignore
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    import mapbox_vector_tile  # type: ignore
    HAS_MVT = True
except ImportError:
    HAS_MVT = False

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("tile-server")

# ---------------------------------------------------------------------------
# LRU tile cache
# ---------------------------------------------------------------------------
class LRUCache:
    """Thread-safe LRU cache backed by an OrderedDict."""

    def __init__(self, capacity: int = 1000):
        self._cap = capacity
        self._store: OrderedDict = OrderedDict()
        self._lock = Lock()

    def get(self, key):
        with self._lock:
            if key not in self._store:
                return None
            self._store.move_to_end(key)
            return self._store[key]

    def put(self, key, value):
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = value
            if len(self._store) > self._cap:
                self._store.popitem(last=False)

PBF_TILE_CACHE: LRUCache = LRUCache(capacity=1000)
PNG_TILE_CACHE: LRUCache = LRUCache(capacity=1000)

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
PUBLIC_DIR: Path = Path("public")
BASE_URL: str = "http://localhost:8080"

DISTRICT_COORDS = [
    ("ampara", 7.20, 81.60), ("anuradhapura", 8.40, 80.40), ("badulla", 6.95, 81.05),
    ("batticaloa", 7.70, 81.60), ("colombo", 6.90, 79.90), ("galle", 6.10, 80.20),
    ("gampaha", 7.05, 80.05), ("hambantota", 6.25, 81.10), ("jaffna", 9.70, 80.10),
    ("kalutara", 6.55, 80.05), ("kandy", 7.30, 80.65), ("kegalle", 7.20, 80.35),
    ("kilinochchi", 9.40, 80.40), ("kurunegala", 7.60, 80.40), ("mannar", 8.90, 79.95),
    ("matale", 7.60, 80.65), ("matara", 5.98, 80.55), ("monaragala", 6.85, 81.35),
    ("mullaitivu", 9.10, 80.70), ("nuwara-eliya", 6.95, 80.75),
    ("polonnaruwa", 7.90, 81.00), ("puttalam", 8.05, 79.90),
    ("ratnapura", 6.70, 80.50), ("trincomalee", 8.60, 81.15), ("vavuniya", 8.75, 80.50),
]

ROAD_CLASSES = [
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "residential", "living_street", "unclassified", "service",
    "pedestrian", "footway", "steps", "path", "cycleway",
    "bridleway", "track", "ferry", "unknown",
]

CLASS_COLORS_HEX = {
    "motorway":     "#e44444",
    "trunk":        "#ff8800",
    "primary":      "#ffd700",
    "secondary":    "#ffffff",
    "tertiary":     "#f5f5f5",
    "residential":  "#e8e8e8",
    "living_street":"#dddddd",
    "unclassified": "#d8d8d8",
    "service":      "#cccccc",
    "pedestrian":   "#aaaaff",
    "footway":      "#aaaaaa",
    "steps":        "#999999",
    "path":         "#999999",
    "cycleway":     "#00aa44",
    "bridleway":    "#886644",
    "track":        "#b8a898",
    "ferry":        "#4488cc",
    "unknown":      "#cccccc",
}

CLASS_COLORS_RGB = {
    "motorway":     (228, 68, 68, 255),
    "trunk":        (255, 136, 0, 255),
    "primary":      (255, 215, 0, 255),
    "secondary":    (255, 255, 255, 255),
    "tertiary":     (245, 245, 245, 255),
    "residential":  (232, 232, 232, 255),
    "living_street":(221, 221, 221, 255),
    "unclassified": (216, 216, 216, 255),
    "service":      (204, 204, 204, 255),
    "pedestrian":   (170, 170, 255, 255),
    "footway":      (170, 170, 170, 255),
    "steps":        (153, 153, 153, 255),
    "path":         (153, 153, 153, 255),
    "cycleway":     (0, 170, 68, 255),
    "bridleway":    (136, 102, 68, 255),
    "track":        (184, 168, 152, 255),
    "ferry":        (68, 136, 204, 255),
    "unknown":      (204, 204, 204, 255),
}

# ---------------------------------------------------------------------------
# Coordinate & District helpers
# ---------------------------------------------------------------------------
def tile_to_lonlat(z: int, x: int, y: int) -> tuple[float, float]:
    """Calculate the geographic center (lon, lat) of tile (z, x, y)."""
    n = 1 << z
    lon = (x + 0.5) / n * 360.0 - 180.0
    lat_rad = math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 0.5) / n)))
    lat = math.degrees(lat_rad)
    return lon, lat

def tile_to_bbox(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Calculate the bounding box (west, south, east, north) for tile (z, x, y)."""
    n = 1 << z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return west, south, east, north

def find_primary_district(lon: float, lat: float) -> str:
    """Find district containing (lon, lat) using weighted Euclidean distance."""
    return min(DISTRICT_COORDS, key=lambda d: ((lon - d[2]) * 0.99) ** 2 + (lat - d[1]) ** 2)[0]

def load_districts() -> list:
    idx_path = PUBLIC_DIR / "data" / "districts.json"
    if not idx_path.exists():
        return []
    try:
        return json.loads(idx_path.read_text()).get("districts", [])
    except Exception:
        return []

# ---------------------------------------------------------------------------
# Vector Tile (PBF) Reader
# ---------------------------------------------------------------------------
def get_pbf_tile(district: str, z: int, x: int, y: int) -> bytes | None:
    """Read a single MVT/PBF tile from a district's base.pmtiles."""
    if not HAS_PMTILES:
        return None

    cache_key = f"{district}/{z}/{x}/{y}"
    cached = PBF_TILE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    pmtiles_path = PUBLIC_DIR / "data" / "districts" / district / "base.pmtiles"
    if not pmtiles_path.exists():
        return None

    try:
        with open(pmtiles_path, "rb") as fh:
            reader = Reader(MmapSource(fh))
            tile_data = reader.get(z, x, y)
    except Exception as exc:
        log.warning("PMTiles read error for %s/%d/%d/%d: %s", district, z, x, y, exc)
        return None

    if tile_data is None:
        PBF_TILE_CACHE.put(cache_key, b"")
        return b""

    PBF_TILE_CACHE.put(cache_key, tile_data)
    return tile_data

def get_island_pbf_tile(z: int, x: int, y: int) -> bytes | None:
    """Locate and return the vector tile across all 25 districts."""
    lon, lat = tile_to_lonlat(z, x, y)
    primary = find_primary_district(lon, lat)
    tile = get_pbf_tile(primary, z, x, y)
    if tile:
        return tile

    # Check other districts that overlap this tile's bbox
    w, s, e, n = tile_to_bbox(z, x, y)
    for d in load_districts():
        slug = d["slug"]
        if slug == primary:
            continue
        dw = d.get("window", [])
        if dw and len(dw) == 4:
            if not (e < dw[0] or w > dw[2] or n < dw[1] or s > dw[3]):
                t = get_pbf_tile(slug, z, x, y)
                if t:
                    return t
    return b""

# ---------------------------------------------------------------------------
# Raster Tile (PNG) Renderer
# ---------------------------------------------------------------------------
def render_pbf_to_png(pbf_bytes: bytes, z: int, x: int, y: int, size: int = 256) -> bytes:
    """Render a decoded MVT tile into a 256x256 PNG image using Pillow."""
    cache_key = f"png/{z}/{x}/{y}"
    cached = PNG_TILE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    if not HAS_PIL:
        # Fallback if Pillow is missing: return empty transparent 1x1 PNG
        return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"

    # Background color: subtle natural map land tone #e2ebdc
    img = Image.new("RGBA", (size, size), (226, 235, 220, 255))
    draw = ImageDraw.Draw(img)

    if pbf_bytes and HAS_MVT:
        try:
            raw = gzip.decompress(pbf_bytes) if pbf_bytes[:2] == b"\x1f\x8b" else pbf_bytes
            decoded = mapbox_vector_tile.decode(raw)
            extent = decoded.get("segment", {}).get("extent", 4096)
            scale = size / float(extent)

            if "segment" in decoded:
                features = decoded["segment"].get("features", [])
                # Pass 1: Road casings / underlay
                for feat in features:
                    cls = feat.get("properties", {}).get("class", "residential")
                    geom = feat.get("geometry", {})
                    lines = [geom["coordinates"]] if geom.get("type") == "LineString" else geom.get("coordinates", [])
                    casing_width = 4 if cls in ("motorway", "trunk") else (3 if cls == "primary" else 2)
                    for line in lines:
                        pts = [(round(p[0] * scale), round(p[1] * scale)) for p in line]
                        if len(pts) > 1:
                            draw.line(pts, fill=(183, 190, 178, 255), width=casing_width)

                # Pass 2: Road colored center lines
                for feat in features:
                    cls = feat.get("properties", {}).get("class", "residential")
                    color = CLASS_COLORS_RGB.get(cls, (230, 230, 230, 255))
                    line_w = 3 if cls in ("motorway", "trunk") else (2 if cls == "primary" else 1)
                    geom = feat.get("geometry", {})
                    lines = [geom["coordinates"]] if geom.get("type") == "LineString" else geom.get("coordinates", [])
                    for line in lines:
                        pts = [(round(p[0] * scale), round(p[1] * scale)) for p in line]
                        if len(pts) > 1:
                            draw.line(pts, fill=color, width=line_w)

        except Exception as exc:
            log.debug("PNG render warning for %d/%d/%d: %s", z, x, y, exc)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    PNG_TILE_CACHE.put(cache_key, png_bytes)
    return png_bytes

# ---------------------------------------------------------------------------
# Style & TileJSON generators
# ---------------------------------------------------------------------------
def build_style_json(base_url: str) -> dict:
    districts = load_districts()
    sources: dict = {}
    layers: list = [{"id": "bg", "type": "background", "paint": {"background-color": "#e2ebdc"}}]

    # Island-wide combined source
    sources["srilanka_streets"] = {
        "type": "vector",
        "tiles": [f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.pbf"],
        "minzoom": 0,
        "maxzoom": 14,
        "attribution": "© OpenStreetMap contributors · Mazo Maps",
    }

    # Per-district sources
    for d in districts:
        slug = d["slug"]
        sources[f"sl_{slug}"] = {
            "type": "vector",
            "tiles": [f"{base_url}/tiles/{slug}/{{z}}/{{x}}/{{y}}.pbf"],
            "minzoom": 0,
            "maxzoom": 14,
            "attribution": "© OpenStreetMap contributors · Mazo Maps",
        }

    # Road casing
    layers.append({
        "id": "road-casing",
        "type": "line",
        "source": "srilanka_streets",
        "source-layer": "segment",
        "filter": ["==", ["get", "subtype"], "road"],
        "layout": {"line-cap": "round", "line-join": "round"},
        "paint": {
            "line-color": "#b7beb2",
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 14, 3],
        },
    })

    # Road fills ordered from local to highway
    for cls in ROAD_CLASSES:
        color = CLASS_COLORS_HEX.get(cls, "#ffffff")
        w_vals = [8, 0.5, 14, 2]
        if cls in ("motorway", "trunk"):
            w_vals = [8, 2.0, 14, 7]
        elif cls == "primary":
            w_vals = [8, 1.2, 14, 5]
        elif cls in ("secondary", "tertiary"):
            w_vals = [8, 0.8, 14, 3.5]

        layers.append({
            "id": f"road-{cls}",
            "type": "line",
            "source": "srilanka_streets",
            "source-layer": "segment",
            "filter": ["all", ["==", ["get", "subtype"], "road"], ["==", ["get", "class"], cls]],
            "layout": {"line-cap": "round", "line-join": "round"},
            "paint": {
                "line-color": color,
                "line-width": ["interpolate", ["linear"], ["zoom"], w_vals[0], w_vals[1], w_vals[2], w_vals[3]],
            },
        })

    return {
        "version": 8,
        "name": "Sri Lanka Streets Map",
        "glyphs": f"{base_url}/fonts/{{fontstack}}/{{range}}.pbf",
        "sources": sources,
        "layers": layers,
        "metadata": {
            "built": time.strftime("%Y-%m-%d"),
            "generator": "srilanka-tile-server",
            "vector_pbf_url": f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.pbf",
            "raster_png_url": f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.png",
        },
    }

def build_combined_tilejson(base_url: str) -> dict:
    return {
        "tilejson": "3.0.0",
        "name": "Sri Lanka Map (All Streets)",
        "description": "Full vector & raster tiles for all Sri Lanka streets, compatible with Android SDK & Web",
        "version": "1.0.0",
        "attribution": "© OpenStreetMap contributors · Mazo Maps",
        "scheme": "xyz",
        "tiles": [f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.pbf"],
        "raster_tiles": [f"{base_url}/tiles/{{z}}/{{x}}/{{y}}.png"],
        "minzoom": 0,
        "maxzoom": 14,
        "bounds": [79.4, 5.8, 82.0, 9.95],
        "center": [80.7, 7.87, 8],
    }

# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------
class TileHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log.info("%-15s  %s", self.address_string(), fmt % args)

    def _cors_headers(self):
        return {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        }

    def _send(self, status: int, content_type: str, body: bytes, extra_headers: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self._send(status, "application/json; charset=utf-8", body)

    def _send_file(self, path: Path, content_type: str):
        if not path.exists():
            self._send_json(404, {"error": "not found", "path": str(path)})
            return
        file_size = path.stat().st_size
        range_header = self.headers.get("Range")
        if range_header and range_header.startswith("bytes="):
            spec = range_header[6:].split(",")[0].strip()
            if "-" in spec:
                s, e = spec.split("-", 1)
                start = int(s) if s else max(0, file_size - int(e))
                end = min(file_size - 1, int(e)) if e else (file_size - 1)
                if 0 <= start <= end < file_size:
                    length = end - start + 1
                    with open(path, "rb") as f:
                        f.seek(start)
                        chunk = f.read(length)
                    self._send(206, content_type, chunk, {
                        "Content-Range": f"bytes {start}-{end}/{file_size}",
                        "Accept-Ranges": "bytes",
                    })
                    return
        self._send(200, content_type, path.read_bytes(), {"Accept-Ranges": "bytes"})

    def _not_found(self, msg: str = "not found"):
        self._send_json(404, {"error": msg})

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in self._cors_headers().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        qs = parse_qs(parsed.query)
        base_url = qs.get("base_url", [BASE_URL])[0].rstrip("/")

        try:
            self._route(path, base_url)
        except BrokenPipeError:
            pass
        except Exception as exc:
            log.exception("Unhandled error for %s: %s", path, exc)
            try:
                self._send_json(500, {"error": str(exc)})
            except Exception:
                pass

    def _route(self, path: str, base_url: str):
        parts = path.lstrip("/").split("/")

        # --- root → redirect to map viewer ----------------------------------
        if path == "/":
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.end_headers()
            return

        # --- health check ---------------------------------------------------
        if path == "/health":
            self._send_json(200, {
                "status": "ok",
                "time": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "pbf_cache_size": len(PBF_TILE_CACHE._store),
                "png_cache_size": len(PNG_TILE_CACHE._store),
                "pmtiles_available": HAS_PMTILES,
                "pil_available": HAS_PIL,
                "mvt_available": HAS_MVT,
            })
            return

        # --- static frontend files ------------------------------------------
        if path in ("/index.html", "/routing.js") or path.startswith(("/vendor/", "/fonts/", "/sdk/")):
            self._send_file(PUBLIC_DIR / path.lstrip("/"), self._mime(path))
            return

        # --- MapLibre style JSON --------------------------------------------
        if path == "/style.json":
            self._send_json(200, build_style_json(base_url))
            return

        # --- TileJSON -------------------------------------------------------
        if path == "/tilejson.json":
            self._send_json(200, build_combined_tilejson(base_url))
            return

        # --- 1) Island-wide Vector Tile: /tiles/{z}/{x}/{y}.pbf --------------
        if len(parts) == 4 and parts[0] == "tiles" and parts[3].endswith(".pbf"):
            _, z_s, x_s, y_pbf = parts
            try:
                z, x, y = int(z_s), int(x_s), int(y_pbf[:-4])
            except ValueError:
                self._not_found("invalid tile coordinates")
                return
            tile = get_island_pbf_tile(z, x, y)
            if not tile:
                self._send(204, "application/x-protobuf", b"")
                return
            self._send(200, "application/x-protobuf", tile,
                       {"Content-Encoding": "gzip", "Cache-Control": "public, max-age=86400"})
            return

        # --- 2) Per-district Vector Tile: /tiles/{district}/{z}/{x}/{y}.pbf --
        if len(parts) == 5 and parts[0] == "tiles" and parts[4].endswith(".pbf"):
            _, district, z_s, x_s, y_pbf = parts
            try:
                z, x, y = int(z_s), int(x_s), int(y_pbf[:-4])
            except ValueError:
                self._not_found("invalid tile coordinates")
                return
            tile = get_pbf_tile(district, z, x, y)
            if tile is None:
                self._not_found("district not found")
                return
            if not tile:
                self._send(204, "application/x-protobuf", b"")
                return
            self._send(200, "application/x-protobuf", tile,
                       {"Content-Encoding": "gzip", "Cache-Control": "public, max-age=86400"})
            return

        # --- 3) Island-wide Raster Tile: /tiles/{z}/{x}/{y}.png --------------
        #     Also supports /tiles/raster/{z}/{x}/{y}.png for Google Maps SDK
        if (len(parts) == 4 and parts[0] == "tiles" and parts[3].endswith(".png")) or \
           (len(parts) == 5 and parts[0] == "tiles" and parts[1] == "raster" and parts[4].endswith(".png")):
            z_s = parts[1] if len(parts) == 4 else parts[2]
            x_s = parts[2] if len(parts) == 4 else parts[3]
            y_png = parts[3] if len(parts) == 4 else parts[4]
            try:
                z, x, y = int(z_s), int(x_s), int(y_png[:-4])
            except ValueError:
                self._not_found("invalid tile coordinates")
                return
            pbf = get_island_pbf_tile(z, x, y) or b""
            png = render_pbf_to_png(pbf, z, x, y)
            self._send(200, "image/png", png, {"Cache-Control": "public, max-age=86400"})
            return

        # --- 4) Per-district Raster Tile: /tiles/{district}/{z}/{x}/{y}.png --
        if len(parts) == 5 and parts[0] == "tiles" and parts[1] != "raster" and parts[4].endswith(".png"):
            _, district, z_s, x_s, y_png = parts
            try:
                z, x, y = int(z_s), int(x_s), int(y_png[:-4])
            except ValueError:
                self._not_found("invalid tile coordinates")
                return
            pbf = get_pbf_tile(district, z, x, y) or b""
            png = render_pbf_to_png(pbf, z, x, y)
            self._send(200, "image/png", png, {"Cache-Control": "public, max-age=86400"})
            return

        # --- 5) Streets data & custom features -------------------------------
        # Supports /streets/index.json, /streets/by-class/..., /streets/by-district/...,
        # and ANY new custom JSON files in public/data/streets/ or subfolders!
        if parts[0] == "streets":
            subpath = Path(*parts[1:])
            target_file = PUBLIC_DIR / "data" / "streets" / subpath
            if target_file.suffix != ".json" and not target_file.suffix:
                target_file = target_file.with_suffix(".json")
            self._send_file(target_file, "application/json; charset=utf-8")
            return

        # --- 6) Routing data: manifest and all nested JSON cells --------------
        # Handles /routing/manifest.json and /routing/001/004/3148.json
        if parts[0] == "routing":
            subpath = Path(*parts[1:])
            target_file = PUBLIC_DIR / "data" / "routing" / subpath
            self._send_file(target_file, "application/json; charset=utf-8")
            return

        # --- 7) Generic static data passthrough ------------------------------
        if parts[0] == "data":
            rel = Path(*parts)
            self._send_file(PUBLIC_DIR / rel, self._mime(str(rel)))
            return

        self._not_found()

    @staticmethod
    def _mime(path: str) -> str:
        path = path.lower()
        if path.endswith(".json"):    return "application/json; charset=utf-8"
        if path.endswith(".pbf"):     return "application/x-protobuf"
        if path.endswith(".png"):     return "image/png"
        if path.endswith(".html"):    return "text/html; charset=utf-8"
        if path.endswith(".js"):      return "application/javascript; charset=utf-8"
        if path.endswith(".css"):     return "text/css; charset=utf-8"
        if path.endswith(".pmtiles"): return "application/octet-stream"
        return "application/octet-stream"

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    global PUBLIC_DIR, BASE_URL

    parser = argparse.ArgumentParser(description="Sri Lanka Map Tile Server")
    parser.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8080, help="Bind port (default: 8080)")
    parser.add_argument("--public", default="public", help="Path to public/ directory")
    parser.add_argument("--base-url", default="", help="Public base URL (auto-detected if empty)")
    parser.add_argument("--cache-size", type=int, default=1000, help="Tile LRU cache size")
    args = parser.parse_args()

    PUBLIC_DIR = Path(args.public).resolve()
    if not PUBLIC_DIR.exists():
        log.error("Public directory not found: %s", PUBLIC_DIR)
        sys.exit(1)

    BASE_URL = args.base_url or f"http://{args.host if args.host != '0.0.0.0' else 'localhost'}:{args.port}"
    PBF_TILE_CACHE._cap = args.cache_size
    PNG_TILE_CACHE._cap = args.cache_size

    districts = load_districts()
    log.info("Loaded %d districts from %s", len(districts), PUBLIC_DIR / "data" / "districts.json")
    log.info("Starting tile server on %s:%d (base_url=%s)", args.host, args.port, BASE_URL)
    log.info("PBF Vector & PNG Raster tile support: ACTIVE")

    server = HTTPServer((args.host, args.port), TileHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down.")
        server.server_close()

if __name__ == "__main__":
    main()
