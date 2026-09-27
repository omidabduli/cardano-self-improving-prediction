#!/usr/bin/env node
// Phase A of the September 2026 review: recompute the published (v3) backtest's scores from its
// CSV files, without rerunning anything. Reports, per horizon and period:
//   - direction: accuracy on non-overlapping calls (all / "confident"), Brier score and log loss
//     against the 50% baseline
//   - the price estimate the v3 page displayed, (2p-1) * 0.798 * (hi80-lo80) / 2.563, and the
//     estimate the v3 CSV stored (ensemble median), each against "no change": mean absolute and
//     root-mean-square error of the log-return, and the least-squares slope of the actual move on
//     the estimate (1 = right size, 0 = no information)
//   - the 80% range: coverage and mean width
// with 95% intervals from a day-block bootstrap (whole UTC days resampled, 2000 draws).
//
//   node research/baseline.mjs [data dir] [split day]   -> JSON on stdout
import fs from 'node:fs';
import path from 'node:path';
import { mulberry32 } from '../engine/gbdt.mjs';

const dir = path.resolve(process.argv[2] || 'data');
const SPLIT = process.argv[3] || '2026-05-24';
const H = [60, 180, 1440];

const rows = [];
for (const f of fs.readdirSync(path.join(dir, 'backtest')).filter((x) => x.endsWith('.csv')).sort()) {
  const lines = fs.readFileSync(path.join(dir, 'backtest', f), 'utf8').trim().split('\n');
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const t = Date.parse(c[0] + ':00Z');
    const r = { t, day: c[0].slice(0, 10), c: +c[1], h: {} };
    H.forEach((h, k) => {
      const o = 2 + k * 6;
      if (c[o + 5] === '' || c[o + 5] === undefined) return;
      r.h[h] = { est: +c[o] / 1e4, p: +c[o + 1], conf: c[o + 2] === '1', lo: +c[o + 3] / 1e4, hi: +c[o + 4] / 1e4, y: +c[o + 5] / 1e4 };
    });
    rows.push(r);
  }
}

const shown = (x) => (2 * x.p - 1) * 0.798 * (x.hi - x.lo) / (2 * 1.2816);
const nonOverlap = (t, h) => (Math.round(t / 60000) + 1) % h === 0;

// per-day sums, so the bootstrap can resample days
function daySums(list, h) {
  const by = new Map();
  for (const r of list) {
    const x = r.h[h];
    if (!x) continue;
    let d = by.get(r.day);
    if (!d) by.set(r.day, (d = { n: 0, nm: 0, bs: 0, ll: 0, ni: 0, hi: 0, sni: 0, shi: 0, cov: 0, wid: 0,
      aeS: 0, seS: 0, aeE: 0, seE: 0, ae0: 0, se0: 0, xyS: 0, xxS: 0, xyE: 0, xxE: 0 }));
    const y = x.y, s = shown(x), e = x.est;
    d.n++;
    d.cov += y >= x.lo && y <= x.hi ? 1 : 0;
    d.wid += x.hi - x.lo;
    d.aeS += Math.abs(y - s); d.seS += (y - s) ** 2;
    d.aeE += Math.abs(y - e); d.seE += (y - e) ** 2;
    d.ae0 += Math.abs(y); d.se0 += y * y;
    d.xyS += s * y; d.xxS += s * s; d.xyE += e * y; d.xxE += e * e;
    if (y === 0) continue;
    const u = y > 0 ? 1 : 0;
    const hit = (y > 0) === (x.p >= 0.5) ? 1 : 0;
    d.nm++;
    d.bs += (x.p - u) ** 2;
    const pp = Math.min(Math.max(x.p, 1e-6), 1 - 1e-6);
    d.ll += -(u ? Math.log(pp) : Math.log(1 - pp));
    if (nonOverlap(r.t, h)) { d.ni++; d.hi += hit; if (x.conf) { d.sni++; d.shi += hit; } }
  }
  return [...by.values()];
}

function stats(days) {
  const S = {};
  for (const d of days) for (const k in d) S[k] = (S[k] || 0) + d[k];
  if (!S.n) return null;
  return {
    acc: S.hi / S.ni, n_calls: S.ni,
    acc_conf: S.shi / S.sni, n_conf: S.sni,
    brier: S.bs / S.nm, brier_skill_pct: (1 - S.bs / S.nm / 0.25) * 100,
    logloss: S.ll / S.nm, logloss_gain_vs_coin: Math.LN2 - S.ll / S.nm,
    shown_mae_bp: S.aeS / S.n * 1e4, stored_mae_bp: S.aeE / S.n * 1e4, nochange_mae_bp: S.ae0 / S.n * 1e4,
    shown_rmse_bp: Math.sqrt(S.seS / S.n) * 1e4, stored_rmse_bp: Math.sqrt(S.seE / S.n) * 1e4, nochange_rmse_bp: Math.sqrt(S.se0 / S.n) * 1e4,
    shown_mse_skill_pct: (1 - S.seS / S.se0) * 100, stored_mse_skill_pct: (1 - S.seE / S.se0) * 100,
    shown_slope: S.xyS / S.xxS, stored_slope: S.xxE > 0 ? S.xyE / S.xxE : null,
    cov80: S.cov / S.n, width80_bp: S.wid / S.n * 1e4,
    forecasts: S.n,
  };
}

function bootstrap(days, keys, B = 2000, seed = 1) {
  const rng = mulberry32(seed);
  const draws = Object.fromEntries(keys.map((k) => [k, []]));
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < days.length; i++) sample.push(days[Math.floor(rng() * days.length)]);
    const s = stats(sample);
    for (const k of keys) if (s && Number.isFinite(s[k])) draws[k].push(s[k]);
  }
  const ci = {};
  for (const k of keys) {
    const v = draws[k].sort((a, b) => a - b);
    ci[k] = v.length ? [v[Math.floor(0.025 * v.length)], v[Math.floor(0.975 * v.length)]] : null;
  }
  return ci;
}

const periods = {
  full: rows,
  tuning: rows.filter((r) => r.day <= SPLIT),
  later: rows.filter((r) => r.day > SPLIT),
};
const CI_KEYS = ['acc', 'acc_conf', 'logloss_gain_vs_coin', 'shown_mse_skill_pct', 'stored_mse_skill_pct', 'shown_slope'];
const out = { source: dir, split: SPLIT, from: rows[0] && rows[0].day, to: rows.at(-1) && rows.at(-1).day, results: {} };
for (const [name, list] of Object.entries(periods)) {
  out.results[name] = {};
  for (const h of H) {
    const days = daySums(list, h);
    const s = stats(days);
    if (!s) continue;
    out.results[name][h] = { ...s, ci95: bootstrap(days, CI_KEYS), days: days.length };
  }
}
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Number(v.toPrecision(6)) : v), 1));
