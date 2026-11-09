# Sri Lanka Streets Data

This directory contains a structured catalog of all road/street classes across all 25 Sri Lanka districts, derived from Overture Maps routing data.

## Directory Layout

```
public/data/streets/
├── index.json              ← Master streets registry (start here)
├── README.md               ← This file
├── by-class/               ← One JSON file per road class
│   ├── motorway.json
│   ├── trunk.json
│   ├── primary.json
│   └── ...
└── by-district/            ← One JSON file per district
    ├── colombo.json
    ├── gampaha.json
    └── ...
```

## File Schemas

### `index.json`

| Field | Type | Description |
|-------|------|-------------|
| `schema` | `int` | Schema version (currently `1`) |
| `built` | `string` | ISO 8601 date the index was last built |
| `total_segments` | `int` | Total road segments across all districts |
| `total_edges` | `int` | Total directed graph edges |
| `bbox` | `[w,s,e,n]` | Bounding box of all data |
| `classes` | `string[]` | All road-class identifiers |
| `districts` | `object[]` | Per-district segment counts |
| `data_sources` | `object` | URL templates for related resources |

### `by-class/{class}.json`

| Field | Type | Description |
|-------|------|-------------|
| `class` | `string` | Road class identifier |
| `description` | `string` | Human-readable description |
| `osm_equivalent` | `string` | Equivalent OSM tag |
| `modes` | `string[]` | Allowed travel modes |
| `speed_kmh` | `object` | Typical and maximum speeds |
| `districts` | `object` | Per-district segment counts keyed by slug |
| `total_segments` | `int` | Total segments of this class |

### `by-district/{district}.json`

| Field | Type | Description |
|-------|------|-------------|
| `slug` | `string` | District identifier |
| `name` | `string` | Human-readable district name |
| `total_segments` | `int` | Total segments in this district |
| `bbox` | `[w,s,e,n]` | District bounding box |
| `classes` | `object` | Segment count per road class |
| `data_files` | `object` | Paths to associated PMTiles and routing cells |

## How to Add New Data

### Adding a New Road Class

1. Create `by-class/{new-class}.json` following the schema above.
2. Add the class name to the `classes` array in `index.json`.
3. Update every `by-district/*.json` to include the new class key in `classes`.
4. Run the GitHub Actions workflow `build-sri-lanka-streets.yml` to validate.

### Adding a New District

1. Create `by-district/{new-slug}.json` following the schema above.
2. Add an entry to the `districts` array in `index.json`.
3. Add the new district to every `by-class/*.json` under the `districts` object.
4. Update `public/data/districts.json` (via the district build workflow).

### Rebuilding from Source

The streets index is derived automatically from:
- `public/data/routing/manifest.json` — segment/edge counts and class list
- `public/data/districts.json` — per-district segment counts and bounding boxes

To rebuild:

```bash
# Trigger the GitHub Actions workflow:
gh workflow run build-sri-lanka-streets.yml

# Or regenerate locally using the build script:
python scripts/build_osm_map.py --export-streets-only
```

## Road Class Reference

| Class | OSM Tag | Typical Speed | Allowed Modes |
|-------|---------|---------------|---------------|
| `motorway` | `highway=motorway` | 100 km/h | car, motorcycle, truck, bus |
| `trunk` | `highway=trunk` | 80 km/h | all |
| `primary` | `highway=primary` | 60 km/h | all |
| `secondary` | `highway=secondary` | 50 km/h | all |
| `tertiary` | `highway=tertiary` | 40 km/h | all |
| `residential` | `highway=residential` | 30 km/h | car, motorcycle, truck, bus, bike |
| `living_street` | `highway=living_street` | 10 km/h | all |
| `unclassified` | `highway=unclassified` | 30 km/h | all |
| `service` | `highway=service` | 20 km/h | all |
| `pedestrian` | `highway=pedestrian` | 5 km/h | foot, bike, wheelchair |
| `footway` | `highway=footway` | 5 km/h | foot, wheelchair |
| `steps` | `highway=steps` | 3 km/h | foot |
| `path` | `highway=path` | 5 km/h | foot, bike |
| `cycleway` | `highway=cycleway` | 20 km/h | bike, foot |
| `bridleway` | `highway=bridleway` | 15 km/h | bike, foot |
| `track` | `highway=track` | 20 km/h | all |
| `ferry` | `route=ferry` | 30 km/h | all |
| `unknown` | *(various)* | 20 km/h | all |

## 100% Frontend Only Architecture (GitHub Pages)

This entire platform is **100% frontend only**, hosted statically on GitHub Pages with ZERO backend server required:

* **Static Hosting**: All JSON files in `public/data/streets/` and `public/data/routing/` are served directly as static files by GitHub Pages with native CORS enabled.
* **Adding New JSON Files**: You can create new `.json` files in `public/data/streets/by-class/`, `public/data/streets/by-district/`, or new custom subfolders (e.g. `public/data/streets/custom/my_features.json`). As soon as you commit and push to `main`, GitHub Pages automatically publishes them at `https://<owner>.github.io/<repo>/data/streets/...`.
* **Zero Backend Costs**: No servers to manage, no server downtime, and no monthly hosting bills.

## Developer Tile Server (Optional)

For local development or offline proxying, an optional local Python tile server is included:

```bash
python scripts/tile_server.py --port 8080
```
