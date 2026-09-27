import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeries, indexOf, FNG_LAG, BAD_LEAD, BAD_PEER, BAD_TARGET, mergeFearGreed } from '../site/core/candles.js';
import { computeFeatures, targets, D, WARMUP, FEATURES, FEATURE_SCHEMA, featureIndices, GROUP_NAMES } from '../site/core/features.js';
import { ridgePredict, gbdtPredict, expertPredictions, directionScores, EXPERTS } from '../site/core/models.js';
import { Engine, freshState, decayFor, ORIGIN, STATE_VERSION } from '../site/core/engine.js';
import { directionOf, shownForecast } from '../site/core/forecast.js';
import { emptyAgg, addResolution, summarize } from '../site/core/metrics.js';
import { MINUTE, DAY_MIN, HORIZONS, CADENCE, MAX_H, ONLINE, NEUTRAL_EDGE, STRONG_MIN, SHADOW_HORIZONS, SHOW_MOVE, isIssue } from '../site/core/config.js';
import { fitRidge } from '../engine/ridge.mjs';
import { fitGBDT, mulberry32 } from '../engine/gbdt.mjs';
import { fitLogistic } from '../engine/logistic.mjs';
import { beats, makeDataset, trainRows } from '../engine/train.mjs';

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

test('series is gap-free, fills missing minutes flat and marks every filled source', () => {
  const { ada, btc } = synthCandles(50);
  const eth = btc.map((k) => ({ ...k, c: k.c / 20 }));
  const holey = ada.filter((_, i) => i !== 10 && i !== 11);
  const S = buildSeries(holey, btc.filter((_, i) => i !== 20), ada[49].t, { eth: eth.filter((_, i) => i !== 30) });
  assert.equal(S.t.length, 50);
  assert.equal(S.syn[10], 1);
  assert.equal(S.c[10], S.c[9]);
  assert.equal(S.v[11], 0);
  assert.equal(indexOf(S, ada[20].t), 20);
  assert.equal(S.bad[10], BAD_TARGET);
  assert.equal(S.bad[20], BAD_LEAD);
  assert.equal(S.bad[30], BAD_PEER);
  assert.equal(S.bc[20], S.bc[19]);
  assert.equal(S.bad[25], 0);
  // no peer data at all is missing data too
  assert.equal(buildSeries(ada, btc, ada[49].t).bad[5], BAD_PEER);
});

// A daily sentiment series stamped at 00:00 UTC, like the Fear & Greed index.
const fngSeries = (ada) => {
  const out = [];
  for (let t = Math.floor(ada[0].t / 86400000) * 86400000; t <= ada.at(-1).t; t += 86400000) out.push({ t, v: 20 + ((t / 86400000) % 7) * 10 });
  return out;
};

test('features are strictly causal (no lookahead)', () => {
  const { ada, btc } = synthCandles(WARMUP + 1200);
  const eth = btc.map((k) => ({ ...k, c: k.c / 20 }));
  const fng = fngSeries(ada);
  const full = buildSeries(ada, btc, ada[WARMUP + 1199].t, { eth, fng });
  const cut = WARMUP + 700;
  // the shorter history also lacks every sentiment value published after the cut
  const part = buildSeries(ada.slice(0, cut), btc.slice(0, cut), ada[cut - 1].t, { eth: eth.slice(0, cut), fng: fng.filter((x) => x.t + FNG_LAG <= ada[cut - 1].t + MINUTE) });
  const F1 = computeFeatures(full), F2 = computeFeatures(part);
  for (let i = WARMUP; i < cut; i++) {
    for (let j = 0; j < D; j++) {
      const a = F1.X[i * D + j], b = F2.X[i * D + j];
      assert.ok(Math.abs(a - b) <= 1e-9 * (1 + Math.abs(a)), `feature ${FEATURES[j]} row ${i}: ${a} vs ${b}`);
    }
    assert.equal(F1.vol[i], F2.vol[i]);
  }
  for (let j = 0; j < D; j++) assert.ok(Number.isFinite(F1.X[(WARMUP + 900) * D + j]), `feature ${FEATURES[j]} finite`);
  assert.ok(Number.isNaN(F1.X[(WARMUP - 1) * D]));
  // a strided computation gives the same rows on every issue minute
  const F3 = computeFeatures(full, WARMUP, CADENCE);
  let checked = 0;
  for (let i = WARMUP; i < WARMUP + 1200; i++) {
    if (!isIssue(full.t[i])) { assert.ok(Number.isNaN(F3.vol[i])); continue; }
    checked++;
    for (let j = 0; j < D; j++) assert.equal(F3.X[i * D + j], F1.X[i * D + j]);
  }
  assert.ok(checked > 50);
});

