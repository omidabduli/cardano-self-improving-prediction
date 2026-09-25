import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, indexOf } from '../site/core/candles.js';
import { computeFeatures, D, WARMUP, FEATURES, featureIndices } from '../site/core/features.js';
import { ridgePredict, gbdtPredict, expertPredictions, EXPERTS } from '../site/core/models.js';
import { Engine, freshState } from '../site/core/engine.js';
import { emptyAgg, addResolution, summarize } from '../site/core/metrics.js';
import { MINUTE, HORIZONS } from '../site/core/config.js';
import { fitRidge } from '../engine/ridge.mjs';
import { fitGBDT, mulberry32 } from '../engine/gbdt.mjs';
import { beats } from '../engine/train.mjs';

// Synthetic market: BTC random walk, ADA follows BTC with a one-minute lag plus noise,
// prices rounded to the ADA tick like the real thing.
function synthCandles(n, seed = 7) {
  const rng = mulberry32(seed);
  const g = () => { const u = Math.max(rng(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
  const ada = [], btc = [];
  let pa = 0.25, pb = 60000, prevB = 0;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const rb = 0.0008 * g();
    pb *= Math.exp(rb);
    pa *= Math.exp(0.5 * prevB + 0.001 * g());
    prevB = rb;
    const c = Math.round(pa / 0.0001) * 0.0001;
    const o = Math.round(pa * Math.exp(0.0004 * g()) / 0.0001) * 0.0001;
    const v = 1e5 * (0.5 + rng());
    ada.push({ t: t0 + i * MINUTE, o, h: Math.max(o, c) + 0.0001, l: Math.min(o, c) - 0.0001, c: Number(c.toFixed(4)), v, qv: v * c, tr: 50, tb: v * rng() });
    btc.push({ t: t0 + i * MINUTE, o: pb, h: pb * 1.0003, l: pb * 0.9997, c: pb, v: 10, qv: 10 * pb, tr: 100, tb: 10 * rng() });
  }
  return { ada, btc };
}

test('series is gap-free and fills missing minutes flat', () => {
  const { ada, btc } = synthCandles(50);
  const holey = ada.filter((_, i) => i !== 10 && i !== 11);
  const S = buildSeries(holey, btc, ada[49].t);
  assert.equal(S.t.length, 50);
  assert.equal(S.syn[10], 1);
  assert.equal(S.c[10], S.c[9]);
  assert.equal(S.v[11], 0);
  assert.equal(indexOf(S, ada[20].t), 20);
});

test('features are strictly causal (no lookahead)', () => {
  const { ada, btc } = synthCandles(800);
  const full = buildSeries(ada, btc, ada[799].t);
  const cut = 600;
  const part = buildSeries(ada.slice(0, cut), btc.slice(0, cut), ada[cut - 1].t);
  const F1 = computeFeatures(full), F2 = computeFeatures(part);
  for (let i = WARMUP; i < cut; i++) {
    for (let j = 0; j < D; j++) {
      const a = F1.X[i * D + j], b = F2.X[i * D + j];
      assert.ok(Math.abs(a - b) <= 1e-9 * (1 + Math.abs(a)), `feature ${FEATURES[j]} row ${i}: ${a} vs ${b}`);
    }
    assert.equal(F1.vol[i], F2.vol[i]);
  }
  for (let j = 0; j < D; j++) assert.ok(Number.isFinite(F1.X[700 * D + j]), `feature ${FEATURES[j]} finite`);
  assert.ok(Number.isNaN(F1.X[(WARMUP - 1) * D]));
});

test('ridge recovers coefficients and inference matches training', () => {
  const rng = mulberry32(3);
  const n = 5000, Dd = 4;
  const X = new Float64Array(n * Dd);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < Dd; j++) X[i * Dd + j] = rng() * 2 - 1;
    y[i] = 0.8 * X[i * Dd] - 0.3 * X[i * Dd + 2] + 0.01 * (rng() - 0.5);
  }
  const rows = Int32Array.from({ length: n }, (_, i) => i);
  const m = fitRidge(X, Dd, rows, [0, 2], { a: y }, 1e-6).a;
  let err = 0;
  for (let i = 0; i < 100; i++) err = Math.max(err, Math.abs(ridgePredict(m, X, i * Dd) - y[i]));
  assert.ok(err < 0.02, `max error ${err}`);

  // one penalty per target equals fitting each target on its own
  const both = fitRidge(X, Dd, rows, [0, 2], { a: y, b: y }, { a: 1, b: 1e5 });
  const b = fitRidge(X, Dd, rows, [0, 2], { b: y }, 1e5).b;
  assert.deepEqual(both.b.w, b.w);
  assert.ok(Math.abs(both.b.w[0]) < Math.abs(both.a.w[0]) / 2, 'stronger penalty shrinks more');
});

