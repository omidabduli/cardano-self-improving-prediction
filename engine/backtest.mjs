#!/usr/bin/env node
// Long walk-forward backtest of the whole system, written to the public record as
// data/backtest.json (scores per day) and data/backtest/YYYY-MM.csv (every forecast).
//
// Each simulated day the experts are refit on earlier data only (and, with --evolve, the
// daily evolution runs exactly as in production), then the online system (trust weights,
// conformal ranges, calibration) is stepped minute by minute. Nothing from the future leaks
// in: a forecast at time t only uses models trained before t and data that was public at t.
//
// Market data comes from Binance's monthly/daily archive files on data.binance.vision
// (cached in .cache/klines), sentiment from alternative.me.
//
//   node engine/backtest.mjs [--days 365] [--evolve]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HORIZONS, DAY_MIN, MINUTE, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, isIssue } from '../site/core/config.js';
import { buildSeries } from '../site/core/candles.js';
import { D } from '../site/core/features.js';
import { EXPERTS, expertPredictions, directionScores } from '../site/core/models.js';
import { Engine, freshState } from '../site/core/engine.js';
import { emptyHorizonAggs, addResolution, roundAgg } from '../site/core/metrics.js';
import { makeDataset, fitExperts, residQuantiles, trainRows, evolve, fitDirection, GEN0, DIRECTION } from './train.mjs';
import { ROOT, writeJSON } from './store.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const DAYS = opt('--days', 365);
const EVOLVE = args.includes('--evolve');
const TRAIN_DAYS = Math.max(60, DIRECTION.window) + 2 + 8; // longest training window + the 24 h target gap + feature warm-up
// The direction model's settings were picked on Bitcoin (see train.mjs DIRECTION), so every day
// of this backtest is an untouched check.
const TUNE_END = null;
const CACHE = path.join(ROOT, '.cache', 'klines');
const log = (...a) => console.log(...a);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const isoMinute = (ms) => new Date(ms).toISOString().slice(0, 16);

async function download(url, file) {
  if (fs.existsSync(file)) return true;
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (e) {
      if (a === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
    }
  }
}

// Archive CSV rows have the same columns as the REST klines. Since 2025 the spot files use
// microsecond timestamps.
function parseCsv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const k = line.split(',');
    if (k.length < 10 || !/^\d/.test(k[0])) continue;
    let t = Number(k[0]);
    if (t > 1e14) t = Math.floor(t / 1000);
    out.push({ t, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], tr: +k[8], tb: +k[9] });
  }
  return out;
}

export async function klines(symbol, fromMs, toMs) {
  fs.mkdirSync(CACHE, { recursive: true });
  const base = 'https://data.binance.vision/data/spot';
  const files = [];
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  for (let d = new Date(fromMs); d.getTime() <= toMs; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const name = `${symbol}-1m-${m}.zip`;
    const ok = m !== thisMonth && await download(`${base}/monthly/klines/${symbol}/1m/${name}`, path.join(CACHE, name));
    if (ok) { files.push(path.join(CACHE, name)); continue; }
    // month not archived yet: daily files
    for (let day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); day <= toMs && isoDay(day).slice(0, 7) === m; day += 86400000) {
      const dn = `${symbol}-1m-${isoDay(day)}.zip`;
      if (await download(`${base}/daily/klines/${symbol}/1m/${dn}`, path.join(CACHE, dn))) files.push(path.join(CACHE, dn));
    }
  }
  const out = [];
  for (const f of files) for (const k of parseCsv(execFileSync('unzip', ['-p', f], { maxBuffer: 1 << 28 }).toString())) if (k.t >= fromMs && k.t <= toMs) out.push(k);
  return out;
}

export async function fearGreed() {
  const res = await fetch('https://api.alternative.me/fng/?limit=0', { signal: AbortSignal.timeout(30000) });
  return (await res.json()).data.map((d) => ({ t: Number(d.timestamp) * 1000, v: Number(d.value) })).sort((a, b) => a.t - b.t);
}

const bps = (x, d) => (x * 1e4).toFixed(d);

