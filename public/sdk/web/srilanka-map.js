/**
 * srilanka-map.js  —  Sri Lanka Map Web SDK (100% Frontend Only)
 * =============================================================
 * Pure client-side ES-module SDK for Sri Lanka maps, hosted statically
 * on GitHub Pages with ZERO backend server required.
 *
 * Features:
 *   - Direct client-side reading of all 25 district vector tiles (.pmtiles)
 *     using HTTP Range requests via pmtiles.js
 *   - Client-side A* routing engine using static JSON cells (data/routing/)
 *   - Client-side place search using static search shards (data/search/)
 *   - Street class filtering & styling (motorway, trunk, primary, etc.)
 *   - Dynamic feature/JSON loading from data/streets/
 *
 * Usage:
 *   import { SriLankaMap } from './srilanka-map.js';
 *
 *   const map = new SriLankaMap({
 *     container: 'map',
 *     // dataUrl defaults to auto-detected GitHub Pages / static root
 *   });
 *
 *   map.on('ready', () => {
 *     map.showStreets(['motorway', 'trunk', 'primary']);
 *     map.route({ from: [79.86, 6.93], to: [80.63, 7.29], mode: 'car' });
 *     map.search('Kandy');
 *   });
 */

export const BBOX = [79.4, 5.8, 82.0, 9.95];
export const CENTER = [80.7, 7.87];
export const DEFAULT_ZOOM = 8;

export const DISTRICTS = [
  'ampara','anuradhapura','badulla','batticaloa','colombo',
  'galle','gampaha','hambantota','jaffna','kalutara',
  'kandy','kegalle','kilinochchi','kurunegala','mannar',
  'matale','matara','monaragala','mullaitivu','nuwara-eliya',
  'polonnaruwa','puttalam','ratnapura','trincomalee','vavuniya',
];

export const ROAD_CLASSES = [
  'motorway','trunk','primary','secondary','tertiary',
  'residential','living_street','unclassified','service',
  'pedestrian','footway','steps','path','cycleway',
  'bridleway','track','ferry','unknown',
];

export const CLASS_COLORS = {
  motorway:      '#e44444',
  trunk:         '#ff8800',
  primary:       '#ffd700',
  secondary:     '#ffffff',
  tertiary:      '#f5f5f5',
  residential:   '#e8e8e8',
  living_street: '#dddddd',
  unclassified:  '#d8d8d8',
  service:       '#cccccc',
  pedestrian:    '#aaaaff',
  footway:       '#aaaaaa',
  steps:         '#999999',
  path:          '#999999',
  cycleway:      '#00aa44',
  bridleway:     '#886644',
  track:         '#b8a898',
  ferry:         '#4488cc',
  unknown:       '#cccccc',
};

const MODES = {
  car:        { b: 1,  max: 33 },
  motorcycle: { b: 2,  max: 30 },
  truck:      { b: 4,  max: 25 },
  bus:        { b: 8,  max: 25 },
  bike:       { b: 16, max: 8  },
  walk:       { b: 32, max: 1.6},
  wheelchair: { b: 64, max: 1.2},
};

const SPEED_CLASS = {
  motorway: 27, trunk: 20, primary: 16, secondary: 13, tertiary: 11,
  residential: 8, living_street: 5, unclassified: 9, service: 5, track: 4, unknown: 8
};

// ---------------------------------------------------------------------------
// Client-side A* Routing Engine (Pure Frontend)
// ---------------------------------------------------------------------------
class ClientSideRouter {
  constructor(dataUrl) {
    this.R = dataUrl + 'routing/';
    this.M = null;
    this.cache = new Map();
    this.nodes = new Map();
    this.adj = new Map();
    this.cellNodes = new Map();
    this.loaded = new Set();
  }

  async init() {
    if (this.M) return;
    const r = await fetch(this.R + 'manifest.json', { cache: 'no-cache' });
    this.M = await r.json();
  }

