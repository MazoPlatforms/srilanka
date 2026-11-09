(function () {
  const R = "data/routing/";
  const MODES = { car: { b: 1, max: 33 }, motorcycle: { b: 2, max: 30 }, truck: { b: 4, max: 25 },
    bus: { b: 8, max: 25 }, bike: { b: 16, max: 8 }, walk: { b: 32, max: 1.6 }, wheelchair: { b: 64, max: 1.2 } };
  const CS = { motorway: 27, trunk: 20, primary: 16, secondary: 13, tertiary: 11, residential: 8,
    living_street: 5, unclassified: 9, service: 5, track: 4, unknown: 8 };
  let M, map, mode = "car", pick = null, pts = { s: null, t: null }, marks = {};
  const cache = new Map(), nodes = new Map(), adj = new Map(), cellNodes = new Map(), loaded = new Set();

  const cellOf = (lon, lat) => {
    const x = Math.min(M.nx - 1, Math.max(0, Math.floor((lon - M.w) / M.cell)));
    const y = Math.min(M.ny - 1, Math.max(0, Math.floor((lat - M.s) / M.cell)));
    return y * M.nx + x;
  };
  const path = n => {
    let l = Math.floor(n / M.per), s = [];
    for (let i = 0; i < M.depth; i++) { s.push(String(l % M.per + 1).padStart(3, "0")); l = Math.floor(l / M.per); }
    return R + s.reverse().join("/") + "/" + n + ".json";
  };
  const dist = (a, b) => { const k = Math.cos((a[1] + b[1]) * Math.PI / 360);
    return 111320 * Math.hypot((a[0] - b[0]) * k, a[1] - b[1]); };

  function load(n) {
    if (!cache.has(n)) cache.set(n, fetch(path(n)).then(r => r.ok ? r.json() : { n: {}, e: [] })
      .catch(() => ({ n: {}, e: [] })).then(d => {
        for (const k in d.n) nodes.set(+k, d.n[k]);
        const ids = [];
        for (const e of d.e) for (const dir of [0, 1]) {
          const id = e[dir], c = nodes.get(id);
          if (cellOf(c[0], c[1]) !== n) continue;
          let a = adj.get(id);
          if (!a) { adj.set(id, a = []); ids.push(id); }
          a.push([e, dir]);
        }
        cellNodes.set(n, ids); loaded.add(n);
      }));
    return cache.get(n);
  }
  async function snap(m, lng, lat) {
    const c = cellOf(lng, lat), cx = c % M.nx, cy = Math.floor(c / M.nx), cs = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < M.nx && y < M.ny) cs.push(y * M.nx + x);
    }
    await Promise.all(cs.map(load));
    const b = MODES[m].b, k = Math.cos(lat * Math.PI / 180);
    let best = null, bd = 1e18;
    for (const cc of cs) for (const id of cellNodes.get(cc) || []) {
      if (!adj.get(id).some(([e, d]) => e[5 + d] & b)) continue;
      const p = nodes.get(id), d2 = ((p[0] - lng) * k) ** 2 + (p[1] - lat) ** 2;
      if (d2 < bd) { bd = d2; best = id; }
    }
    return best;
  }
  function speed(m, e) {
    const c = M.classes[e[3]];
    if (c === "ferry") return Math.min(5, MODES[m].max);
    if (m === "walk") return c === "steps" ? 0.8 : 1.4;
    if (m === "wheelchair") return 1.1;
    if (m === "bike") return c === "path" || c === "track" ? 3 : 4.2;
    const v = e[4] > 0 ? e[4] / 3.6 * 0.85 : (CS[c] || 8);
    return Math.max(1, Math.min(v * (m === "car" || m === "motorcycle" ? 1 : 0.85), MODES[m].max));
  }
  class Heap {
    constructor() { this.a = []; }
    get n() { return this.a.length; }
    push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0;
        for (;;) { let l = 2 * i + 1, r = l + 1, s = i;
          if (l < a.length && a[l][0] < a[s][0]) s = l;
          if (r < a.length && a[r][0] < a[s][0]) s = r;
          if (s === i) break; [a[s], a[i]] = [a[i], a[s]]; i = s; } }
      return top; }
  }
  async function route(m, s, t) {
    const b = MODES[m].b, mx = MODES[m].max, T = nodes.get(t);
    const h = id => dist(nodes.get(id), T) / mx;
    const g = new Map([[s, 0]]), prev = new Map(), done = new Set(), H = new Heap();
    H.push(h(s), s);
    let it = 0;
    while (H.n) {
      const u = H.pop()[1];
      if (done.has(u)) continue;
      if (u === t) break;
      done.add(u);
      const p = nodes.get(u), c = cellOf(p[0], p[1]);
      if (!loaded.has(c)) await load(c);
      for (const [e, d] of adj.get(u) || []) {
        if (!(e[5 + d] & b)) continue;
        const v = e[1 - d], nd = g.get(u) + e[2] / speed(m, e);
        if (nd < (g.get(v) ?? 1e18)) { g.set(v, nd); prev.set(v, [u, e, d]); H.push(nd + h(v), v); }
      }
      if (++it > 4e6) break;
    }
    if (!prev.has(t) && s !== t) return null;
    const steps = []; let v = t, len = 0;
    while (v !== s) {
      const [u, e, d] = prev.get(v), mid = [];
      for (let i = 0; e[7] && i < e[7].length; i += 2) mid.push([e[7][i], e[7][i + 1]]);
      if (d) mid.reverse();
      steps.push([nodes.get(u), ...mid]); len += e[2]; v = u;
    }
    return { line: steps.reverse().flat().concat([nodes.get(t)]), len, time: g.get(t) || 0 };
  }

  const $ = id => document.getElementById(id);
  const fmt = s => s >= 3600 ? Math.floor(s / 3600) + " h " + Math.round(s % 3600 / 60) + " min" : Math.max(1, Math.round(s / 60)) + " min";
  function setPoint(k, ll) {
    pts[k] = [ll.lng, ll.lat];
    if (marks[k]) marks[k].remove();
    marks[k] = new maplibregl.Marker({ color: k === "s" ? "#2e9e5b" : "#e5484d" }).setLngLat(pts[k]).addTo(map);
  }
  async function go() {
    if (!pts.s || !pts.t) return;
    $("rinfo").textContent = "Finding route…";
    try {
      const s = await snap(mode, ...pts.s), t = await snap(mode, ...pts.t);
      if (s == null || t == null) { $("rinfo").textContent = "No " + mode + " road near a point."; return draw([]); }
      const r = await route(mode, s, t);
      if (!r) { $("rinfo").textContent = "No route found for this mode."; return draw([]); }
      draw(r.line);
      $("rinfo").textContent = (r.len / 1000).toFixed(1) + " km · " + fmt(r.time);
      const b = new maplibregl.LngLatBounds();
      r.line.forEach(p => b.extend(p));
      map.fitBounds(b, { padding: 60, maxZoom: 16 });
    } catch (err) { console.error(err); $("rinfo").textContent = "Routing failed."; }
  }
  function draw(line) {
    map.getSource("route").setData({ type: "Feature", geometry: { type: "LineString", coordinates: line }, properties: {} });
  }
  function ui() {
    const box = document.createElement("div");
    box.className = "panel";
    box.style.cssText = "top:auto;bottom:64px;left:10px";
    box.innerHTML = '<details><summary>Directions</summary>' +
      '<select id="rmode" style="width:100%;margin:6px 0;padding:6px;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px">' +
      '<option value="car">Car</option><option value="motorcycle">Motorcycle</option><option value="bike">Bicycle</option>' +
      '<option value="walk">Walking</option><option value="truck">Truck</option><option value="bus">Bus</option>' +
      '<option value="wheelchair">Wheelchair</option></select>' +
      '<div style="display:flex;gap:6px"><button id="rs" type="button">Start</button><button id="rt" type="button">End</button>' +
      '<button id="rc" type="button">Clear</button></div></details><small id="rinfo">Tap Start, then tap the map.</small>';
    document.body.appendChild(box);
    $("rmode").onchange = e => { mode = e.target.value; go(); };
    $("rs").onclick = () => { pick = "s"; $("rinfo").textContent = "Tap the start point on the map."; };
    $("rt").onclick = () => { pick = "t"; $("rinfo").textContent = "Tap the end point on the map."; };
    $("rc").onclick = () => { pts = { s: null, t: null }; for (const k in marks) marks[k].remove(); marks = {}; draw([]); $("rinfo").textContent = "Tap Start, then tap the map."; };
    map.on("click", e => {
      if (!pick) return;
      setPoint(pick, e.lngLat);
      const next = pick === "s" && !pts.t ? "t" : null;
      pick = next;
      if (next) $("rinfo").textContent = "Now tap the end point."; else go();
    });
  }
  function start() {
    map = window.__map;
    const init = () => {
      map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "route-line", type: "line", source: "route",
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#e5484d", "line-width": 5, "line-opacity": 0.9 } });
      ui();
    };
    map.loaded() || map.isStyleLoaded() ? init() : map.once("load", init);
  }
  fetch(R + "manifest.json").then(r => r.json()).then(m => {
    M = m;
    const t = setInterval(() => { if (window.__map) { clearInterval(t); start(); } }, 200);
  }).catch(() => {});
})();