test('a sentiment value counts only from the minute it was public', () => {
  const { ada, btc } = synthCandles(3000);
  const day = Math.ceil(ada[0].t / 86400000) * 86400000;
  const S = buildSeries(ada, btc, ada.at(-1).t, { fng: [{ t: day - 86400000, v: 10 }, { t: day, v: 90 }] });
  const k = indexOf(S, day + FNG_LAG - MINUTE); // this candle closes exactly FNG_LAG after the stamp
  assert.equal(S.fg[k - 1], 10);
  assert.equal(S.fg[k], 90);
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
  const n = 120000, vol = 0.001, H = HORIZONS[0];
  // price path with a slowly drifting, persistent trend `a`: the next hour is partly predictable
  const a = new Float64Array(n + 2000), price = new Float64Array(n + 2000);
  price[0] = 1;
  for (let i = 1; i < n + 2000; i++) {
    a[i] = 0.998 * a[i - 1] + Math.sqrt(1 - 0.998 ** 2) * 0.04 * g();
    // fat-ish tails so the Gaussian bands start mis-calibrated
    const shock = g() * (rng() < 0.1 ? 2.5 : 1);
    price[i] = price[i - 1] * Math.exp(vol * (shock + a[i - 1]));
  }
  const agg = emptyAgg();
  for (let i = 1; i < n; i++) {
    const mus = {};
    for (const h of HORIZONS) mus[h] = [0, a[i] * Math.sqrt(h), -a[i] * Math.sqrt(h)];
    const { resolved } = eng.step(i * MINUTE, price[i], vol, mus);
    for (const r of resolved) if (r.h === H && i > 40000) addResolution(agg, r);
  }
  const w = eng.weights(H);
  assert.ok(w[1] > w[0] && w[0] > w[2], `weights ${w}`);
  const s = summarize(agg);
  assert.ok(Math.abs(s.cov[1] - 0.8) < 0.03, `80% band coverage ${s.cov[1]}`);
  assert.ok(Math.abs(s.cov[0] - 0.5) < 0.03, `50% band coverage ${s.cov[0]}`);
  assert.ok(s.acc > 0.5, `accuracy ${s.acc}`);
});

test('engine: restoring from a snapshot continues almost exactly like the original', () => {
  const rng = mulberry32(2);
  const model = toyModel();
  const a = new Engine(model, freshState(['rw', 'good', 'bad'], 0));
  const price = [1];
  for (let i = 1; i < 8000; i++) price.push(price[i - 1] * Math.exp(0.001 * (rng() - 0.5)));
  const mus = (i) => Object.fromEntries(HORIZONS.map((h) => [h, [0, Math.sin(i) * 0.1, -Math.sin(i) * 0.1]]));
  for (let i = 1; i < 5000; i++) a.step(i * MINUTE, price[i], 0.001, mus(i));
  const b = new Engine(model, JSON.parse(JSON.stringify(a.snapshot())));
  let n = 0;
  for (let i = 5000; i < 8000; i++) {
    const pa = a.step(i * MINUTE, price[i], 0.001, mus(i)).pred;
    const pb = b.step(i * MINUTE, price[i], 0.001, mus(i)).pred;
    assert.equal(!!pa, isIssue(i * MINUTE));
    if (!pa) continue;
    n++;
    for (const h of HORIZONS) {
      assert.ok(Math.abs(pa.h[h].p - pb.h[h].p) < 1e-5);
      assert.ok(Math.abs(pa.h[h].hi[1] - pb.h[h].hi[1]) < 1e-7);
    }
  }
  assert.equal(n, 3000 / CADENCE);
});

