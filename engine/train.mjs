// Training, walk-forward validation, daily evolution and warm-up simulation.

import { HORIZONS, MAX_H, Z_CLIP, DAY_MIN, Q_LEVELS } from '../site/core/config.js';
import { computeFeatures, targets, featureIndices, GROUP_NAMES, WARMUP, D, FEATURES } from '../site/core/features.js';
import { EXPERTS, ridgePredict, gbdtPredict, expertPredictions } from '../site/core/models.js';
import { Engine, freshState } from '../site/core/engine.js';
import { emptyHorizonAggs, addResolution } from '../site/core/metrics.js';
import { fitRidge } from './ridge.mjs';
import { fitGBDT, compactForest, mulberry32 } from './gbdt.mjs';

export const SPECIALIST_GROUPS = { micro: ['micro'], btc: ['btc'], swing: ['trend', 'range'] };
export const WINDOWS = [7, 10, 14, 21, 30, 45, 60];
export const LAMBDA_GRID = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6];

// Generation 0: sensible hand-picked starting point. Evolution takes it from here.
export const GEN0 = {
  specialists: { lambda: { micro: 1e4, btc: 1e4, swing: 1e4 }, window: 30 },
  linear: { lambda: 3e4, window: 30, groups: [...GROUP_NAMES], clip: 4 },
  forest: { trees: 100, depth: 3, lr: 0.05, minLeaf: 1000, subsample: 0.5, colsample: 0.8, l2: 10, window: 30, groups: [...GROUP_NAMES], clip: 4 },
};

export function makeDataset(S) {
  const { X, vol } = computeFeatures(S);
  const Z = {};
  for (const h of HORIZONS) Z[h] = targets(S, vol, h);
  return { S, X, vol, Z, n: S.t.length, _clip: {} };
}

// Rows in [a, b) usable for learning: complete features, real candle, all targets known.
export function rowsIn(ds, a, b) {
  const out = [];
  const lo = Math.max(a, WARMUP), hi = Math.min(b, ds.n - MAX_H);
  for (let i = lo; i < hi; i++) if (Number.isFinite(ds.vol[i]) && !ds.S.syn[i]) out.push(i);
  return Int32Array.from(out);
}

// Rows a model may be trained on if its first prediction is at minute index s
// (every target must have been observed by the close of minute s-1).
export function trainRows(ds, s, windowDays) {
  return rowsIn(ds, s - MAX_H - windowDays * DAY_MIN, s - MAX_H);
}

function clippedTargets(ds, clip) {
  if (!ds._clip[clip]) {
    const o = {};
    for (const h of HORIZONS) o[h] = ds.Z[h].map((z) => (z > clip ? clip : z < -clip ? -clip : z));
    ds._clip[clip] = o;
  }
  return ds._clip[clip];
}

function fitKind(ds, kind, cfg, rows, seed) {
  if (kind === 'linear') {
    return fitRidge(ds.X, D, rows, featureIndices(cfg.groups), clippedTargets(ds, cfg.clip), cfg.lambda);
  }
  if (kind === 'forest') {
    const out = {};
    const Y = clippedTargets(ds, cfg.clip);
    for (const h of HORIZONS) out[h] = fitGBDT(ds.X, D, rows, Y[h], featureIndices(cfg.groups), cfg, seed * 7 + h);
    return out;
  }
  // specialist ridge
  return fitRidge(ds.X, D, rows, featureIndices(SPECIALIST_GROUPS[kind]), clippedTargets(ds, Z_CLIP), cfg.lambda);
}

// Horizon weights for the evolution score: R^2 noise grows ~ sqrt(h), so weight by 1/h.
export const H_WEIGHT = Object.fromEntries(HORIZONS.map((h) => [h, (1 / h) / HORIZONS.reduce((a, k) => a + 1 / k, 0)]));

const predictKind = (kind, m, X, off) => (kind === 'forest' ? gbdtPredict(m, X, off) : ridgePredict(m, X, off));