  cellOf(lon, lat) {
    const { w, s, cell, nx, ny } = this.M;
    const x = Math.min(nx - 1, Math.max(0, Math.floor((lon - w) / cell)));
    const y = Math.min(ny - 1, Math.max(0, Math.floor((lat - s) / cell)));
    return y * nx + x;
  }

  cellPath(n) {
    const { per, depth } = this.M;
    let l = Math.floor(n / per), s = [];
    for (let i = 0; i < depth; i++) {
      s.push(String(l % per + 1).padStart(3, '0'));
      l = Math.floor(l / per);
    }
    return this.R + s.reverse().join('/') + '/' + n + '.json';
  }

  async loadCell(n) {
    if (!this.cache.has(n)) {
      this.cache.set(n, fetch(this.cellPath(n)).then(r => r.ok ? r.json() : { n: {}, e: [] })
        .catch(() => ({ n: {}, e: [] })).then(d => {
          for (const k in d.n) this.nodes.set(+k, d.n[k]);
          const ids = [];
          for (const e of d.e) {
            for (const dir of [0, 1]) {
              const id = e[dir], c = this.nodes.get(id);
              if (!c || this.cellOf(c[0], c[1]) !== n) continue;
              let a = this.adj.get(id);
              if (!a) { this.adj.set(id, a = []); ids.push(id); }
              a.push([e, dir]);
            }
          }
          this.cellNodes.set(n, ids);
          this.loaded.add(n);
        }));
    }
    return this.cache.get(n);
  }

  dist(a, b) {
    const k = Math.cos((a[1] + b[1]) * Math.PI / 360);
    return 111320 * Math.hypot((a[0] - b[0]) * k, a[1] - b[1]);
  }

  async snap(m, lng, lat) {
    const { nx, ny } = this.M;
    const c = this.cellOf(lng, lat), cx = c % nx, cy = Math.floor(c / nx), cs = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < nx && y < ny) cs.push(y * nx + x);
      }
    }
    await Promise.all(cs.map(cc => this.loadCell(cc)));
    const b = MODES[m].b, k = Math.cos(lat * Math.PI / 180);
    let best = null, bd = 1e18;
    for (const cc of cs) {
      for (const id of this.cellNodes.get(cc) || []) {
        if (!this.adj.get(id)?.some(([e, d]) => e[5 + d] & b)) continue;
        const p = this.nodes.get(id);
        const d2 = ((p[0] - lng) * k) ** 2 + (p[1] - lat) ** 2;
        if (d2 < bd) { bd = d2; best = id; }
      }
    }
    return best;
  }

  speed(m, e) {
    const c = this.M.classes[e[3]];
    if (c === 'ferry') return Math.min(5, MODES[m].max);
    if (m === 'walk') return c === 'steps' ? 0.8 : 1.4;
    if (m === 'wheelchair') return 1.1;
    if (m === 'bike') return (c === 'path' || c === 'track') ? 3 : 4.2;
    const v = e[4] > 0 ? e[4] / 3.6 * 0.85 : (SPEED_CLASS[c] || 8);
    return Math.max(1, Math.min(v * (m === 'car' || m === 'motorcycle' ? 1 : 0.85), MODES[m].max));
  }

  async compute(m, s, t) {
    const b = MODES[m].b, mx = MODES[m].max, T = this.nodes.get(t);
    const h = id => this.dist(this.nodes.get(id), T) / mx;
    const g = new Map([[s, 0]]), prev = new Map(), done = new Set();
    const heap = [[h(s), s]];
    const pushH = (k, v) => { heap.push([k, v]); heap.sort((x, y) => x[0] - y[0]); };
    const popH = () => heap.shift();

    let it = 0;
    while (heap.length) {
      const [, u] = popH();
      if (done.has(u)) continue;
      if (u === t) break;
      done.add(u);
      const p = this.nodes.get(u), c = this.cellOf(p[0], p[1]);
      if (!this.loaded.has(c)) await this.loadCell(c);
      for (const [e, d] of this.adj.get(u) || []) {
        if (!(e[5 + d] & b)) continue;
        const v = e[1 - d], nd = g.get(u) + e[2] / this.speed(m, e);
        if (nd < (g.get(v) ?? 1e18)) {
          g.set(v, nd);
          prev.set(v, [u, e, d]);
          pushH(nd + h(v), v);
        }
      }
      if (++it > 3e6) break;
    }

    if (!prev.has(t) && s !== t) return null;
    const steps = []; let v = t, len = 0;
    while (v !== s) {
      const [u, e, d] = prev.get(v);
      const mid = [];
      for (let i = 0; e[7] && i < e[7].length; i += 2) mid.push([e[7][i], e[7][i + 1]]);
      if (d) mid.reverse();
      steps.push([this.nodes.get(u), ...mid]);
      len += e[2];
      v = u;
    }
    return {
      coordinates: steps.reverse().flat().concat([this.nodes.get(t)]),
      distance_m: len,
      distance_km: Math.round(len / 100) / 10,
      duration_sec: Math.round(g.get(t) || 0),
      mode: m,
    };
  }
}

