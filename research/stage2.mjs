#!/usr/bin/env node
// Stage 2 of the September 2026 evaluation: replays the online layer (engine.js) over the model
// outputs Stage 1 recorded, in many variants, and scores every variant on identical forecasts.
// Seconds per variant, because no model is refit here.
//
// Preregistered (written before any Stage 2 result was seen):
//   Periods. P0 = 24 Sep 2024 .. 23 Sep 2025: untouched (no setting of either project was
//   chosen on it). P12 = 24 Sep 2025 .. 24 Sep 2026, split into "tuning" (.. 24 May 2026, where
//   the v3 direction settings were chosen on Bitcoin) and "later" (inspected during the review).
//   Choices. Made on Bitcoin's P12 tuning part only, by log loss of P(up) pooled over 1 h and
//   3 h; differences below 0.00005 nats per forecast count as ties and keep the default. P0 (both
//   coins) is then a pass/fail gate for anything that goes to production: a change must not be
//   worse there. The live record is the final test.
//   Direction models: DIRECTION_CANDIDATES (engine/train.mjs), each replayed with its own
//   online calibration, plus a sequential selection rule that only looks backwards: every day,
//   per horizon, use the candidate with the lowest log loss over the last 90 days of matured
//   forecasts; switch only when it beats the current choice by >= 0.0003 nats; fall back to
//   "no signal" (50%) when the choice is worse than a coin by >= 0.0003 nats, and come back when
//   a candidate beats the coin by that much; the incumbent for the first 60 days.
//   Signal gate (engine ONLINE.gate): the same idea inside the engine, per horizon, with a
//   45-day half-life, 0.0003 nats hysteresis and 500 forecasts of evidence before switching.
//   Uncertainty: week-block bootstrap (2000 draws) of the scores and of paired differences.
//
//   node --max-old-space-size=8192 research/stage2.mjs [--final production] [--dir .cache/research] [--out ...]
import fs from 'node:fs';
import path from 'node:path';
import { readParts } from './lib.mjs';
import { Engine, freshState } from '../site/core/engine.js';
import { emptyAgg, addResolution, mergeAgg, summarize } from '../site/core/metrics.js';
import { HORIZONS, MINUTE, ONLINE, ASSET, DAY_MIN, SHADOW_HORIZONS, SHOW_MOVE } from '../site/core/config.js';
import { EXPERTS } from '../site/core/models.js';
import { mulberry32 } from '../engine/gbdt.mjs';
import { execSync } from 'node:child_process';
import { DIRECTION_CANDIDATES, DIRECTION_LIVE } from '../engine/train.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = path.resolve(arg('--dir', '.cache/research'));
const OUT = path.resolve(arg('--out', `research/results/stage2-${ASSET.ticker.toLowerCase()}.json`));
// --final production: one more variant, "final", with the production configuration of
// site/core/config.js and engine/train.mjs DIRECTION_LIVE (scored like every other variant)
const FINAL = arg('--final') === 'production'
  ? { opt: { online: { ...ONLINE }, shadow: [...SHADOW_HORIZONS], showMove: SHOW_MOVE, gate: ONLINE.gate }, dir: Object.fromEntries(HORIZONS.map((h) => [h, ({ ridge: 'ridge240' })[DIRECTION_LIVE.perHorizon?.[h]?.kind] || 'pair240'])) }
  : arg('--final') ? JSON.parse(arg('--final')) : null;
// Every preregistered variant runs on the v4 settings as they were when the rules were fixed
// (so rerunning this reproduces the same numbers after config.js changes); a variant's own
// options override these.
const V4 = { online: { hedgeEta: 0.2, hedgeHalfLifeMin: 14 * DAY_MIN, plattHalfLifeMin: 30 * DAY_MIN, plattPrior: 2000, estHalfLifeMin: 60 * DAY_MIN, estPrior: 3, gate: false, gateHalfLifeMin: 45 * DAY_MIN, gateDelta: 3e-4, gateMinN: 500 }, shadow: [], showMove: true, gate: false };
const withV4 = (opt = {}) => ({ ...V4, ...opt, online: { ...V4.online, ...(opt.online || {}) } });
const DAY = 86400000;
const ids = EXPERTS.map((e) => e.id);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const iso = (t) => new Date(t).toISOString().slice(0, 10);