test('expertPredictions refuses rows with missing features', () => {
  const X = new Float64Array(2 * D).fill(0.1);
  X[D + 3] = NaN;
  const model = { experts: [{ id: 'rw', kind: 'zero' }] };
  assert.ok(expertPredictions(model, X, D, 0));
  assert.equal(expertPredictions(model, X, D, 1), null);
});

test('feature groups cover every feature exactly once', () => {
  const all = featureIndices(GROUP_NAMES);
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

// ---------------------------------------------------------------- v4 regression tests
// (the defects found in the September 2026 review; each test fails on v3's code)

test('a filled-in input suspends the feature row, and a filled-in outcome is no label', () => {
  const { ada, btc } = synthCandles(WARMUP + 400);
  const eth = btc.map((k) => ({ ...k, c: k.c / 20 }));
  const k = WARMUP + 200;
  // the lead has no candle at k, the coin none at k + 60
  const S = buildSeries(ada.filter((_, i) => i !== k + 60), btc.filter((_, i) => i !== k), ada.at(-1).t, { eth });
  const F = computeFeatures(S);
  assert.ok(Number.isNaN(F.X[k * D]) && Number.isNaN(F.vol[k]), 'lead candle missing: no row');
  assert.ok(Number.isFinite(F.vol[k + 1]), 'one gap in the last hour is tolerated');
  const z = targets(S, F.vol, 60);
  assert.ok(Number.isNaN(z[k + 1 - 1]), 'no row, no target');
  assert.ok(Number.isFinite(z[k + 3]), 'a real row with a real outcome');
  const zi = targets(S, F.vol.map((v, i) => (i === k ? 0.001 : v)), 60);
  assert.ok(Number.isNaN(zi[k]), 'outcome at k + 60 is a filled price');
  // many gaps in the last hour: no row, until they are an hour old
  const holes = new Set(Array.from({ length: 8 }, (_, q) => k + 100 + 5 * q));
  const S2 = buildSeries(ada, btc, ada.at(-1).t, { eth: eth.filter((_, q) => !holes.has(q)) });
  const F2 = computeFeatures(S2);
  assert.ok(Number.isNaN(F2.vol[k + 141]), 'eight filled peer minutes in the last hour');
  assert.ok(Number.isFinite(F2.vol[k + 100 + 5 * 7 + 61]), 'fine again once they are an hour old');
});

test('training rows never include a label that was unknown at fit time', () => {
  const { ada, btc } = synthCandles(WARMUP + 3 * DAY_MIN);
  const eth = btc.map((k) => ({ ...k, c: k.c / 20 }));
  const ds = makeDataset(buildSeries(ada, btc, ada.at(-1).t, { eth }));
  const s = ds.n - 100;
  const rows = trainRows(ds, s, 30);
  assert.ok(rows.length > 100);
  for (const i of rows) assert.ok(i + MAX_H < s, `row ${i} matures at ${i + MAX_H} >= ${s}`);
});

test('hour-of-week (week harmonics) is continuous across midnight and matches the week cycle', () => {
  const { ada, btc } = synthCandles(WARMUP + 3 * DAY_MIN);
  const eth = btc.map((k) => ({ ...k, c: k.c / 20 }));
  const S = buildSeries(ada, btc, ada.at(-1).t, { eth });
  const F = computeFeatures(S);
  const js = FEATURES.indexOf('wk2_s'), jc = FEATURES.indexOf('wk2_c'), ds_ = FEATURES.indexOf('dow_s'), dc = FEATURES.indexOf('dow_c');
  for (let i = WARMUP + 1; i < S.t.length; i++) {
    const a = F.X[(i - 1) * D + js], b = F.X[i * D + js];
    assert.ok(Math.abs(a - b) < 0.01, `jump at ${new Date(S.t[i]).toISOString()}`);
    // second harmonic of the week phase: sin(2x) = 2 sin x cos x
    const want = 2 * F.X[i * D + ds_] * F.X[i * D + dc];
    assert.ok(Math.abs(F.X[i * D + js] - want) < 1e-9);
    assert.ok(Math.abs(F.X[i * D + jc] ** 2 + F.X[i * D + js] ** 2 - 1) < 1e-9);
  }
  assert.equal(FEATURE_SCHEMA, 'f2');
});

test('Fear & Greed: first-seen wins, revisions are kept aside, order does not matter', () => {
  const day = Date.UTC(2026, 8, 20), now = day + 20 * MINUTE;
  const rec = [{ t: day - 86400000, v: 40, seen: day - 86400000 + 16 * MINUTE }];
  const fresh = [{ t: day - 86400000, v: 42 }, { t: day, v: 55 }];
  const a = mergeFearGreed(rec, fresh, now);
  const b = mergeFearGreed(rec, [...fresh].reverse(), now);
  assert.deepEqual(a, b);
  assert.equal(a[0].v, 40);
  assert.deepEqual(a[0].rev, [{ v: 42, seen: now }]);
  assert.equal(a[1].seen, now);
  // a backfilled old value, or anything at a fresh start, gets no first-seen time (FNG_LAG applies)
  assert.equal(mergeFearGreed([], [{ t: day - 5 * 86400000, v: 30 }], now)[0].seen, undefined);
  assert.equal(mergeFearGreed([], fresh, now, { backfill: true })[1].seen, undefined);
  // a value counts only once the pipeline had it
  const { ada, btc } = synthCandles(3000);
  const d0 = Math.ceil(ada[0].t / 86400000) * 86400000;
  const seen = d0 + 40 * MINUTE;
  const S = buildSeries(ada, btc, ada.at(-1).t, { fng: [{ t: d0 - 86400000, v: 10 }, { t: d0, v: 90, seen }] });
  assert.equal(S.fg[indexOf(S, d0 + FNG_LAG)], 10);
  assert.equal(S.fg[indexOf(S, seen - 2 * MINUTE)], 10);
  assert.equal(S.fg[indexOf(S, seen - MINUTE)], 90);
});

// A tiny engine harness: constant price, one horizon's worth of forecasts every 15 minutes.
function flatEngine() {
  const model = toyModel();
  const eng = new Engine(model, freshState(['rw', 'good', 'bad'], 0));
  return eng;
}
const zeroMus = () => Object.fromEntries(HORIZONS.map((h) => [h, [0, 0, 0]]));

test('forgetting runs on wall-clock time: an old loss halves after one half-life', () => {
  assert.ok(Math.abs(decayFor(ONLINE.hedgeHalfLifeMin, ONLINE.hedgeHalfLifeMin) - 0.5) < 1e-12);
  const eng = flatEngine();
  const T0 = Date.UTC(2026, 0, 5, 0, 14); // an issue minute
  const hs = eng.s.hedge[60];
  hs.L = [1, 1, 1]; hs.L0 = 1; hs.t = T0;
  // forecasts every 15 minutes for one half-life, flat price: no new loss, only decay
  const end = T0 + ONLINE.hedgeHalfLifeMin * MINUTE;
  for (let t = T0 + CADENCE * MINUTE; t <= end + 60 * MINUTE; t += CADENCE * MINUTE) eng.step(t, 1, 0.001, t <= end ? zeroMus() : null);
  assert.equal(hs.t, end);
  assert.ok(Math.abs(hs.L[0] - 0.5) < 1e-9, `left ${hs.L[0]}`); // v3: 0.955
});

test('forgetting skips no time: a gap in the forecasts decays by the time that passed', () => {
  const eng = flatEngine();
  const T0 = Date.UTC(2026, 0, 5, 0, 14);
  const hs = eng.s.hedge[60];
  hs.L = [1, 1, 1]; hs.L0 = 1; hs.t = T0;
  const T1 = T0 + 3 * DAY_MIN * MINUTE; // three days without a single forecast, then one
  eng.step(T1, 1, 0.001, zeroMus());
  eng.step(T1 + 60 * MINUTE, 1, 0.001, null);
  assert.ok(Math.abs(hs.L[0] - decayFor(3 * DAY_MIN, ONLINE.hedgeHalfLifeMin)) < 1e-12);
});

test('a tie skips the calibration update, but its time still counts', () => {
  const eng = flatEngine();
  const t = Date.UTC(2026, 0, 5, 0, 14);
  const pl = eng.s.platt[60];
  const a0 = pl.a;
  eng.step(t, 1, 0.001, Object.fromEntries(HORIZONS.map((h) => [h, [0, 0.5, -0.5]])));
  eng.step(t + 60 * MINUTE, 1, 0.001, null); // same price: a tie
  assert.equal(pl.a, a0);
  assert.equal(pl.t, null);
});

test('an unavailable outcome teaches nothing and is not scored as a flat move', () => {
  const eng = flatEngine();
  const t = Date.UTC(2026, 0, 5, 0, 14);
  eng.step(t, 1, 0.001, Object.fromEntries(HORIZONS.map((h) => [h, [0, 1, -1]])));
  const before = JSON.stringify(eng.s.hedge[60]);
  const { resolved } = eng.step(t + 60 * MINUTE, 1, 0.001, null, null, { real: false });
  assert.equal(resolved.length, 1);
  assert.ok(resolved[0].unavailable);
  assert.equal(JSON.stringify(eng.s.hedge[60]), before);
  const a = addResolution(emptyAgg(), resolved[0]);
  assert.equal(a.n, 0);
  assert.equal(a.nu, 1);
});

test('a repeated outcome is ignored by the learners', () => {
  const eng = flatEngine();
  const t = Date.UTC(2026, 0, 5, 0, 14);
  eng.step(t, 1, 0.001, zeroMus());
  const dup = structuredClone(eng.s.pending.find((p) => p[1] === 60));
  eng.step(t + 60 * MINUTE, 1.01, 0.001, null);
  const L = [...eng.s.hedge[60].L];
  eng.s.pending.push(dup);
  eng.step(t + 61 * MINUTE, 1.02, 0.001, null);
  assert.deepEqual(eng.s.hedge[60].L, L);
});

test('the three ranges are always nested', () => {
  const eng = flatEngine();
  for (const h of HORIZONS) eng.s.aci[h] = [1.5, -1.2, -1.2]; // allowed extremes that used to cross
  const t = Date.UTC(2026, 0, 5, 0, 14);
  const { pred } = eng.step(t, 1, 0.001, zeroMus());
  for (const h of HORIZONS) {
    const { lo, hi } = pred.h[h];
    assert.ok(lo[2] <= lo[1] && lo[1] <= lo[0] && lo[0] <= hi[0] && hi[0] <= hi[1] && hi[1] <= hi[2], JSON.stringify({ lo, hi }));
  }
});

test('the shown price is exactly what is stored and scored', () => {
  for (const showMove of [false, true]) {
    const eng = new Engine(toyModel(), freshState(['rw', 'good', 'bad'], 0), { showMove });
    for (const h of HORIZONS) { eng.s.est[h].sxy = 50; eng.s.est[h].sxx = 100; } // beta ~0.485
    const t = Date.UTC(2026, 0, 5, 0, 14);
    const dir = Object.fromEntries(HORIZONS.map((h) => [h, { d: 3 }]));
    const { pred } = eng.step(t, 64321.37, 0.001, zeroMus(), dir);
    const x = pred.h[60];
    assert.equal(x.direction, 'up');
    const f = shownForecast(pred.c, x.p, x.lo[1], x.hi[1], eng.beta(60), showMove);
    assert.equal(x.price, f.price);
    assert.equal(x.est, Math.log(x.price / pred.c));
    assert.ok(x.shrunk > 0, 'the shrunk move is computed either way');
    if (showMove) assert.ok(x.price > pred.c); else assert.equal(x.price, pred.c);
    const { resolved } = eng.step(t + 60 * MINUTE, 64400, 0.001, null);
    const r = resolved.find((q) => q.h === 60);
    assert.equal(r.est, x.est);
    const a = addResolution(emptyAgg(), r);
    assert.equal(a.ae, Math.abs(Math.log(64400 / 64321.37) - Math.log(x.price / 64321.37)));
  }
  assert.equal(SHOW_MOVE, false, 'production shows today\'s price (docs/EXPERIMENTS.md, rule 7)');
});

test('a "no reliable signal" horizon shows 50% while its model is measured in the background', () => {
  const eng = flatEngine();
  let t = Date.UTC(2026, 0, 5, 0, 14), price = 100;
  let last = null;
  for (let k = 0; k < 200; k++, t += CADENCE * MINUTE) {
    price *= 1.0005; // always up, and the model always says up
    last = eng.step(t, price, 0.001, zeroMus(), Object.fromEntries(HORIZONS.map((h) => [h, { d: 2 }]))).pred;
  }
  for (const h of SHADOW_HORIZONS) {
    assert.ok(last.h[h].shadow && last.h[h].p === 0.5 && last.h[h].direction === 'neutral' && !last.h[h].strong);
    assert.ok(last.h[h].pModel > 0.5);
    assert.ok(eng.s.gate[h].n > 0 && eng.s.gate[h].g > 0, 'background score of the model');
  }
  assert.ok(!last.h[60].shadow && last.h[60].p > 0.5);
});

test('a 50% forecast is no call: never counted right or wrong', () => {
  assert.equal(directionOf(0.5), 'neutral');
  assert.equal(directionOf(0.5 + NEUTRAL_EDGE / 2), 'neutral');
  assert.equal(directionOf(0.5 + NEUTRAL_EDGE), 'up');
  assert.equal(directionOf(0.5 - NEUTRAL_EDGE), 'down');
  const r = { t: Date.UTC(2026, 0, 5, 0, 59), h: 60, y: 0.001, z: 0.2, mu: 0, ret: 0, est: 0, p: 0.5, strong: true, inb: [true, true, true], lo: [-1, -1, -1], hi: [1, 1, 1] };
  const a = addResolution(emptyAgg(), r);
  assert.equal(a.nm, 1);
  assert.equal(a.nc, 0);
  assert.equal(a.ni, 0);
  assert.equal(a.nin, 1);
  assert.equal(a.sni, 0);
  assert.ok(Math.abs(a.ll - Math.LN2) < 1e-12);
  assert.equal(summarize(a).callShare, 0);
});

test('"strong signal" is judged against recent forecasts only, and needs a day of them', () => {
  const eng = flatEngine();
  let t = Date.UTC(2026, 0, 5, 0, 14);
  const strong = [];
  for (let k = 0; k < STRONG_MIN + 40; k++, t += CADENCE * MINUTE) {
    const d = (k % 10) / 3 + 0.2; // repeating spread of signal strengths
    const { pred } = eng.step(t, 1, 0.001, zeroMus(), Object.fromEntries(HORIZONS.map((h) => [h, { d }])));
    strong.push(pred.h[60].strong);
  }
  assert.ok(strong.slice(0, STRONG_MIN).every((x) => !x), 'no history, no strong call');
  const later = strong.slice(STRONG_MIN);
  const share = later.filter(Boolean).length / later.length;
  assert.ok(share > 0.35 && share < 0.65, `share ${share}`);
});

test('checkpoints: incompatible versions and broken numbers fail loudly', () => {
  const model = toyModel();
  assert.throws(() => new Engine(model, { ...freshState(['rw'], 0), v: 1 }), /version/);
  assert.throws(() => new Engine({ ...model, featureSchema: 'f1' }, freshState(['rw', 'good', 'bad'], 0)), /schema/);
  assert.equal(new Engine({ ...model, featureSchema: FEATURE_SCHEMA }, freshState(['rw', 'good', 'bad'], 0)).s.v, STATE_VERSION);
  const eng = flatEngine();
  eng.s.hedge[60].L[1] = NaN;
  assert.throws(() => eng.snapshot(), /non-finite/);
});

test('stepping only issue minutes gives the same forecasts as stepping every minute', () => {
  const rng = mulberry32(9);
  const price = [1];
  for (let i = 1; i < 4000; i++) price.push(price[i - 1] * Math.exp(0.001 * (rng() - 0.5)));
  const mus = (i) => Object.fromEntries(HORIZONS.map((h) => [h, [0, Math.sin(i / 7) * 0.2, -Math.sin(i / 7) * 0.2]]));
  const dir = (i) => Object.fromEntries(HORIZONS.map((h) => [h, { d: Math.cos(i / 5) }]));
  const a = flatEngine(), b = flatEngine();
  const pa = [], pb = [];
  for (let i = 1; i < 4000; i++) {
    const t = i * MINUTE;
    const r = a.step(t, price[i], 0.001, mus(i), dir(i));
    if (r.pred) pa.push(r.pred);
    if (isIssue(t)) { const q = b.step(t, price[i], 0.001, mus(i), dir(i)); if (q.pred) pb.push(q.pred); }
  }
  assert.equal(pa.length, pb.length);
  for (let k = 0; k < pa.length; k++) for (const h of HORIZONS) { assert.equal(pa[k].h[h].p, pb[k].h[h].p); assert.equal(pa[k].h[h].price, pb[k].h[h].price); }
});

test('direction models: logistic regression, weights and "no signal" horizons', () => {
  const rng = mulberry32(4);
  const n = 6000, Dd = 3;
  const X = new Float64Array(n * Dd), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < Dd; j++) X[i * Dd + j] = rng() * 2 - 1;
    y[i] = rng() < 1 / (1 + Math.exp(-(1.5 * X[i * Dd] - 0.8 * X[i * Dd + 2]))) ? 1 : 0;
  }
  const rows = Int32Array.from({ length: n }, (_, i) => i);
  const m = fitLogistic(X, Dd, rows, [0, 1, 2], y, 1e-3);
  const w0 = m.w[0] / m.std[0], w2 = m.w[2] / m.std[2];
  assert.ok(Math.abs(w0 - 1.5) < 0.2 && Math.abs(w2 + 0.8) < 0.2, `coefficients ${w0} ${w2}`);
  // uniform weights change nothing
  const yy = { a: Float64Array.from(y, (v) => 2 * v - 1) };
  assert.deepEqual(fitRidge(X, Dd, rows, [0, 2], yy, 10).a.w, fitRidge(X, Dd, rows, [0, 2], yy, 10, new Float64Array(n).fill(3)).a.w);
  // a horizon without a model scores 0 (P(up) stays 50%: no call)
  const Xr = new Float64Array(D).fill(0.1);
  const lin = { idx: [0], mean: [0], std: [1], w: [1], b: 0 };
  const dm = { kind: 'logit', h: { 60: { lin, sa: 1 }, 180: null, 1440: null } };
  const s = directionScores({ direction: dm }, Xr, D, 0);
  assert.ok(Math.abs(s[60].d - 0.1) < 1e-12);
  assert.equal(s[180].d, 0);
});