async function main() {
  const started = Date.now();
  // end at the last full UTC day that the archive has
  const end = Math.floor(Date.now() / 86400000) * 86400000 - 86400000 - MINUTE;
  const from = end + MINUTE - (DAYS + TRAIN_DAYS) * 86400000;
  log(`backtest ${DAYS} days to ${isoMinute(end)}${EVOLVE ? ' with daily evolution' : ''}; downloading ${isoDay(from)} ..`);
  const [a, b, c, fng] = await Promise.all([klines(SYMBOL, from, end), klines(LEAD_SYMBOL, from, end), klines(PEER_SYMBOL, from, end), fearGreed()]);
  log(`data: ${a.length} ${SYMBOL} + ${b.length} ${LEAD_SYMBOL} + ${c.length} ${PEER_SYMBOL} candles, ${fng.length} Fear & Greed days`);
  const last = Math.min(...[a, b, c].map((x) => x.reduce((m, k) => Math.max(m, k.t), 0)));
  const S = buildSeries(a, b, last, { eth: c, fng });
  const ds = makeDataset(S);
  log(`features ready in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  const ids = EXPERTS.map((e) => e.id);
  const s0 = ds.n - DAYS * DAY_MIN;
  const eng = new Engine({ experts: ids.map((id) => ({ id })), resid: null }, freshState(ids, S.t[s0 - 1]));
  const byDay = {};
  const rows = {}; // month -> csv lines
  const preds = new Map(); // issue time -> {c, h: {h: {...}}}
  const gens = [];
  let cfg = structuredClone(GEN0);
  for (let d = 0; d < DAYS; d++) {
    const s = s0 + d * DAY_MIN, e = d === DAYS - 1 ? ds.n : s + DAY_MIN;
    const t0 = Date.now();
    if (EVOLVE && d > 0) {
      // production evolves on data up to the start of the day only
      const sub = { ...ds, n: s };
      ({ cfg } = evolve(sub, cfg, { seed: Math.floor(S.t[s] / 86400000), log: () => {} }));
      gens.push({ day: isoDay(S.t[s]), cfg: structuredClone(cfg) });
    }
    const model = { experts: fitExperts(ds, s, cfg, 1 + d), resid: residQuantiles(ds, trainRows(ds, s, 30)), direction: fitDirection(ds, s, 1 + d) };
    eng.model = model;
    for (let i = s; i < e; i++) {
      const issue = isIssue(S.t[i]);
      const mus = issue ? expertPredictions(model, ds.X, D, i) : null;
      const { resolved, pred } = eng.step(S.t[i], S.c[i], ds.vol[i], mus, issue ? directionScores(model, ds.X, D, i) : null);
      if (pred) preds.set(pred.t, { c: pred.c, h: Object.fromEntries(HORIZONS.map((h) => [h, { med: pred.h[h].med, p: pred.h[h].p, s: pred.h[h].strong, lo: pred.h[h].lo[1], hi: pred.h[h].hi[1] }])), y: {} });
      for (const r of resolved) {
        const dk = isoDay(r.t);
        addResolution((byDay[dk] ||= emptyHorizonAggs())[r.h], r);
        const p = preds.get(r.t);
        if (!p) continue;
        p.y[r.h] = r.y;
        if (Object.keys(p.y).length === HORIZONS.length) {
          (rows[dk.slice(0, 7)] ||= []).push([isoMinute(r.t), p.c, ...HORIZONS.flatMap((h) => [bps(p.h[h].med, 1), p.h[h].p.toFixed(4), p.h[h].s ? 1 : 0, bps(p.h[h].lo, 1), bps(p.h[h].hi, 1), bps(p.y[h], 1)])].join(','));
          preds.delete(r.t);
        }
      }
    }
    if (d % 30 === 0 || d === DAYS - 1) log(`  day ${d + 1}/${DAYS} ${isoDay(S.t[s])} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }

  // public record
  const dir = path.join(ROOT, 'data', 'backtest');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const header = 'issued_utc,price,' + HORIZONS.map((h) => `${h / 60}h_est_bp,${h / 60}h_p_up,${h / 60}h_confident,${h / 60}h_lo80_bp,${h / 60}h_hi80_bp,${h / 60}h_actual_bp`).join(',');
  for (const [m, lines] of Object.entries(rows)) fs.writeFileSync(path.join(dir, `${m}.csv`), header + '\n' + lines.join('\n') + '\n');
  const days = {};
  for (const [dk, agg] of Object.entries(byDay)) days[dk] = Object.fromEntries(HORIZONS.map((h) => [h, roundAgg(agg[h])]));
  writeJSON('backtest.json', {
    note: `Walk-forward backtest over ${DAYS} days: each day the experts and the direction model were refit on earlier data only${EVOLVE ? ' and the daily evolution ran as in production' : ''}, then the full online system (trust weights, conformal ranges, calibration) was stepped minute by minute. The direction model's settings were picked on Bitcoin (the sister project Bitcast) and used unchanged, so no Cardano day was used to choose them. Every forecast is in data/backtest/. The live record is what counts.`,
    tuneEnd: TUNE_END,
    from: isoMinute(S.t[s0]),
    to: isoMinute(S.t[ds.n - 1]),
    evolve: EVOLVE,
    months: Object.keys(rows).sort(),
    days,
  });
  log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'engine', 'backtest.mjs')) main().catch((e) => { console.error(e); process.exitCode = 1; });