const PERIODS = [
  { name: 'P0', files: ['P0-1.bin', 'P0-2.bin'], evo: 'P0-evo.bin', splits: { untouched: ['2024-09-24', '2025-09-23'] } },
  { name: 'P12', files: ['P12-1.bin', 'P12-2.bin'], evo: 'P12-evo.bin', splits: { tuning: ['2025-09-24', '2026-05-24'], later: ['2026-05-25', '2026-09-24'] } },
];
const HL = (h, p, e) => ({ hedgeHalfLifeMin: h * DAY_MIN, plattHalfLifeMin: p * DAY_MIN, estHalfLifeMin: e * DAY_MIN });
const POLICY = { lookbackDays: 90, delta: 3e-4, burnDays: 60 };
const TIE = 5e-5;

// ---------------------------------------------------------------- data

function loadPeriod(P) {
  const have = (f) => fs.existsSync(path.join(DIR, f));
  if (!P.files.every(have)) return null;
  const cand = readParts(P.files.map((f) => path.join(DIR, f)));
  const evo = have(P.evo) ? readParts([path.join(DIR, P.evo)]) : null;
  const evoByT = evo ? new Map(evo.rows.map((r) => [r[0], r])) : null;
  const dayByT = new Map(cand.days.map((d) => [d[0], d]));
  const cByT = new Map(cand.rows.map((r) => [r[0], r]));
  return { ...P, cand, evo, evoByT, dayByT, cByT, col: cand.col, dcol: cand.dayCol };
}

const residOf = (per, d) => Object.fromEntries(HORIZONS.map((h) => [h, [0, 1, 2, 3, 4, 5, 6].map((q) => d[per.dcol[`resid_${h}_${q}`]])]));

function musOf(r, col, prefix) {
  const o = {};
  for (const h of HORIZONS) {
    const a = new Array(ids.length);
    for (let q = 0; q < ids.length; q++) { const v = r[col[`${prefix}_${ids[q]}_${h}`]]; if (!Number.isFinite(v)) return null; a[q] = v; }
    o[h] = a;
  }
  return o;
}

// direction score of a source on an issue-minute record (null: the model had no fit that day)
function dirOf(per, r, srcArg, dayRec, stack) {
  const c = per.col, o = {};
  for (const h of HORIZONS) {
    const src = typeof srcArg === 'object' ? srcArg[h] : srcArg;
    let d;
    if (src === 'ridge240') d = r[c[`pair240_a_${h}`]];
    else if (src === 'gbdt240') d = r[c[`pair240_b_${h}`]];
    else if (src === 'frozen') d = 0.5 * (r[c[`frozen_a_${h}`]] + r[c[`frozen_b_${h}`]]);
    else if (src === 'stack') { const w = stack && stack.get(Math.floor(r[0] / DAY) * DAY); d = w ? (w[h][0] * r[c[`pair240_a_${h}`]] + w[h][1] * r[c[`pair240_b_${h}`]]) : 0.5 * (r[c[`pair240_a_${h}`]] + r[c[`pair240_b_${h}`]]); }
    else if ((DIRECTION_CANDIDATES[src].kind || 'pair') === 'pair') d = 0.5 * (r[c[`${src}_a_${h}`]] + r[c[`${src}_b_${h}`]]);
    else d = r[c[`${src}_${h}`]];
    if (!Number.isFinite(d)) return null;
    const thrKey = `thr_${src === 'ridge240' || src === 'gbdt240' || src === 'stack' ? 'pair240' : src}_${h}`;
    o[h] = { d: Math.max(-5, Math.min(5, d)), thr: dayRec ? dayRec[per.dcol[thrKey]] : undefined };
  }
  return o;
}

// ---------------------------------------------------------------- replay

function replay(per, { dir = 'pair240', opt: rawOpt = {}, mus = 'mu', stack = null, resid = null, pinned = true } = {}) {
  const rows = per.cand.rows;
  const opt = pinned ? withV4(rawOpt) : rawOpt;
  const eng = new Engine({ experts: ids.map((id) => ({ id })), resid: null }, freshState(ids, rows[0][0] - MINUTE, { ...ONLINE, ...(opt.online || {}) }), opt);
  const recs = [];
  let day = null, dayRec = null;
  for (const r of rows) {
    const t = r[0], d = Math.floor(t / DAY) * DAY;
    if (d !== day) { day = d; dayRec = per.dayByT.get(d) || null; if (dayRec) eng.model = { experts: ids.map((id) => ({ id })), resid: (resid && resid.get(d)) || residOf(per, dayRec) }; }
    let m = null, dr = null;
    if (r[4] === 1 && dayRec && eng.model.resid) {
      if (mus === 'evo') { const e = per.evoByT && per.evoByT.get(t); m = e ? musOf(e, per.evo.col, 'mu') : null; } else m = musOf(r, per.col, mus);
      if (m && dir) dr = dirOf(per, r, dir, dayRec, stack);
    }
    const { resolved } = eng.step(t, r[1], r[2], m, dr, { real: r[3] === 1 });
    for (const x of resolved) { delete x.mus; recs.push(x); } // the experts' values aren't needed here
  }
  return recs;
}