test('the signal gate hides a model that loses to a coin, and keeps one that wins', () => {
  // calibration frozen (huge prior information), so the gate alone decides
  const run = (sign) => {
    const st = freshState(['rw', 'good', 'bad'], 0);
    for (const h of HORIZONS) { st.platt[h].a = 3; st.platt[h].H = [1e9, 0, 1e9]; }
    const eng = new Engine(toyModel(), st, { gate: true, online: { plattHalfLifeMin: 1e12 } });
    const rng = mulberry32(21);
    let t = Date.UTC(2026, 0, 5, 0, 14), price = 100, sig = 1;
    let last = null;
    for (let k = 0; k < 3000; k++, t += 60 * MINUTE) {
      // the hour after each forecast goes where sign * its signal says, 75% of the time
      if (k) price *= Math.exp(0.001 * (rng() < 0.75 ? sign * sig : -sign * sig));
      sig = rng() < 0.5 ? 1 : -1;
      last = eng.step(t, price, 0.001, zeroMus(), Object.fromEntries(HORIZONS.map((h) => [h, { d: 2 * sig }]))).pred.h[60];
    }
    return { eng, last };
  };
  const bad = run(-1), good = run(1);
  assert.equal(bad.eng.s.gate[60].on, false);
  assert.ok(bad.last.gated && bad.last.p === 0.5 && bad.last.direction === 'neutral');
  assert.notEqual(bad.last.pModel, 0.5, 'the model itself is still computed and scored in the background');
  assert.equal(good.eng.s.gate[60].on, true);
  assert.ok(!good.last.gated && good.last.p !== 0.5);
});