// ---------------------------------------------------------------------------
// SriLankaMap class — 100% Frontend Only
// ---------------------------------------------------------------------------
export class SriLankaMap extends EventTarget {
  /**
   * @param {object} options
   * @param {string|HTMLElement} options.container - DOM container
   * @param {string} [options.baseUrl] - Base URL of the static GitHub Pages repo
   * @param {number[]} [options.center=[80.7, 7.87]]
   * @param {number} [options.zoom=8]
   * @param {boolean} [options.hash=true]
   * @param {boolean} [options.routing=true]
   */
  constructor(options = {}) {
    super();

    // Auto-detect static GitHub Pages base path
    let defaultBase = location.href.replace(/\/[^/]*$/, '/');
    if (defaultBase.endsWith('/sdk/web/')) {
      defaultBase = new URL('../../', defaultBase).href;
    }

    this._base = (options.baseUrl || options.tileServer || defaultBase).replace(/\/$/, '') + '/';
    this._data = new URL('data/', this._base).href;
    this._fonts = new URL('fonts/', this._base).href + '{fontstack}/{range}.pbf';

    this._opts = {
      container: options.container,
      zoom: options.zoom || DEFAULT_ZOOM,
      center: options.center || CENTER,
      hash: options.hash !== false,
      routing: options.routing !== false,
      ...options,
    };

    this._map = null;
    this._router = new ClientSideRouter(this._data);
    this._shards = new Map();
    this._layers = new Set();
    this._districtsData = null;

    this._init();
  }