// ---------------------------------------------------------------- scoring

function splitOf(per, t) {
  const d = iso(t);
  for (const [name, [a, b]] of Object.entries(per.splits)) if (d >= a && d <= b) return name;
  return null;
}

// weekly aggregates per split and horizon
function aggregate(per, recs) {
  const out = {};
  for (const r of recs) {
    const sp = splitOf(per, r.t);
    if (!sp) continue;
    const wk = Math.floor((r.t - Date.parse(per.splits[sp][0] + 'T00:00:00Z')) / (7 * DAY));
    const o = ((out[sp] ||= {})[r.h] ||= []);
    addResolution((o[wk] ||= emptyAgg()), r);
  }
  for (const sp of Object.keys(out)) for (const h of Object.keys(out[sp])) out[sp][h] = Array.from(out[sp][h], (x) => x || emptyAgg());
  return out;
}

const total = (weeks) => weeks.reduce((a, w) => mergeAgg(a, w), emptyAgg());
const KEYS = ['llGain', 'bss', 'accI', 'strongAccI', 'callShare', 'strongShare', 'mseSkill', 'maeSkill', 'above'];

// Aggregates as flat vectors, so a bootstrap draw is a few vector additions.
const TEMPLATE = emptyAgg();
const LAYOUT = Object.entries(TEMPLATE).flatMap(([k, v]) => (Array.isArray(v) ? v.map((_, j) => [k, j]) : [[k, -1]]));
function toVec(a) { const v = new Float64Array(LAYOUT.length); LAYOUT.forEach(([k, j], i) => { v[i] = j < 0 ? a[k] : a[k][j]; }); return v; }
function fromVec(v) { const a = emptyAgg(); LAYOUT.forEach(([k, j], i) => { if (j < 0) a[k] = v[i]; else a[k][j] = v[i]; }); return a; }
const vecCache = new WeakMap();
const vecs = (weeks) => { let v = vecCache.get(weeks); if (!v) vecCache.set(weeks, (v = weeks.map(toVec))); return v; };

function stats(weeksList, fn, B = 2000, seed = 7) {
  const rng = mulberry32(seed);
  const V = weeksList.map(vecs);
  const n = V[0].length, L = LAYOUT.length;
  const draws = [];
  const acc = V.map(() => new Float64Array(L));
  for (let b = 0; b < B; b++) {
    for (const a of acc) a.fill(0);
    for (let q = 0; q < n; q++) {
      const k = Math.floor(rng() * n);
      for (let m = 0; m < V.length; m++) { const src = V[m][k], dst = acc[m]; for (let i = 0; i < L; i++) dst[i] += src[i]; }
    }
    const v = fn(acc.map(fromVec));
    if (v !== null && Number.isFinite(v)) draws.push(v);
  }
  draws.sort((a, b) => a - b);
  return draws.length ? [draws[Math.floor(0.025 * draws.length)], draws[Math.floor(0.975 * draws.length)]] : null;
}

const r6 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(6)));
function summary(weeks, withCi = true) {
  const s = summarize(total(weeks));
  if (!s) return null;
  const o = { n: s.n, ni: s.ni, sni: s.sni, unavailable: s.unavailable };
  for (const k of [...KEYS, 'logloss', 'brier']) o[k] = r6(s[k]);
  o.cov = s.cov.map(r6); o.width_bp = s.width.map((x) => r6(x * 1e4)); o.iscore_bp = s.iscore.map((x) => r6(x * 1e4));
  o.mae_bp = r6(s.mae * 1e4); o.rmse_bp = r6(s.rmse * 1e4); o.ensMseSkill = r6(s.ensMseSkill);
  if (withCi) { o.ci = {}; for (const k of ['llGain', 'accI', 'strongAccI', 'mseSkill']) o.ci[k] = stats([weeks], ([a]) => { const q = summarize(a); return q ? q[k] : null; })?.map(r6) || null; }
  return o;
}