test('a release switches the record from data/launch: old one archived unchanged, safe to repeat', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { switchToLaunch } = await import('../engine/run.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-test-'));
  const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  w('predictions/2026-09-26.csv', 'v3 rows'); w('daily/2026-09.json', 'v3 daily'); w('model.json', 'v3 model'); w('status.json', 'v3 status');
  w('archive/v2-ranges/README.md', 'older archive');
  w('archive/v3-direction/README.md', 'what v3 was');
  w('launch/ARCHIVE_AS', 'v3-direction\n'); w('launch/model.json', 'v4 model'); w('launch/state.json', 'v4 state'); w('launch/daily/2026-09.json', 'v4 daily'); w('launch/backtest/2025-09.csv', 'v4 backtest');
  // a crash half-way: the model was archived, nothing else yet
  fs.renameSync(path.join(root, 'model.json'), path.join(root, 'archive/v3-direction/model.json'));
  assert.equal(switchToLaunch(root), 'v3-direction');
  assert.equal(r('archive/v3-direction/model.json'), 'v3 model');
  assert.equal(r('archive/v3-direction/predictions/2026-09-26.csv'), 'v3 rows');
  assert.equal(r('archive/v3-direction/daily/2026-09.json'), 'v3 daily');
  assert.equal(r('archive/v3-direction/status.json'), 'v3 status');
  assert.equal(r('archive/v3-direction/README.md'), 'what v3 was');
  assert.equal(r('archive/v2-ranges/README.md'), 'older archive');
  assert.equal(r('model.json'), 'v4 model');
  assert.equal(r('state.json'), 'v4 state');
  assert.equal(r('daily/2026-09.json'), 'v4 daily');
  assert.equal(r('backtest/2025-09.csv'), 'v4 backtest');
  assert.ok(!fs.existsSync(path.join(root, 'launch')) && !fs.existsSync(path.join(root, 'predictions')));
  assert.equal(switchToLaunch(root), null, 'nothing to do once switched');
  assert.equal(r('model.json'), 'v4 model');
  fs.rmSync(root, { recursive: true, force: true });
});