test('gradient boosting learns a step and inference equals training traversal', () => {
  const rng = mulberry32(5);
  const n = 4000, Dd = 3;
  const X = new Float64Array(n * Dd), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < Dd; j++) X[i * Dd + j] = Math.round((rng() * 2 - 1) * 50) / 50; // discrete values hit thresholds exactly
    y[i] = (X[i * Dd + 1] > 0.2 ? 1 : -1) + 0.1 * (rng() - 0.5);
  }
  const rows = Int32Array.from({ length: n }, (_, i) => i);
  const m = fitGBDT(X, Dd, rows, y, [0, 1, 2], { trees: 60, depth: 2, lr: 0.2, minLeaf: 20, subsample: 0.8, colsample: 1, l2: 1 }, 1);
  let mse = 0, maxDiff = 0;
  for (let i = 0; i < n; i++) {
    const p = gbdtPredict(m, X, i * Dd);
    mse += (p - y[i]) ** 2;
    maxDiff = Math.max(maxDiff, Math.abs(p - m.trainPred[i]));
  }
  mse /= n;
  assert.ok(maxDiff < 1e-12, `threshold inference diverges from binned training: ${maxDiff}`);
  assert.ok(mse < 0.05, `mse ${mse}`);
});

function toyModel() {
  // experts: rw (0), "oracle-ish" (1), "anti" (2)
  return {
    experts: [{ id: 'rw', kind: 'zero' }, { id: 'good', kind: 'zero' }, { id: 'bad', kind: 'zero' }],
    resid: Object.fromEntries(HORIZONS.map((h) => [h, [-1.96, -1.2816, -0.6745, 0, 0.6745, 1.2816, 1.96]])),
  };
}

test('engine: hedge trusts the informative expert, conformal bands hit their coverage', () => {
  const rng = mulberry32(11);
  const g = () => { const u = Math.max(rng(), 1e-12); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
  const model = toyModel();
  const eng = new Engine(model, freshState(['rw', 'good', 'bad'], 0));
  const n = 30000, vol = 0.001;
  // price path where the 5-minute future return has a predictable component `sig`
  const sig = new Float64Array(n + 100), price = new Float64Array(n + 100);
  price[0] = 1;
  for (let i = 1; i < n + 100; i++) {
    sig[i] = 0.3 * g();
    // fat-ish tails so the Gaussian bands start mis-calibrated
    const shock = g() * (rng() < 0.1 ? 2.5 : 1);
    price[i] = price[i - 1] * Math.exp(vol * (shock + sig[i - 1] / Math.sqrt(1)));
  }
  const agg = emptyAgg();
  for (let i = 1; i < n; i++) {
    const mus = {};
    for (const h of HORIZONS) mus[h] = [0, sig[i] / Math.sqrt(h), -sig[i] / Math.sqrt(h)];
    const { resolved } = eng.step(i * MINUTE, price[i], vol, mus);
    for (const r of resolved) if (r.h === 5 && i > 10000) addResolution(agg, r);
  }
  const w = eng.weights(5);
  assert.ok(w[1] > w[0] && w[0] > w[2], `weights ${w}`);
  const s = summarize(agg);
  assert.ok(Math.abs(s.cov[1] - 0.8) < 0.02, `80% band coverage ${s.cov[1]}`);
  assert.ok(Math.abs(s.cov[0] - 0.5) < 0.02, `50% band coverage ${s.cov[0]}`);
  assert.ok(s.acc > 0.5, `accuracy ${s.acc}`);
});

test('engine: restoring from a snapshot continues almost exactly like the original', () => {
  const rng = mulberry32(2);
  const model = toyModel();
  const a = new Engine(model, freshState(['rw', 'good', 'bad'], 0));
  const price = [1];
  for (let i = 1; i < 3000; i++) price.push(price[i - 1] * Math.exp(0.001 * (rng() - 0.5)));
  const mus = (i) => Object.fromEntries(HORIZONS.map((h) => [h, [0, Math.sin(i) * 0.1, -Math.sin(i) * 0.1]]));
  for (let i = 1; i < 2000; i++) a.step(i * MINUTE, price[i], 0.001, mus(i));
  const b = new Engine(model, JSON.parse(JSON.stringify(a.snapshot())));
  for (let i = 2000; i < 3000; i++) {
    const pa = a.step(i * MINUTE, price[i], 0.001, mus(i)).pred;
    const pb = b.step(i * MINUTE, price[i], 0.001, mus(i)).pred;
    for (const h of HORIZONS) {
      assert.ok(Math.abs(pa.h[h].p - pb.h[h].p) < 1e-5);
      assert.ok(Math.abs(pa.h[h].hi[1] - pb.h[h].hi[1]) < 1e-7);
    }
  }
});

test('expertPredictions refuses rows with missing features', () => {
  const X = new Float64Array(2 * D).fill(0.1);
  X[D + 3] = NaN;
  const model = { experts: [{ id: 'rw', kind: 'zero' }] };
  assert.ok(expertPredictions(model, X, D, 0));
  assert.equal(expertPredictions(model, X, D, 1), null);
});

test('feature groups cover every feature exactly once', () => {
  const all = featureIndices(['micro', 'btc', 'trend', 'range', 'activity', 'time']);
  assert.equal(all.length, D);
  assert.equal(new Set(all).size, D);
  assert.equal(EXPERTS[0].id, 'rw');
});

test('evolution promotes only consistent winners', () => {
  const champ = { score: 0.1, perFold: [0.1, 0.1, 0.1, 0.1, 0.1] };
  // same average lead: one lucky day vs. a steady edge
  assert.equal(beats({ score: 0.2, perFold: [0.6, 0, 0, 0, -0.1] }, champ, 0.003), false);
  assert.equal(beats({ score: 0.2, perFold: [0.2, 0.21, 0.19, 0.2, 0.2] }, champ, 0.003), true);
  assert.equal(beats({ score: 0.101, perFold: [0.101, 0.101, 0.101, 0.101, 0.101] }, champ, 0.003), false);
});