// paired difference A - B of a statistic (a key of metrics.summarize, or a function of it),
// with a week-block interval
function paired(wa, wb, k) {
  const get = typeof k === 'function' ? k : (s) => s[k];
  const f = ([a, b]) => { const x = summarize(a), y = summarize(b); if (!x || !y) return null; const u = get(x), v = get(y); return u !== null && v !== null && u !== undefined && v !== undefined ? u - v : null; };
  const est = f([total(wa), total(wb)]);
  return est === null ? null : [r6(est), ...(stats([wa, wb], f) || [null, null]).map(r6)];
}

// Range shapes from past out-of-sample residuals: for each day, the quantiles (at Q_LEVELS, centred
// on the median like the production ones) of z - mu over the last 30 days of matured forecasts.
function residualShapes(per, recs) {
  const Q = [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975];
  const byH = {};
  for (const r of recs) if (!r.unavailable) (byH[r.h] ||= []).push(r);
  for (const h of Object.keys(byH)) byH[h].sort((a, b) => a.t + a.h * MINUTE - (b.t + b.h * MINUTE));
  const days = [...new Set(per.cand.rows.map((r) => Math.floor(r[0] / DAY) * DAY))].sort((a, b) => a - b);
  const out = new Map();
  for (const D of days) {
    const o = {};
    let ok = true;
    for (const h of HORIZONS) {
      const v = (byH[h] || []).filter((r) => r.t + h * MINUTE <= D && r.t >= D - 30 * DAY).map((r) => r.z - r.mu).sort((a, b) => a - b);
      if (v.length < 500) { ok = false; break; }
      const q = (p) => { const pos = p * (v.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return v[lo] + (v[hi] - v[lo]) * (pos - lo); };
      const med = q(0.5);
      o[h] = Q.map((p) => q(p) - med);
    }
    if (ok) out.set(D, o);
  }
  return out;
}

// ---------------------------------------------------------------- baselines and the policy

const keyOf = (r) => `${r.t}_${r.h}`;
const llOf = (p, y) => (y > 0 ? -Math.log(Math.max(p, 1e-6)) : -Math.log(Math.max(1 - p, 1e-6)));

// Past-only baselines, built on the incumbent's records (only P(up), the call and the shown
// price change): a coin, the recent up-share, and momentum-or-reversal (whichever has been
// right more often lately).
function baselines(per, inc) {
  const byH = {};
  for (const r of inc) if (!r.unavailable) (byH[r.h] ||= []).push(r);
  const out = { coin: [], upShare30: [], momRev30: [] };
  for (const h of HORIZONS) {
    const list = (byH[h] || []).sort((a, b) => a.t - b.t);
    const matured = []; // [maturity time, up, momentum right]
    let j = 0;
    for (const r of list) {
      while (j < list.length && list[j].t + list[j].h * MINUTE <= r.t) {
        const q = list[j];
        const prev = per.cByT.get(q.t - h * MINUTE);
        const s = prev ? Math.sign(Math.log(q.c0 / prev[1])) : 0;
        if (q.y !== 0) matured.push([q.t + h * MINUTE, q.y > 0 ? 1 : 0, s === 0 ? null : (Math.sign(q.y) === s ? 1 : 0)]);
        j++;
      }
      const from = r.t - 30 * DAY;
      let up = 0, n = 0, mr = 0, mn = 0;
      for (let k = matured.length - 1; k >= 0 && matured[k][0] > from; k--) { up += matured[k][1]; n++; if (matured[k][2] !== null) { mr += matured[k][2]; mn++; } }
      const prev = per.cByT.get(r.t - h * MINUTE);
      const s = prev ? Math.sign(Math.log(r.c0 / prev[1])) : 0;
      const pShare = n > 50 ? Math.min(0.7, Math.max(0.3, up / n)) : 0.5;
      const edge = mn > 50 ? Math.max(-0.1, Math.min(0.1, mr / mn - 0.5)) : 0;
      out.coin.push({ ...r, p: 0.5, strong: false, est: 0 });
      out.upShare30.push({ ...r, p: pShare, strong: false, est: 0 });
      out.momRev30.push({ ...r, p: 0.5 + edge * s, strong: false, est: 0 });
    }
  }
  return out;
}

// Stacked blend of the incumbent's two parts, weights from a logistic fit on the last 60 days of
// matured forecasts (per horizon, refit daily; scaled back to "typical signal" units).
function stackWeights(per, inc) {
  const c = per.col;
  const byH = {};
  for (const r of inc) if (!r.unavailable && r.y !== 0) (byH[r.h] ||= []).push(r);
  const days = [...new Set(per.cand.rows.map((r) => Math.floor(r[0] / DAY) * DAY))].sort((a, b) => a - b);
  const W = new Map();
  for (const h of HORIZONS) {
    const list = (byH[h] || []).map((r) => { const row = per.cByT.get(r.t); return { t: r.t, m: r.t + h * MINUTE, u: r.y > 0 ? 1 : 0, a: row[c[`pair240_a_${h}`]], b: row[c[`pair240_b_${h}`]] }; }).filter((x) => Number.isFinite(x.a) && Number.isFinite(x.b));
    for (const D of days) {
      const tr = list.filter((x) => x.m <= D && x.t >= D - 60 * DAY);
      let w = [0.5, 0.5];
      if (tr.length > 500) {
        // 2-parameter logistic regression through the origin, L2 toward the equal blend
        let wa = 0.05, wb = 0.05;
        const lam = 50;
        for (let it = 0; it < 20; it++) {
          let ga = lam * (wa - 0.05), gb = lam * (wb - 0.05), haa = lam, hab = 0, hbb = lam;
          for (const x of tr) { const q = 1 / (1 + Math.exp(-(wa * x.a + wb * x.b))); const e = q - x.u, v = q * (1 - q); ga += e * x.a; gb += e * x.b; haa += v * x.a * x.a; hab += v * x.a * x.b; hbb += v * x.b * x.b; }
          const det = haa * hbb - hab * hab;
          wa -= (hbb * ga - hab * gb) / det; wb -= (haa * gb - hab * ga) / det;
        }
        let s2 = 0;
        for (const x of tr) s2 += (wa * x.a + wb * x.b) ** 2;
        const rms = Math.sqrt(s2 / tr.length) || 1;
        w = [wa / rms, wb / rms];
      }
      (W.get(D) || W.set(D, {}).get(D))[h] = w;
    }
  }
  return W;
}

function runPolicy(cands, inc) {
  // cands: {name: recs}; returns {recs, choices}
  const maps = Object.fromEntries(Object.entries(cands).map(([k, recs]) => [k, new Map(recs.map((r) => [keyOf(r), r]))]));
  const names = Object.keys(cands);
  const out = [], choices = {};
  for (const h of HORIZONS) {
    const incH = inc.filter((r) => r.h === h).sort((a, b) => a.t - b.t);
    if (!incH.length) continue;
    // daily log-loss sums by maturity day, per candidate
    const sums = Object.fromEntries(names.map((k) => [k, new Map()]));
    for (const r of incH) {
      if (r.unavailable || r.y === 0) continue;
      const md = Math.floor((r.t + h * MINUTE) / DAY) * DAY;
      for (const k of names) {
        const x = maps[k].get(keyOf(r));
        if (!x) continue;
        const cur = sums[k].get(md) || [0, 0];
        cur[0] += llOf(x.p, r.y); cur[1]++;
        sums[k].set(md, cur);
      }
    }
    const start = Math.floor(incH[0].t / DAY) * DAY;
    let choice = 'pair240';
    choices[h] = [];
    let lastDay = null;
    for (const r of incH) {
      const D = Math.floor(r.t / DAY) * DAY;
      if (D !== lastDay) {
        lastDay = D;
        if (D - start >= POLICY.burnDays * DAY) {
          const mean = {};
          for (const k of names) {
            let s = 0, n = 0;
            for (let d = D - POLICY.lookbackDays * DAY; d < D; d += DAY) { const v = sums[k].get(d); if (v) { s += v[0]; n += v[1]; } }
            mean[k] = n > 100 ? s / n : null;
          }
          const valid = names.filter((k) => mean[k] !== null);
          if (valid.length) {
            const best = valid.reduce((a, b) => (mean[b] < mean[a] ? b : a));
            if (choice === 'neutral') { if (Math.LN2 - mean[best] >= POLICY.delta) choice = best; }
            else {
              if (mean[choice] === null || mean[choice] - mean[best] >= POLICY.delta) choice = best;
              if (mean[choice] - Math.LN2 >= POLICY.delta) choice = 'neutral';
            }
          }
        }
        const prev = choices[h].at(-1);
        if (!prev || prev.choice !== choice) choices[h].push({ from: iso(D), choice });
      }
      const x = choice === 'neutral' ? null : maps[choice].get(keyOf(r));
      out.push(x || { ...r, p: 0.5, strong: false, est: 0 });
    }
  }
  return { recs: out, choices };
}

// ---------------------------------------------------------------- the shown price, five ways

function ninv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function estimators(per, inc) {
  const out = {};
  const est = {
    'no change': () => 0,
    'implied (v3)': (r) => r.implied,
    'ensemble': (r) => r.ret,
    'implied, shrunk (v4)': (r) => r.est,
    'median from P(up)': (r) => ((r.hi[1] - r.lo[1]) / 2.5631) * ninv(Math.min(0.99, Math.max(0.01, r.p))),
  };
  for (const r of inc) {
    if (r.unavailable) continue;
    const sp = splitOf(per, r.t);
    if (!sp) continue;
    const o = ((out[sp] ||= {})[r.h] ||= Object.fromEntries(Object.keys(est).map((k) => [k, { ae: 0, se: 0, abv: 0, n: 0 }])));
    for (const [k, f] of Object.entries(est)) { const e = f(r), q = o[k]; q.ae += Math.abs(r.y - e); q.se += (r.y - e) ** 2; q.abv += r.y > e ? 1 : r.y === e ? 0.5 : 0; q.n++; }
  }
  for (const sp of Object.keys(out)) for (const h of Object.keys(out[sp])) {
    const z = out[sp][h]['no change'];
    for (const [k, q] of Object.entries(out[sp][h])) out[sp][h][k] = { mae_bp: r6(q.ae / q.n * 1e4), rmse_bp: r6(Math.sqrt(q.se / q.n) * 1e4), maeSkill_pct: r6((1 - q.ae / z.ae) * 100), mseSkill_pct: r6((1 - q.se / z.se) * 100), above: r6(q.abv / q.n) };
  }
  return out;
}

function calibration(per, recs) {
  const edges = [0, 0.45, 0.48, 0.49, 0.495, 0.505, 0.51, 0.52, 0.55, 1.01];
  const out = {};
  for (const r of recs) {
    if (r.unavailable || r.y === 0) continue;
    const sp = splitOf(per, r.t);
    if (!sp) continue;
    const bins = ((out[sp] ||= {})[r.h] ||= edges.slice(1).map(() => ({ n: 0, p: 0, up: 0 })));
    let k = 0;
    while (r.p >= edges[k + 1]) k++;
    bins[k].n++; bins[k].p += r.p; bins[k].up += r.y > 0 ? 1 : 0;
  }
  for (const sp of Object.keys(out)) for (const h of Object.keys(out[sp])) out[sp][h] = out[sp][h].map((b, k) => ({ bin: `${edges[k]}-${Math.min(1, edges[k + 1])}`, n: b.n, meanP: b.n ? r6(b.p / b.n) : null, upRate: b.n ? r6(b.up / b.n) : null }));
  return out;
}

// ---------------------------------------------------------------- main

const code = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } })();
const result = { coin: ASSET.ticker, generated: new Date().toISOString(), code, node: process.version, preregistered: { POLICY, TIE, candidates: DIRECTION_CANDIDATES }, final: FINAL, periods: {}, variants: {}, paired: {}, estimators: {}, calibration: {}, policy: {} };
for (const P of PERIODS) {
  const per = loadPeriod(P);
  if (!per) { log(`${P.name}: Stage 1 files missing, skipped`); continue; }
  log(`${P.name}: ${per.cand.rows.length} issue minutes, ${per.cand.days.length} days${per.evo ? ', with evolution' : ''}`);
  result.periods[P.name] = { splits: P.splits, issueMinutes: per.cand.rows.length, days: per.cand.days.length, evolution: !!per.evo };
  const V = {};
  const run = (name, spec) => { const t0 = Date.now(); V[name] = replay(per, spec); log(`  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); };

  // the system as it was (v3's online layer on the corrected data) and as it is now
  run('v3 online layer', { opt: { legacyDecay: true, strong: 'thr', shrink: false } });
  run('v4', {});
  // adaptation: none at all / online learning only / refits only / both / plus evolution
  run('frozen, no learning', { dir: 'frozen', mus: 'fmu', opt: { learn: false } });
  run('frozen + online', { dir: 'frozen', mus: 'fmu' });
  run('refit, no learning', { opt: { learn: false } });
  if (per.evo) run('v4 + evolution', { mus: 'evo' });
  // forgetting
  run('half-lives 7/14/30 d', { opt: { online: HL(7, 14, 30) } });
  run('half-lives 60/120/120 d', { opt: { online: HL(60, 120, 120) } });
  run('half-lives 210/450/450 d', { opt: { online: HL(210, 450, 450) } });
  run('v3 forgetting (per outcome)', { opt: { legacyDecay: true } });
  run('calibration with intercept', { opt: { intercept: true } });
  run('v4 + signal gate', { opt: { gate: true } });
  // revalidated after the forgetting fix: the Hedge learning rate and the calibration prior
  run('hedge eta 0.05', { opt: { online: { hedgeEta: 0.05 } } });
  run('hedge eta 0.8', { opt: { online: { hedgeEta: 0.8 } } });
  run('calibration prior 500', { opt: { online: { plattPrior: 500 } } });
  run('calibration prior 8000', { opt: { online: { plattPrior: 8000 } } });
  run('ranges from past residuals', { resid: residualShapes(per, V.v4) });
  run('v3 "confident" rule', { opt: { strong: 'thr' } });
  // direction candidates
  for (const k of Object.keys(DIRECTION_CANDIDATES)) if (k !== 'pair240') run(`dir ${k}`, { dir: k });
  run('dir ridge only', { dir: 'ridge240' });
  run('dir trees only', { dir: 'gbdt240' });
  const W = stackWeights(per, V.v4);
  run('dir stacked blend', { dir: 'stack', stack: W });
  // baselines and the policy
  const B = baselines(per, V.v4);
  V['baseline coin'] = B.coin; V['baseline up-share 30 d'] = B.upShare30; V['baseline momentum/reversal 30 d'] = B.momRev30;
  const cands = { pair240: V.v4, pair120: V['dir pair120'], pairRW: V['dir pairRW'], logit240: V['dir logit240'], gbc240: V['dir gbc240'], ridge240: V['dir ridge only'], gbdt240: V['dir trees only'], stack: V['dir stacked blend'] };
  const pol = runPolicy(cands, V.v4);
  V['selection policy'] = pol.recs;
  result.policy[P.name] = pol.choices;
  V['v4, 24 h no signal'] = V.v4.map((r) => (r.h === 1440 ? { ...r, p: 0.5, strong: false, est: 0 } : r));
  if (FINAL) run('final', { dir: FINAL.dir || 'pair240', opt: FINAL.opt || {}, mus: FINAL.mus || 'mu', pinned: false });

  // scores
  const A = Object.fromEntries(Object.entries(V).map(([k, recs]) => [k, aggregate(per, recs)]));
  for (const [name, a] of Object.entries(A)) {
    for (const sp of Object.keys(a)) for (const h of Object.keys(a[sp])) {
      ((result.variants[name] ||= {})[sp] ||= {})[h] = summary(a[sp][h], ['v4', 'final', 'selection policy', 'v4 + signal gate', 'baseline coin'].includes(name) || name.startsWith('dir ') || name.startsWith('frozen') || name.startsWith('refit'));
      if (name !== 'v4' && A.v4[sp] && A.v4[sp][h]) {
        ((result.paired[name] ||= {})[sp] ||= {})[h] = {
          dLogLoss: paired(a[sp][h], A.v4[sp][h], 'logloss'),
          dAccI: paired(a[sp][h], A.v4[sp][h], 'accI'),
          dStrongAccI: paired(a[sp][h], A.v4[sp][h], 'strongAccI'),
          dMseSkill: paired(a[sp][h], A.v4[sp][h], 'mseSkill'),
          dIscore80_bp: paired(a[sp][h], A.v4[sp][h], (s) => s.iscore[1] * 1e4),
        };
      }
    }
  }
  Object.assign(result.estimators, Object.fromEntries(Object.entries(estimators(per, V.v4)).map(([k, v]) => [k, v])));
  Object.assign(result.calibration, calibration(per, V.v4));
  result.calibration[`${P.name} policy`] = calibration(per, V['selection policy']);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
log(`wrote ${OUT}`);