export function fitExperts(ds, s, cfg, seed = 1) {
  return EXPERTS.map((e) => {
    if (e.id === 'rw') return { id: 'rw', kind: 'zero' };
    if (e.id === 'linear') return { id: 'linear', kind: 'ridge', h: fitKind(ds, 'linear', cfg.linear, trainRows(ds, s, cfg.linear.window)) };
    if (e.id === 'forest') {
      const m = fitKind(ds, 'forest', cfg.forest, trainRows(ds, s, cfg.forest.window), seed);
      const h = {};
      for (const k of HORIZONS) h[k] = compactForest(m[k]);
      return { id: 'forest', kind: 'gbdt', h };
    }
    const sc = { lambda: cfg.specialists.lambda[e.id] };
    return { id: e.id, kind: 'ridge', h: fitKind(ds, e.id, sc, trainRows(ds, s, cfg.specialists.window)) };
  });
}

// Empirical quantiles of the standardised return at Q_LEVELS (the band shapes).
export function residQuantiles(ds, rows) {
  const out = {};
  for (const h of HORIZONS) {
    const v = [];
    for (const i of rows) { const z = ds.Z[h][i]; if (Number.isFinite(z)) v.push(z); }
    v.sort((a, b) => a - b);
    out[h] = Q_LEVELS.map((q) => {
      const pos = q * (v.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
      return Number((v[lo] + (v[hi] - v[lo]) * (pos - lo)).toPrecision(6));
    });
  }
  return out;
}

// ---------- walk-forward evaluation ----------

// The last `k` whole days before the final MAX_H minutes, oldest first.
export function lastDayFolds(ds, k) {
  const end = ds.n - MAX_H;
  const folds = [];
  for (let j = k; j >= 1; j--) folds.push([end - j * DAY_MIN, end - (j - 1) * DAY_MIN]);
  return folds;
}

/**
 * Out-of-sample skill of a configuration: for each fold, train only on data available
 * before the fold, predict the fold, compare with "no change". Score = mean R^2 (%) over horizons.
 */
export function evaluate(ds, kind, cfg, folds, seed = 1) {
  const sse = {}, sse0 = {};
  for (const h of HORIZONS) { sse[h] = 0; sse0[h] = 0; }
  const Y = clippedTargets(ds, Z_CLIP);
  const perFold = [];
  for (const [s, e] of folds) {
    const m = fitKind(ds, kind, cfg, trainRows(ds, s, cfg.window ?? 30), seed);
    const val = rowsIn(ds, s, e);
    let fs = 0, fs0 = 0;
    for (const h of HORIZONS) {
      const y = Y[h];
      for (const i of val) {
        const z = y[i];
        const err = z - predictKind(kind, m[h], ds.X, i * D);
        sse[h] += err * err; sse0[h] += z * z; fs += err * err; fs0 += z * z;
      }
    }
    perFold.push(fs0 > 0 ? (1 - fs / fs0) * 100 : 0);
  }
  const perH = {};
  for (const h of HORIZONS) perH[h] = sse0[h] > 0 ? (1 - sse[h] / sse0[h]) * 100 : 0;
  const score = HORIZONS.reduce((a, h) => a + H_WEIGHT[h] * perH[h], 0);
  return { score, perH, perFold };
}

// ---------- evolution ----------

function gauss(rng) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clampN = (x, a, b) => Math.min(b, Math.max(a, x));
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const nearWindow = (w, rng) => {
  const i = WINDOWS.indexOf(w);
  const j = clampN((i < 0 ? 4 : i) + (rng() < 0.5 ? -1 : 1), 0, WINDOWS.length - 1);
  return WINDOWS[j];
};
function toggleGroup(groups, rng) {
  const g = pick(GROUP_NAMES, rng);
  const has = groups.includes(g);
  if (has && groups.length <= 1) return groups;
  return has ? groups.filter((x) => x !== g) : GROUP_NAMES.filter((x) => groups.includes(x) || x === g);
}

export function mutateLinear(c, rng) {
  const m = structuredClone(c);
  m.lambda = Number(clampN(c.lambda * 10 ** (gauss(rng) * 0.5), 1e2, 1e7).toPrecision(3));
  if (rng() < 0.35) m.window = nearWindow(c.window, rng);
  if (rng() < 0.5) m.groups = toggleGroup(c.groups, rng);
  if (rng() < 0.15) m.clip = pick([3, 4, 6], rng);
  return m;
}

export function mutateForest(c, rng) {
  const m = structuredClone(c);
  const r = () => rng() < 0.5;
  if (r()) m.trees = Math.round(clampN(c.trees * 2 ** (gauss(rng) * 0.4), 30, 250));
  if (rng() < 0.25) m.depth = clampN(c.depth + (r() ? 1 : -1), 2, 4);
  if (r()) m.lr = Number(clampN(c.lr * 2 ** (gauss(rng) * 0.4), 0.01, 0.2).toPrecision(2));
  if (r()) m.minLeaf = Math.round(clampN(c.minLeaf * 2 ** (gauss(rng) * 0.6), 200, 5000));
  if (rng() < 0.3) m.subsample = Number(clampN(c.subsample + gauss(rng) * 0.15, 0.2, 0.9).toFixed(2));
  if (rng() < 0.3) m.colsample = Number(clampN(c.colsample + gauss(rng) * 0.15, 0.3, 1).toFixed(2));
  if (rng() < 0.3) m.l2 = Number(clampN(c.l2 * 2 ** (gauss(rng) * 0.8), 1, 300).toPrecision(2));
  if (rng() < 0.3) m.window = nearWindow(c.window, rng);
  if (rng() < 0.3) m.groups = toggleGroup(c.groups, rng);
  return m;
}

const key = (c) => JSON.stringify(c);

function tournament(ds, kind, champion, mutate, n, folds, rng, margin, log) {
  const cands = [{ tag: 'champion', cfg: champion }, { tag: 'gen0', cfg: GEN0[kind] }];
  const seen = new Set(cands.map((c) => key(c.cfg)));
  for (let tries = 0; cands.length < n + 2 && tries < n * 10; tries++) {
    const parent = rng() < 0.8 ? champion : GEN0[kind];
    const m = mutate(parent, rng);
    if (!seen.has(key(m))) { seen.add(key(m)); cands.push({ tag: 'challenger', cfg: m }); }
  }
  const t0 = Date.now();
  for (const c of cands) {
    const r = key(c.cfg) === key(champion) && c.tag !== 'champion' ? null : evaluate(ds, kind, c.cfg, folds);
    c.res = r;
  }
  // gen0 identical to champion -> reuse
  for (const c of cands) if (!c.res) c.res = cands[0].res;
  const champ = cands[0];
  let best = champ;
  for (const c of cands) if (c.tag === 'challenger' && c.res.score > best.res.score) best = c;
  const promoted = best !== champ && best.res.score > champ.res.score + margin;
  const winner = promoted ? best : champ;
  log(`  ${kind}: ${cands.length} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s | champion ${champ.res.score.toFixed(4)} | best challenger ${best === champ ? '-' : best.res.score.toFixed(4)} | gen0 ${cands[1].res.score.toFixed(4)} | ${promoted ? 'PROMOTED' : 'kept'}`);
  return {
    cfg: winner.cfg,
    report: {
      champion: round4(champ.res.score),
      challenger: best === champ ? null : round4(best.res.score),
      gen0: round4(cands[1].res.score),
      winner: round4(winner.res.score),
      perH: Object.fromEntries(HORIZONS.map((h) => [h, round4(winner.res.perH[h])])),
      candidates: cands.length,
      promoted,
    },
  };
}
const round4 = (x) => Number(x.toFixed(4));

/**
 * One generation of evolution: every expert family re-competes on the most recent days.
 */
export function evolve(ds, prev, { seed, folds = 5, nLinear = 8, nForest = 3, log = console.log }) {
  const rng = mulberry32(seed);
  const F = lastDayFolds(ds, folds);
  const cfg = structuredClone(prev);
  const report = {};

  // specialists: grid over lambda (cheap)
  report.specialists = {};
  for (const id of Object.keys(SPECIALIST_GROUPS)) {
    const cur = prev.specialists.lambda[id];
    let bestLam = cur, curScore = null, bestScore = -Infinity;
    for (const lam of [...new Set([cur, ...LAMBDA_GRID])]) {
      const r = evaluate(ds, id, { lambda: lam, window: prev.specialists.window }, F).score;
      if (lam === cur) curScore = r;
      if (r > bestScore) { bestScore = r; bestLam = lam; }
    }
    const promoted = bestLam !== cur && bestScore > curScore + 0.002;
    cfg.specialists.lambda[id] = promoted ? bestLam : cur;
    report.specialists[id] = { lambda: cfg.specialists.lambda[id], score: round4(promoted ? bestScore : curScore), promoted };
    log(`  ${id}: lambda ${cfg.specialists.lambda[id]} score ${(promoted ? bestScore : curScore).toFixed(4)}${promoted ? ' (changed)' : ''}`);
  }

  const lin = tournament(ds, 'linear', prev.linear, mutateLinear, nLinear, F, rng, 0.003, log);
  cfg.linear = lin.cfg; report.linear = lin.report;
  const fr = tournament(ds, 'forest', prev.forest, mutateForest, nForest, F, rng, 0.003, log);
  cfg.forest = fr.cfg; report.forest = fr.report;
  return { cfg, report };
}

// ---------- model assembly ----------

export function buildModel(ds, cfg, meta) {
  const s = ds.n; // first minute this model will predict is the one after the data
  const experts = fitExperts(ds, s, cfg, meta.seed || 1);
  const resid = residQuantiles(ds, trainRows(ds, s, 14));
  return {
    v: 1,
    id: meta.id,
    trainedAt: meta.trainedAt,
    dataEnd: ds.S.t[ds.n - 1],
    generation: meta.generation,
    features: FEATURES,
    experts: experts.map(roundExpert),
    resid,
    configs: cfg,
  };
}

function roundExpert(e) {
  if (e.kind !== 'ridge') return e;
  const h = {};
  for (const k of Object.keys(e.h)) {
    const m = e.h[k];
    const r = (x) => Number(x.toPrecision(7));
    h[k] = { idx: m.idx, mean: m.mean.map(r), std: m.std.map(r), w: m.w.map(r), b: r(m.b) };
  }
  return { ...e, h };
}

// ---------- warm-up simulation ----------

/**
 * Simulate the whole online system over the last `days` days with walk-forward refits
 * each day. Used once at bootstrap to warm up ensemble weights and calibration, and to
 * produce a clearly-labelled backtest.
 */
export function warmup(ds, cfg, days, { log = console.log, seed = 1 } = {}) {
  const ids = EXPERTS.map((e) => e.id);
  const s0 = ds.n - days * DAY_MIN;
  const eng = new Engine({ experts: ids.map((id) => ({ id })), resid: null }, freshState(ids, ds.S.t[s0 - 1]));
  const byDay = {};
  const pAbs = { 5: [], 15: [], 60: [] };
  for (let d = 0; d < days; d++) {
    const s = s0 + d * DAY_MIN, e = d === days - 1 ? ds.n : s + DAY_MIN;
    const t0 = Date.now();
    const experts = fitExperts(ds, s, cfg, seed + d);
    const model = { experts: experts.map(roundExpert), resid: residQuantiles(ds, trainRows(ds, s, 14)) };
    eng.model = model;
    for (let i = s; i < e; i++) {
      const mus = expertPredictions(model, ds.X, D, i);
      const { resolved, pred } = eng.step(ds.S.t[i], ds.S.c[i], ds.vol[i], mus);
      if (pred) for (const h of HORIZONS) pAbs[h].push(Math.abs(pred.h[h].p - 0.5));
      for (const r of resolved) {
        const dk = new Date(r.t).toISOString().slice(0, 10);
        (byDay[dk] ||= emptyHorizonAggs());
        addResolution(byDay[dk][r.h], r);
      }
    }
    log(`  warm-up day ${d + 1}/${days} ${new Date(ds.S.t[s]).toISOString().slice(0, 10)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  return { engine: eng, byDay, pAbs };
}
