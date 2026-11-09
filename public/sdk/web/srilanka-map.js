/**
 * srilanka-map.js  —  Sri Lanka Map Web SDK
 *
 * A lightweight ES-module wrapper around MapLibre GL JS that provides a
 * high-level API for Sri Lanka vector maps, street-class filtering, A*
 * routing, and place search.
 *
 * Usage:
 *   import { SriLankaMap } from './srilanka-map.js';
 *   const map = new SriLankaMap({ container: 'map', tileServer: 'http://localhost:8080' });
 *   map.on('ready', () => {
 *     map.showStreets(['motorway', 'primary']);
 *     map.search('Colombo Fort');
 *     map.route({ from: [79.86, 6.93], to: [80.63, 7.29], mode: 'car' });
 *   });
 *
 * Requirements:
 *   - MapLibre GL JS (loaded globally as `maplibregl`) or via import map
 *   - pmtiles.js (optional — for direct PMTiles protocol support)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BBOX        = [79.4, 5.8, 82.0, 9.95];
const CENTER      = [80.7, 7.87];
const DEFAULT_ZOOM = 8;

const DISTRICTS = [
  'ampara','anuradhapura','badulla','batticaloa','colombo',
  'galle','gampaha','hambantota','jaffna','kalutara',
  'kandy','kegalle','kilinochchi','kurunegala','mannar',
  'matale','matara','monaragala','mullaitivu','nuwara-eliya',
  'polonnaruwa','puttalam','ratnapura','trincomalee','vavuniya',
];

const ROAD_CLASSES = [
  'motorway','trunk','primary','secondary','tertiary',
  'residential','living_street','unclassified','service',
  'pedestrian','footway','steps','path','cycleway',
  'bridleway','track','ferry','unknown',
];

const CLASS_COLORS = {
  motorway:      '#e44',
  trunk:         '#f80',
  primary:       '#f6cf8a',
  secondary:     '#ffd',
  tertiary:      '#ffe',
  residential:   '#fff',
  living_street: '#ddd',
  unclassified:  '#ccc',
  service:       '#bbb',
  pedestrian:    '#aaa',
  footway:       '#999',
  steps:         '#888',
  path:          '#777',
  cycleway:      '#6af',
  bridleway:     '#a84',
  track:         '#964',
  ferry:         '#0af',
  unknown:       '#ccc',
};

const CLASS_WIDTHS = {
  motorway:  [8, 1.5, 14, 7],
  trunk:     [8, 1,   14, 6],
  primary:   [8, 0.7, 14, 5],
  secondary: [9, 0.5, 14, 4],
  tertiary:  [10,0.4, 14, 3],
};

// ---------------------------------------------------------------------------
// SriLankaMap class
// ---------------------------------------------------------------------------

export class SriLankaMap extends EventTarget {
  /**
   * @param {object} options
   * @param {string}  options.container   - DOM element ID or HTMLElement
   * @param {string}  [options.tileServer='http://localhost:8080'] - Tile server base URL
   * @param {string}  [options.style]     - Custom MapLibre style URL (overrides auto-build)
   * @param {number}  [options.zoom]      - Initial zoom
   * @param {number[]}[options.center]    - Initial [lng, lat]
   * @param {boolean} [options.hash=true] - Sync map state with URL hash
   * @param {boolean} [options.routing=true] - Enable routing integration
   */
  constructor(options = {}) {
    super();

    this._opts = {
      tileServer: 'http://localhost:8080',
      zoom:       DEFAULT_ZOOM,
      center:     CENTER,
      hash:       true,
      routing:    true,
      ...options,
    };

    this._base   = this._opts.tileServer.replace(/\/$/, '');
    this._map    = null;
    this._route  = null;          // current route GeoJSON source
    this._popup  = null;
    this._shards = new Map();     // search shard cache
    this._layers = new Set();     // added layer ids

    this._init();
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  async _init() {
    // Wait for maplibregl global (supports both CDN and module bundler setups)
    const mgl = await this._waitForMapLibre();

    // Register pmtiles protocol if library is available
    if (typeof pmtiles !== 'undefined') {
      mgl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
    }

    const styleUrl = this._opts.style || `${this._base}/style.json`;

    this._map = new mgl.Map({
      container:  this._opts.container,
      style:      styleUrl,
      hash:       this._opts.hash,
      minZoom:    6,
      maxBounds:  [[BBOX[0] - 0.5, BBOX[1] - 0.5], [BBOX[2] + 0.5, BBOX[3] + 0.5]],
      center:     this._opts.center,
      zoom:       this._opts.zoom,
    });

    this._map.on('error', ev => {
      this.dispatchEvent(Object.assign(new Event('error'), { detail: ev }));
    });

    this._map.on('load', () => {
      this._ensureDistrictSources();
      this._addDefaultLayers();
      this.dispatchEvent(new Event('ready'));
    });
  }

  _waitForMapLibre(retries = 50) {
    return new Promise((resolve, reject) => {
      const check = (n) => {
        if (typeof maplibregl !== 'undefined') return resolve(maplibregl);
        if (n <= 0) return reject(new Error('maplibregl not found. Load it before srilanka-map.js'));
        setTimeout(() => check(n - 1), 100);
      };
      check(retries);
    });
  }

  _ensureDistrictSources() {
    for (const slug of DISTRICTS) {
      const id = `sl_${slug}`;
      if (this._map.getSource(id)) continue;
      this._map.addSource(id, {
        type:        'vector',
        tiles:       [`${this._base}/tiles/${slug}/{z}/{x}/{y}.pbf`],
        minzoom:     0,
        maxzoom:     14,
        attribution: '© Overture Maps Foundation',
      });
    }
  }

  _addDefaultLayers() {
    // Road casings (all districts)
    for (const slug of DISTRICTS) {
      this._addLayer({
        id:           `sl-casing-${slug}`,
        type:         'line',
        source:       `sl_${slug}`,
        'source-layer': 'segment',
        filter:       ['==', ['get', 'subtype'], 'road'],
        layout:       { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#b7beb2',
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 3],
        },
      });
    }
    // Major roads by default
    this.showStreets(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
  }

  _addLayer(spec) {
    if (this._map.getLayer(spec.id)) return;
    this._map.addLayer(spec);
    this._layers.add(spec.id);
  }

  // -------------------------------------------------------------------------
  // Public API: event emitter shortcuts
  // -------------------------------------------------------------------------

  /** Register a one-shot or persistent event listener. */
  on(event, handler) {
    this.addEventListener(event, handler);
    return this;
  }

  off(event, handler) {
    this.removeEventListener(event, handler);
    return this;
  }

  // -------------------------------------------------------------------------
  // Public API: Street layers
  // -------------------------------------------------------------------------

  /**
   * Show (and add if not present) layers for the specified road classes.
   * @param {string[]} classes - e.g. ['motorway', 'primary']
   */
  showStreets(classes) {
    for (const cls of classes) {
      for (const slug of DISTRICTS) {
        const id = `sl-${cls}-${slug}`;
        if (!this._map.getLayer(id)) {
          const color = CLASS_COLORS[cls] || '#ccc';
          const w = CLASS_WIDTHS[cls];
          const widthExpr = w
            ? ['interpolate', ['linear'], ['zoom'], w[0], w[1], w[2], w[3]]
            : 1.5;
          this._addLayer({
            id,
            type:           'line',
            source:         `sl_${slug}`,
            'source-layer': 'segment',
            filter: ['all',
              ['==', ['get', 'subtype'], 'road'],
              ['==', ['get', 'class'],   cls],
            ],
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:  { 'line-color': color, 'line-width': widthExpr },
          });
        } else {
          this._map.setLayoutProperty(id, 'visibility', 'visible');
        }
      }
    }
    return this;
  }

  /**
   * Hide layers for the specified road classes.
   * @param {string[]} classes
   */
  hideStreets(classes) {
    for (const cls of classes) {
      for (const slug of DISTRICTS) {
        const id = `sl-${cls}-${slug}`;
        if (this._map.getLayer(id)) {
          this._map.setLayoutProperty(id, 'visibility', 'none');
        }
      }
    }
    return this;
  }

  /** Toggle a road class layer on/off. Returns the new visibility state. */
  toggleStreets(cls) {
    const id = `sl-${cls}-${DISTRICTS[0]}`;
    const vis = this._map.getLayoutProperty(id, 'visibility');
    if (vis === 'none') {
      this.showStreets([cls]); return true;
    } else {
      this.hideStreets([cls]); return false;
    }
  }

  // -------------------------------------------------------------------------
  // Public API: Routing
  // -------------------------------------------------------------------------

  /**
   * Request and draw a route.
   *
   * @param {object}   opts
   * @param {number[]} opts.from   - [lon, lat] origin
   * @param {number[]} opts.to     - [lon, lat] destination
   * @param {string}   [opts.mode='car']
   * @returns {Promise<object|null>} Route GeoJSON Feature
   */
  async route({ from, to, mode = 'car' } = {}) {
    const url = `${this._base}/routing/route.json` +
      `?from=${from.join(',')}&to=${to.join(',')}&mode=${encodeURIComponent(mode)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._drawRoute(data);
      this.dispatchEvent(Object.assign(new Event('route'), { detail: data }));
      return data;
    } catch (err) {
      this.dispatchEvent(Object.assign(new Event('error'), { detail: err }));
      return null;
    }
  }

  _drawRoute(data) {
    this.clearRoute();
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: data.coordinates || [] },
        properties: { mode: data.mode, distance_km: data.distance_km },
      }],
    };
    this._map.addSource('sl-route', { type: 'geojson', data: geojson });
    this._map.addLayer({
      id: 'sl-route-line', type: 'line', source: 'sl-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#007aff', 'line-width': 5, 'line-opacity': 0.9 },
    });
    this._map.addLayer({
      id: 'sl-route-casing', type: 'line', source: 'sl-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#fff', 'line-width': 9, 'line-opacity': 0.4 },
    }, 'sl-route-line');
  }

  /** Remove the route polyline from the map. */
  clearRoute() {
    for (const id of ['sl-route-line', 'sl-route-casing']) {
      if (this._map.getLayer(id)) this._map.removeLayer(id);
    }
    if (this._map.getSource('sl-route')) this._map.removeSource('sl-route');
  }

  // -------------------------------------------------------------------------
  // Public API: Search
  // -------------------------------------------------------------------------

  /**
   * Search places by name.
   *
   * @param {string} query
   * @param {number} [limit=8]
   * @returns {Promise<Array>} Array of [name, lon, lat, id, folder, districtIdx]
   */
  async search(query, limit = 8) {
    const SEP = /[\s,.;:()\[\]/\\-_&'"]+/;
    const tokens = query.toLowerCase().split(SEP).filter(t => [...t].length >= 2);
    const lead = tokens.find(t => [...t].length >= 2);
    if (!lead) return [];

    const cps = [...lead].slice(0, 2).map(c => c.codePointAt(0).toString(16));
    const key = cps.join('-');

    if (!this._shards.has(key)) {
      try {
        const r = await fetch(`${this._base}/data/search/${key}.json`);
        this._shards.set(key, r.ok ? await r.json() : []);
      } catch { this._shards.set(key, []); }
    }

    const hits = (this._shards.get(key) || [])
      .filter(x => tokens.every(t => x[0].toLowerCase().includes(t)))
      .slice(0, limit);

    this.dispatchEvent(Object.assign(new Event('search'), { detail: { query, hits } }));
    return hits;
  }

  // -------------------------------------------------------------------------
  // Public API: Data fetching
  // -------------------------------------------------------------------------

  /** Fetch the streets master index. */
  async getStreetsIndex() {
    return this._fetchJson(`${this._base}/streets/index.json`);
  }

  /** Fetch data for a road class. */
  async getStreetClass(cls) {
    return this._fetchJson(`${this._base}/streets/by-class/${cls}.json`);
  }

  /** Fetch street data for a district. */
  async getStreetDistrict(slug) {
    return this._fetchJson(`${this._base}/streets/by-district/${slug}.json`);
  }

  /** Fetch the routing manifest. */
  async getRoutingManifest() {
    return this._fetchJson(`${this._base}/routing/manifest.json`);
  }

  async _fetchJson(url) {
    try {
      const r = await fetch(url);
      return r.ok ? r.json() : null;
    } catch { return null; }
  }

  // -------------------------------------------------------------------------
  // Public API: Map controls
  // -------------------------------------------------------------------------

  /** Fly the map to a [lon, lat] position. */
  flyTo(center, zoom) {
    this._map.flyTo({ center, zoom: zoom ?? this._map.getZoom() });
    return this;
  }

  /** Add a popup at [lon, lat] with HTML content. */
  popup(lngLat, html) {
    if (this._popup) this._popup.remove();
    this._popup = new maplibregl.Popup({ maxWidth: '280px' })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(this._map);
    return this;
  }

  /** Close any open popup. */
  closePopup() {
    if (this._popup) { this._popup.remove(); this._popup = null; }
    return this;
  }

  /** Expose the underlying MapLibre GL Map instance. */
  get rawMap() { return this._map; }

  /** List of all available road classes. */
  static get ROAD_CLASSES() { return ROAD_CLASSES; }

  /** Road class → default hex colour map. */
  static get CLASS_COLORS() { return CLASS_COLORS; }

  /** List of district slugs. */
  static get DISTRICTS() { return DISTRICTS; }
}

// ---------------------------------------------------------------------------
// Auto-export for non-module environments
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.SriLankaMap = SriLankaMap;
}
