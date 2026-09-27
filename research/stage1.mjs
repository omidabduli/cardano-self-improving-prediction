#!/usr/bin/env node
// Stage 1 of the September 2026 evaluation: the expensive part. Walks forward one UTC day at a
// time over a period and, for each day, fits every model on data that had fully matured before
// that day (the same functions and settings production uses), then records the raw outputs of
// every model at every issue minute of the day. Stage 2 (research/stage2.mjs) then replays the
// cheap online layer (trust weights, calibration, ranges, shown price) over these outputs in
// many variants, and scores everything on identical forecasts.
//
// Recorded per issue minute: price, volatility, input validity, the six experts' predictions
// (GEN0 settings, refit daily) and every direction candidate's score components
// (train.mjs DIRECTION_CANDIDATES, refit daily), plus the same for models fitted only once on
// the period's first day ("frozen"). With --evolve instead: the experts after the daily
// evolution, which production runs every day (sequential, so one job per period).
//
//   node research/stage1.mjs --from 2024-09-24 --to 2025-09-23 [--part k/n] [--evolve] --out FILE
//
// The coin is the one in site/core/config.js (run it in each repository for its own coin).
import fs from 'node:fs';
import path from 'node:path';
import { HORIZONS, DAY_MIN, MINUTE, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, MAX_H, isIssue } from '../site/core/config.js';
import { buildSeries } from '../site/core/candles.js';
import { D, WARMUP } from '../site/core/features.js';
import { expertPredictions, EXPERTS, ridgePredict as ridgeP, gbdtPredict as gbdtP } from '../site/core/models.js';
import { makeDataset, fitExperts, residQuantiles, trainRows, fitDirection, evolve, GEN0, DIRECTION_CANDIDATES } from '../engine/train.mjs';
import { klines, fearGreed } from '../engine/backtest.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const FROM = Date.parse(arg('--from') + 'T00:00:00Z');
const TO = Date.parse(arg('--to') + 'T00:00:00Z'); // last day included
const [PART, PARTS] = (arg('--part', '1/1')).split('/').map(Number);
const EVOLVE = args.includes('--evolve');
const OUT = path.resolve(arg('--out'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY = 86400000;

const allDays = [];
for (let t = FROM; t <= TO; t += DAY) allDays.push(t);
const per = Math.ceil(allDays.length / PARTS);
const days = allDays.slice((PART - 1) * per, PART * per);
const lastPart = PART === PARTS;

// longest window (240 days) + the 24 h target gap + feature warm-up + margin
const HIST_DAYS = 240 + 1 + 8 + 4;
const dataFrom = FROM - HIST_DAYS * DAY;
const dataTo = days.at(-1) + DAY + (lastPart ? DAY : 0) - MINUTE; // + one day of outcomes after the period
log(`${SYMBOL} ${EVOLVE ? 'evolve' : 'candidates'} part ${PART}/${PARTS}: days ${new Date(days[0]).toISOString().slice(0, 10)} .. ${new Date(days.at(-1)).toISOString().slice(0, 10)}; data from ${new Date(dataFrom).toISOString().slice(0, 10)}`);

const [a, b, c, fng] = await Promise.all([klines(SYMBOL, dataFrom, dataTo), klines(LEAD_SYMBOL, dataFrom, dataTo), klines(PEER_SYMBOL, dataFrom, dataTo), fearGreed()]);
const end = Math.min(dataTo, ...[a, b, c].map((x) => x.reduce((m, k) => Math.max(m, k.t), 0)));
const S = buildSeries(a, b, end, { eth: c, fng });
a.length = 0; b.length = 0; c.length = 0;
const ds = makeDataset(S);
const idxOf = (t) => Math.round((t - S.t[0]) / MINUTE);
log(`series ${S.t.length} minutes, features ready`);

const CANDS = Object.keys(DIRECTION_CANDIDATES);
// columns of one issue-minute record
const COLS = ['t', 'c', 'vol', 'real', 'valid'];
for (const h of HORIZONS) for (const e of EXPERTS) COLS.push(`mu_${e.id}_${h}`);
if (!EVOLVE) {
  for (const h of HORIZONS) for (const e of EXPERTS) COLS.push(`fmu_${e.id}_${h}`);
  for (const k of CANDS) {
    const kind = DIRECTION_CANDIDATES[k].kind || 'pair';
    for (const h of HORIZONS) {
      if (kind === 'pair') COLS.push(`${k}_a_${h}`, `${k}_b_${h}`); else COLS.push(`${k}_${h}`);
    }
  }
  for (const h of HORIZONS) COLS.push(`frozen_a_${h}`, `frozen_b_${h}`);
}
const NC = COLS.length;
const DAYCOLS = ['day', ...HORIZONS.flatMap((h) => [0, 1, 2, 3, 4, 5, 6].map((q) => `resid_${h}_${q}`))];
if (!EVOLVE) for (const k of [...CANDS, 'frozen']) for (const h of HORIZONS) DAYCOLS.push(`thr_${k}_${h}`);

const recs = [];
const dayRecs = [];
const cfgs = [];

// score components of a fitted direction model on row i
function components(m, kind, i) {
  const off = i * D, X = ds.X;
  const out = [];
  for (const h of HORIZONS) {
    const x = m.h[h];
    if (kind === 'pair') out.push(ridgeP(x.ridge, X, off) / x.sa, gbdtP(x.gbdt, X, off) / x.sb);
    else if (kind === 'logit') out.push(ridgeP(x.lin, X, off) / x.sa);
    else out.push(gbdtP(x.gbdt, X, off) / x.sb);
  }
  return out;
}

let frozen = null;
if (!EVOLVE) {
  const s0 = idxOf(FROM);
  const t0 = Date.now();
  frozen = { experts: fitExperts(ds, s0, GEN0, 1), direction: fitDirection(ds, s0, 1, DIRECTION_CANDIDATES.pair240) };
  log(`frozen models fitted on ${new Date(FROM).toISOString().slice(0, 10)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

let cfg = structuredClone(GEN0);
const dayList = [...days];
if (lastPart) dayList.push(TO + DAY); // outcomes only
for (const T of dayList) {
  const outcomeOnly = T > TO;
  const s = idxOf(T);
  const e = Math.min(ds.n, s + DAY_MIN);
  if (s <= WARMUP || s >= ds.n) continue;
  const t0 = Date.now();
  let experts = null, dirs = null;
  if (!outcomeOnly) {
    if (EVOLVE && T > FROM) {
      ({ cfg } = evolve({ ...ds, n: s }, cfg, { seed: Math.floor(T / DAY), log: () => {} }));
      cfgs.push({ day: new Date(T).toISOString().slice(0, 10), cfg: structuredClone(cfg) });
    }
    experts = fitExperts(ds, s, cfg, 1 + Math.floor(T / DAY) % 1000);
    const resid = residQuantiles(ds, trainRows(ds, s, 30));
    const drow = [T, ...HORIZONS.flatMap((h) => resid[h])];
    if (!EVOLVE) {
      dirs = {};
      for (const k of CANDS) dirs[k] = fitDirection(ds, s, 1 + Math.floor(T / DAY) % 1000, DIRECTION_CANDIDATES[k]);
      for (const k of CANDS) for (const h of HORIZONS) drow.push(dirs[k] ? dirs[k].h[h].thr : NaN);
      for (const h of HORIZONS) drow.push(frozen.direction.h[h].thr);
    }
    dayRecs.push(drow);
  }
  const model = experts && { experts };
  for (let i = s; i < e; i++) {
    if (!isIssue(S.t[i])) continue;
    const r = new Float64Array(NC).fill(NaN);
    r[0] = S.t[i]; r[1] = S.c[i]; r[2] = ds.vol[i]; r[3] = S.syn[i] ? 0 : 1; r[4] = Number.isFinite(ds.vol[i]) ? 1 : 0;
    if (!outcomeOnly && r[4]) {
      let k = 5;
      const mus = expertPredictions(model, ds.X, D, i);
      for (const h of HORIZONS) for (let q = 0; q < EXPERTS.length; q++) r[k++] = mus ? mus[h][q] : NaN;
      if (!EVOLVE) {
        const fm = expertPredictions(frozen, ds.X, D, i);
        for (const h of HORIZONS) for (let q = 0; q < EXPERTS.length; q++) r[k++] = fm ? fm[h][q] : NaN;
        for (const kk of CANDS) {
          const kind = DIRECTION_CANDIDATES[kk].kind || 'pair';
          const comp = dirs[kk] ? components(dirs[kk], kind, i) : null;
          const width = kind === 'pair' ? 2 : 1;
          for (let q = 0; q < width * HORIZONS.length; q++) r[k++] = comp ? comp[q] : NaN;
        }
        for (const v of components(frozen.direction, 'pair', i)) r[k++] = v;
      }
    }
    recs.push(r);
  }
  if (!outcomeOnly) log(`day ${new Date(T).toISOString().slice(0, 10)} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// binary output: [u32 header length][header JSON][f64 records][f64 day records]
const header = Buffer.from(JSON.stringify({ symbol: SYMBOL, from: FROM, to: TO, part: PART, parts: PARTS, evolve: EVOLVE, cols: COLS, dayCols: DAYCOLS, n: recs.length, nDays: dayRecs.length, cfgs }));
const body = new Float64Array(recs.length * NC + dayRecs.length * DAYCOLS.length);
recs.forEach((r, j) => body.set(r, j * NC));
dayRecs.forEach((r, j) => body.set(r, recs.length * NC + j * DAYCOLS.length));
const len = Buffer.alloc(4);
len.writeUInt32LE(header.length);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([len, header, Buffer.from(body.buffer)]));
log(`wrote ${recs.length} issue minutes, ${dayRecs.length} days to ${OUT}`);