  async _init() {
    const mgl = await this._waitForMapLibre();

    // Register client-side PMTiles protocol handler
    if (typeof pmtiles !== 'undefined') {
      mgl.addProtocol('pmtiles', new pmtiles.Protocol().tile);
    }

    // Fetch static districts index to build frontend style
    try {
      const res = await fetch(this._data + 'districts.json', { cache: 'no-cache' });
      this._districtsData = await res.json();
    } catch (e) {
      this._districtsData = { bbox: BBOX, districts: [] };
    }

    const style = this._buildFrontendStyle();

    this._map = new mgl.Map({
      container: this._opts.container,
      style: style,
      hash: this._opts.hash,
      minZoom: 6,
      maxBounds: [[BBOX[0] - 0.5, BBOX[1] - 0.5], [BBOX[2] + 0.5, BBOX[3] + 0.5]],
      center: this._opts.center,
      zoom: this._opts.zoom,
    });

    this._map.addControl(new mgl.NavigationControl(), 'bottom-right');
    this._map.addControl(new mgl.ScaleControl(), 'bottom-left');

    this._map.on('error', ev => {
      this.dispatchEvent(Object.assign(new Event('error'), { detail: ev }));
    });

    this._map.on('load', async () => {
      // Add client-side route layer
      this._map.addSource('sl-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      this._map.addLayer({
        id: 'sl-route-casing', type: 'line', source: 'sl-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.6 }
      });
      this._map.addLayer({
        id: 'sl-route-line', type: 'line', source: 'sl-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0284c7', 'line-width': 5, 'line-opacity': 0.95 }
      });

      if (this._opts.routing) {
        try { await this._router.init(); } catch (e) { /* routing cell cache */ }
      }

      this.dispatchEvent(new Event('ready'));
    });
  }

  _buildFrontendStyle() {
    const D = this._districtsData.districts || [];
    const sources = {};
    const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#e2ebdc' } }];

    // 100% Frontend PMTiles sources via HTTP Range requests to GitHub Pages
    D.forEach(d => {
      const slug = d.slug;
      if (d.files?.areas) {
        sources[`a_${slug}`] = {
          type: 'vector',
          url: `pmtiles://${this._data}districts/${slug}/areas.pmtiles`,
          attribution: '© OpenStreetMap contributors',
        };
      }
      if (d.files?.base) {
        sources[`o_${slug}`] = {
          type: 'vector',
          url: `pmtiles://${this._data}districts/${slug}/base.pmtiles`,
          attribution: '© OpenStreetMap contributors · Overture Maps',
        };
      }
    });

    // Land use
    D.forEach(d => {
      if (d.files?.areas) {
        layers.push({
          id: `lu-${d.slug}`, type: 'fill', source: `a_${d.slug}`, 'source-layer': 'land_use',
          paint: {
            'fill-opacity': 0.85,
            'fill-color': ['match', ['get', 'class'],
              ['park', 'forest', 'wood', 'grass'], '#c9e3bd',
              ['agriculture', 'farmland'], '#dfe8c3',
              ['residential'], '#e9ece2', '#e4e8dc'
            ]
          }
        });
        layers.push({
          id: `wa-${d.slug}`, type: 'fill', source: `a_${d.slug}`, 'source-layer': 'water',
          paint: { 'fill-color': '#9fd0dc' }
        });
      }
    });

    // Road casings
    D.forEach(d => {
      if (d.files?.base) {
        layers.push({
          id: `rc-${d.slug}`, type: 'line', source: `o_${d.slug}`, 'source-layer': 'segment',
          filter: ['==', ['get', 'subtype'], 'road'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#b7beb2', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 3] }
        });
      }
    });

    // Street layers color-coded by class
    ROAD_CLASSES.forEach(cls => {
      const color = CLASS_COLORS[cls] || '#ffffff';
      const isMajor = ['motorway', 'trunk', 'primary'].includes(cls);
      D.forEach(d => {
        if (d.files?.base) {
          const id = `rd-${cls}-${d.slug}`;
          layers.push({
            id, type: 'line', source: `o_${d.slug}`, 'source-layer': 'segment',
            filter: ['all', ['==', ['get', 'subtype'], 'road'], ['==', ['get', 'class'], cls]],
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'visible' },
            paint: {
              'line-color': color,
              'line-width': ['interpolate', ['linear'], ['zoom'], 8, isMajor ? 1.5 : 0.4, 14, isMajor ? 5 : 2]
            }
          });
          this._layers.add(id);
        }
      });
    });

    return {
      version: 8,
      name: 'Sri Lanka Map (Frontend)',
      glyphs: this._fonts,
      sources,
      layers,
    };
  }

  _waitForMapLibre(retries = 50) {
    return new Promise((resolve, reject) => {
      const check = n => {
        if (typeof maplibregl !== 'undefined') return resolve(maplibregl);
        if (n <= 0) return reject(new Error('maplibregl not found'));
        setTimeout(() => check(n - 1), 100);
      };
      check(retries);
    });
  }

  on(event, handler) { this.addEventListener(event, handler); return this; }
  off(event, handler) { this.removeEventListener(event, handler); return this; }

  /**
   * Filter visible street classes.
   * @param {string[]} classes - Array of class names to show
   */
  showStreets(classes) {
    const showSet = new Set(classes);
    ROAD_CLASSES.forEach(cls => {
      const visible = showSet.has(cls);
      (this._districtsData.districts || []).forEach(d => {
        const id = `rd-${cls}-${d.slug}`;
        if (this._map.getLayer(id)) {
          this._map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        }
      });
    });
    return this;
  }

  /**
   * Compute and draw a route 100% in the frontend.
   * @param {object} opts
   * @param {number[]} opts.from - [lon, lat]
   * @param {number[]} opts.to - [lon, lat]
   * @param {string} [opts.mode='car']
   */
  async route({ from, to, mode = 'car' } = {}) {
    if (!this._router.M) await this._router.init();
    this.dispatchEvent(new CustomEvent('routing:start', { detail: { from, to, mode } }));

    const [s, t] = await Promise.all([
      this._router.snap(mode, from[0], from[1]),
      this._router.snap(mode, to[0], to[1]),
    ]);

    if (s == null || t == null) {
      this.clearRoute();
      this.dispatchEvent(new CustomEvent('routing:error', { detail: 'No road near point' }));
      return null;
    }

    const result = await this._router.compute(mode, s, t);
    if (!result) {
      this.clearRoute();
      this.dispatchEvent(new CustomEvent('routing:error', { detail: 'No route found' }));
      return null;
    }

    this._drawRoute(result);
    this.dispatchEvent(new CustomEvent('routing:success', { detail: result }));
    return result;
  }

  _drawRoute(data) {
    if (!this._map?.getSource('sl-route')) return;
    this._map.getSource('sl-route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: data.coordinates || [] },
      properties: data,
    });
    // Fit bounds to route
    const bounds = new maplibregl.LngLatBounds();
    data.coordinates.forEach(p => bounds.extend(p));
    this._map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
  }

  clearRoute() {
    if (this._map?.getSource('sl-route')) {
      this._map.getSource('sl-route').setData({ type: 'FeatureCollection', features: [] });
    }
  }

  /**
   * Search places by name using static search shards.
   * @param {string} query
   * @param {number} [limit=8]
   */
  async search(query, limit = 8) {
    const SEP = /[\s,.;:()\[\]/\\-_&'"]+/;
    const tokens = query.toLowerCase().split(SEP).filter(t => [...t].length >= 2);
    const lead = tokens.find(t => [...t].length >= 2);
    if (!lead) return [];

    const key = [...lead].slice(0, 2).map(c => c.codePointAt(0).toString(16)).join('-');
    if (!this._shards.has(key)) {
      try {
        const r = await fetch(`${this._data}search/${key}.json`);
        this._shards.set(key, r.ok ? await r.json() : []);
      } catch { this._shards.set(key, []); }
    }

    const hits = (this._shards.get(key) || [])
      .filter(x => tokens.every(t => x[0].toLowerCase().includes(t)))
      .slice(0, limit);

    this.dispatchEvent(new CustomEvent('search:results', { detail: { query, hits } }));
    return hits;
  }

  flyTo(lngLat, zoom = 14) {
    this._map?.flyTo({ center: lngLat, zoom });
    return this;
  }

  /** Fetch any static street JSON file */
  async getStreetsIndex() {
    const r = await fetch(this._data + 'streets/index.json');
    return r.ok ? r.json() : null;
  }

  async getStreetClass(cls) {
    const r = await fetch(`${this._data}streets/by-class/${cls}.json`);
    return r.ok ? r.json() : null;
  }

  async getDistrictStreets(slug) {
    const r = await fetch(`${this._data}streets/by-district/${slug}.json`);
    return r.ok ? r.json() : null;
  }
}

export default SriLankaMap;
