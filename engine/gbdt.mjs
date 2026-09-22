// Histogram gradient-boosted regression trees (squared loss), written from scratch so the
// published trees are plain arrays the browser can evaluate (site/core/models.js gbdtPredict).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// bin(x) = number of edges < x, so bin(x) <= b  <=>  x <= edges[b]
function lowerBound(edges, x) {
  let lo = 0, hi = edges.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (edges[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

function makeEdges(X, D, rows, col, nBins, rng) {
  const sample = [];
  const step = Math.max(1, Math.floor(rows.length / 20000));
  for (let r = 0; r < rows.length; r += step) sample.push(X[rows[r] * D + col]);
  sample.sort((a, b) => a - b);
  const edges = [];
  for (let b = 1; b < nBins; b++) {
    const v = sample[Math.min(sample.length - 1, Math.floor((b / nBins) * sample.length))];
    if (!edges.length || v > edges[edges.length - 1]) edges.push(v);
  }
  // drop the top edge if it equals the maximum (would create an empty right bin)
  while (edges.length && edges[edges.length - 1] >= sample[sample.length - 1]) edges.pop();
  return edges;
}

/**
 * @param {Float64Array} X row-major features, D columns
 * @param {Int32Array} rows training rows
 * @param {Float64Array} y target per row index (already clipped)
 * @param {number[]} idx feature columns allowed
 * @param {object} p {trees, depth, lr, minLeaf, subsample, colsample, l2, bins}
 */
export function fitGBDT(X, D, rows, y, idx, p, seed = 1) {
  const rng = mulberry32(seed);
  const n = rows.length, F = idx.length, nBins = p.bins || 32;
  const edges = idx.map((col) => makeEdges(X, D, rows, col, nBins, rng));
  const binned = new Uint8Array(F * n);
  for (let f = 0; f < F; f++) {
    const col = idx[f], e = edges[f], base = f * n;
    for (let r = 0; r < n; r++) binned[base + r] = lowerBound(e, X[rows[r] * D + col]);
  }
  const target = new Float64Array(n);
  for (let r = 0; r < n; r++) target[r] = y[rows[r]];
  const pred = new Float64Array(n);
  const grad = new Float64Array(n);
  const trees = [];
  const histG = new Float64Array(nBins), histN = new Int32Array(nBins);
  const lam = p.l2;

  for (let t = 0; t < p.trees; t++) {
    for (let r = 0; r < n; r++) grad[r] = pred[r] - target[r];
    // row subsample
    let sampled = [];
    for (let r = 0; r < n; r++) if (rng() < p.subsample) sampled.push(r);
    sampled = Int32Array.from(sampled);
    // feature subsample
    const feats = [];
    for (let f = 0; f < F; f++) if (rng() < p.colsample) feats.push(f);
    if (!feats.length) feats.push(Math.floor(rng() * F));

    const tree = { f: [], t: [], l: [], r: [], v: [], bin: [] };
    const newNode = () => { tree.f.push(-1); tree.t.push(0); tree.l.push(-1); tree.r.push(-1); tree.v.push(0); tree.bin.push(0); return tree.f.length - 1; };
    const stack = [{ node: newNode(), rows: sampled, depth: 0 }];
    while (stack.length) {
      const { node, rows: nr, depth } = stack.pop();
      let G = 0;
      for (let k = 0; k < nr.length; k++) G += grad[nr[k]];
      const N = nr.length;
      let best = null;
      if (depth < p.depth && N >= 2 * p.minLeaf) {
        const parentScore = (G * G) / (N + lam);
        for (const f of feats) {
          histG.fill(0); histN.fill(0);
          const base = f * n;
          for (let k = 0; k < N; k++) { const r = nr[k]; const b = binned[base + r]; histG[b] += grad[r]; histN[b]++; }
          const nb = edges[f].length + 1;
          let gl = 0, nl = 0;
          for (let b = 0; b < nb - 1; b++) {
            gl += histG[b]; nl += histN[b];
            const nrr = N - nl;
            if (nl < p.minLeaf) continue;
            if (nrr < p.minLeaf) break;
            const gr = G - gl;
            const gain = (gl * gl) / (nl + lam) + (gr * gr) / (nrr + lam) - parentScore;
            if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, b };
          }
        }
      }
      if (!best) {
        tree.v[node] = (-G / (N + lam)) * p.lr;
        continue;
      }
      const base = best.f * n;
      const L = [], R = [];
      for (let k = 0; k < N; k++) { const r = nr[k]; (binned[base + r] <= best.b ? L : R).push(r); }
      const ln = newNode(), rn = newNode();
      tree.f[node] = idx[best.f];
      tree.t[node] = edges[best.f][best.b];
      tree.bin[node] = best.f * 256 + best.b; // local (feature, bin) for fast training updates
      tree.l[node] = ln; tree.r[node] = rn;
      stack.push({ node: rn, rows: Int32Array.from(R), depth: depth + 1 });
      stack.push({ node: ln, rows: Int32Array.from(L), depth: depth + 1 });
    }
    // update predictions for all training rows using the binned values
    for (let r = 0; r < n; r++) {
      let node = 0;
      while (tree.f[node] >= 0) {
        const fb = tree.bin[node], f = (fb / 256) | 0, b = fb % 256;
        node = binned[f * n + r] <= b ? tree.l[node] : tree.r[node];
      }
      pred[r] += tree.v[node];
    }
    delete tree.bin;
    trees.push(tree);
  }
  // trainPred: in-sample predictions (for tests; not published)
  return { base: 0, trees, trainPred: pred };
}

// Round a fitted forest for publishing (thresholds keep full precision: they decide branches).
export function compactForest(m) {
  return {
    base: m.base,
    trees: m.trees.map((t) => ({ f: t.f, t: t.t, l: t.l, r: t.r, v: t.v.map((x) => Number(x.toPrecision(6))) })),
  };
}
