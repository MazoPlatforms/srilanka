// Static A* router. Usage:
//   const r = await SLRouter.load("routing/car/");   // car|motorcycle|truck|bicycle|foot (folder; meta.json is editable)
//   const res = r.route([lon1, lat1], [lon2, lat2]);    // {coords:[[lon,lat]..], meters, seconds} | null
//   map.getSource("route").setData({type:"Feature",geometry:{type:"LineString",coordinates:res.coords}});
const SLRouter = (() => {
  const hav = (a, b, c, d) => { const x = (c - a) * Math.PI / 180 * Math.cos((b + d) * Math.PI / 360), y = (d - b) * Math.PI / 180; return 6371000 * Math.hypot(x, y); };
  class R {
    constructor(meta, ll, offs, dst, cost) {
      Object.assign(this, { N: meta.nodes, E: meta.edges, vmax: meta.vmax_ms, ll, offs, dst, cost });
    }
    snap(lon, lat) {
      let best = -1, bd = 1e18; const ll = this.ll, k = Math.cos(lat * Math.PI / 180);
      for (let i = 0; i < this.N; i++) {
        const dx = (ll[2 * i] / 1e6 - lon) * k, dy = ll[2 * i + 1] / 1e6 - lat, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    route(a, b) {
      const s = this.snap(a[0], a[1]), t = this.snap(b[0], b[1]); if (s < 0 || t < 0) return null;
      const ll = this.ll, tx = ll[2 * t] / 1e6, ty = ll[2 * t + 1] / 1e6, vm = this.vmax;
      const g = new Map([[s, 0]]), prev = new Map(), done = new Set();
      const hp = [[0, s]]; // binary min-heap of [f, node]
      const push = x => { hp.push(x); let i = hp.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hp[p][0] <= hp[i][0]) break; [hp[p], hp[i]] = [hp[i], hp[p]]; i = p; } };
      const pop = () => { const top = hp[0], last = hp.pop(); if (hp.length) { hp[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < hp.length && hp[l][0] < hp[m][0]) m = l; if (r < hp.length && hp[r][0] < hp[m][0]) m = r; if (m === i) break; [hp[m], hp[i]] = [hp[i], hp[m]]; i = m; } } return top; };
      while (hp.length) {
        const [, u] = pop(); if (done.has(u)) continue; done.add(u);
        if (u === t) break;
        const gu = g.get(u);
        for (let e = this.offs[u]; e < this.offs[u + 1]; e++) {
const v = this.dst[e], gv = gu + this.cost[e];
if (gv < (g.get(v) ?? Infinity)) {
  g.set(v, gv); prev.set(v, u);
  push([gv + hav(ll[2 * v] / 1e6, ll[2 * v + 1] / 1e6, tx, ty) / vm, v]);
}
        }
      }
      if (!done.has(t)) return null;
      const coords = []; let m = 0;
      for (let n = t; n !== undefined; n = prev.get(n)) coords.push([ll[2 * n] / 1e6, ll[2 * n + 1] / 1e6]);
      coords.reverse();
      for (let i = 1; i < coords.length; i++) m += hav(...coords[i - 1], ...coords[i]);
      return { coords, meters: m, seconds: g.get(t) };
    }
  }
  const buf = async u => (await fetch(u)).arrayBuffer();
  return { load: async dir => { const meta = await (await fetch(dir + "meta.json")).json();
    const [c, o, t, w] = await Promise.all(["coords", "offsets", "targets", "costs"].map(n => buf(dir + n + ".bin")));
    return new R(meta, new Int32Array(c), new Uint32Array(o), new Uint32Array(t), new Float32Array(w)); } };
})();
