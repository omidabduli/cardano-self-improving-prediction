#!/usr/bin/env node
// The pipeline GitHub Actions runs whenever its schedule fires (in practice a few times a day;
// the site doesn't depend on it, because the browser computes everything live).
//
//   1. fetch the newest 1-minute candles (ADA + BTC + ETH)
//   2. replay every minute since the last checkpoint with the *published* model:
//      make the official prediction, resolve the ones that matured, learn online
//   3. once per UTC day: evolve challengers vs. champions, retrain all experts
//   4. write the public record (data/) which the workflow commits and deploys
//
// Flags: --bootstrap (start from scratch)  --evolve (force a retrain now)  --warmup-days N

import { MINUTE, DAY_MIN, HORIZONS, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, isIssue } from '../site/core/config.js';
import { buildSeries, indexOf } from '../site/core/candles.js';
import { D, WARMUP } from '../site/core/features.js';
import { expertPredictions, directionScores, EXPERTS } from '../site/core/models.js';
import { Engine } from '../site/core/engine.js';
import { emptyHorizonAggs, addResolution, mergeAgg, roundAgg } from '../site/core/metrics.js';
import { fetchKlines, fetchFearGreed, lastHost } from './binance.mjs';
import { makeDataset, evolve, buildModel, warmup, GEN0 } from './train.mjs';
import { readJSON, writeJSON, isoDay, isoMinute, appendPredictionRows, listPredictionDays, listMonths, ROOT } from './store.mjs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const log = (...a) => console.log(...a);
const FETCH_DAYS_TRAIN = 262; // 240-day direction window + 10 validation days + 1-day targets + 7-day warm-up + margin
const WARMUP_DAYS = opt('--warmup-days', 30);
// how far back one run can backfill if GitHub didn't run the job for a while
const REPLAY_DAYS = 7;

const bps = (x, d) => (x * 1e4).toFixed(d);

// Fingerprint of the committed site code (git tree hash of site/). Open pages reload when it changes.
function siteVersion() {
  try {
    return execSync('git rev-parse HEAD:site', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12);
  } catch {
    return null;
  }
}

function csvRow(t, close, pred) {
  const base = `${isoMinute(t)},${close}`;
  if (!pred) return base + ','.repeat(5 * HORIZONS.length);
  return base + ',' + HORIZONS.map((h) => {
    const x = pred.h[h];
    return [bps(x.ret, 2), x.p.toFixed(4), bps(x.lo[1], 1), bps(x.hi[1], 1), x.strong ? 1 : 0].join(',');
  }).join(',');
}

function brainSnapshot(eng) {
  const o = { w: {}, skill: {}, aci: {}, platt: {} };
  const r = (x, d = 4) => Number(x.toFixed(d));
  for (const h of HORIZONS) {
    o.w[h] = eng.weights(h).map((x) => r(x));
    o.skill[h] = eng.skills(h).map((x) => r(x, 3));
    o.aci[h] = eng.s.aci[h].map((x) => r(x));
    o.platt[h] = { a: r(eng.s.platt[h].a, 3) };
  }
  return o;
}

async function main() {
  const started = Date.now();
  let model = readJSON('model.json');
  let state = readJSON('state.json');
  const status = readJSON('status.json', {});
  const bootstrap = flag('--bootstrap') || !model || !state;
  const nowMs = Date.now();
  const lastClosed = Math.floor(nowMs / MINUTE) * MINUTE - MINUTE;
  const today = isoDay(nowMs);
  const needTrain = bootstrap || flag('--evolve') || isoDay(Date.parse(model.trainedAt)) !== today;

  // ---- 1. data ----
  // bootstrap also simulates WARMUP_DAYS before today, each with a full training window
  const fromMs = needTrain
    ? lastClosed - (FETCH_DAYS_TRAIN + (bootstrap ? WARMUP_DAYS : 0)) * DAY_MIN * MINUTE
    : Math.max(state.t, lastClosed - REPLAY_DAYS * DAY_MIN * MINUTE) - (WARMUP + 5) * MINUTE; // + the features' warm-up
  const tf = Date.now();
  const [ada, btc, eth, fng] = await Promise.all([
    fetchKlines(SYMBOL, fromMs, lastClosed),
    fetchKlines(LEAD_SYMBOL, fromMs, lastClosed),
    fetchKlines(PEER_SYMBOL, fromMs, lastClosed),
    fetchFearGreed(Math.ceil((lastClosed - fromMs) / 86400000) + 10, readJSON('fng.json', [])),
  ]);
  if (!ada.length || !btc.length || !eth.length) throw new Error('no candles returned');
  const end = Math.min(...[ada, btc, eth].map((a) => a.reduce((m, k) => Math.max(m, k.t), 0)));
  const S = buildSeries(ada, btc, end, { eth, fng });
  const ds = makeDataset(S);
  log(`data: ${ada.length} ${SYMBOL} + ${btc.length} ${LEAD_SYMBOL} + ${eth.length} ${PEER_SYMBOL} candles via ${lastHost}, ${fng.length} Fear & Greed days, in ${Date.now() - tf} ms; series ${isoMinute(S.t[0])} .. ${isoMinute(S.t[S.t.length - 1])}`);

  const history = { newAggs: {} };
  let rowsOut = [];
  let eng = null;
  let replayed = 0;

  // ---- 2. replay official minutes with the published model ----
  if (!bootstrap) {
    eng = new Engine(model, state);
    let i0 = indexOf(S, state.t + MINUTE);
    if (i0 < 0 && state.t < S.t[0]) {
      log(`warning: checkpoint ${isoMinute(state.t)} is older than the fetched data; skipping the gap`);
      i0 = WARMUP;
      eng.s.pending = [];
    }
    if (i0 >= 0) {
      for (let i = Math.max(i0, 0); i < S.t.length; i++) {
        const issue = i >= WARMUP && isIssue(S.t[i]);
        const mus = issue ? expertPredictions(model, ds.X, D, i) : null;
        const { resolved, pred } = eng.step(S.t[i], S.c[i], ds.vol[i], mus, issue ? directionScores(model, ds.X, D, i) : null);
        if (isIssue(S.t[i])) rowsOut.push(csvRow(S.t[i], S.c[i], pred));
        for (const r of resolved) {
          const dk = isoDay(r.t);
          history.newAggs[dk] ||= emptyHorizonAggs();
          addResolution(history.newAggs[dk][r.h], r);
        }
        replayed++;
      }
    }
    state = eng.snapshot();
    log(`replayed ${replayed} minutes up to ${isoMinute(state.t)}; pending ${state.pending.length}`);
  }

  // ---- 3. daily evolution + retraining ----
  const evo = bootstrap ? { generations: [] } : readJSON('evolution.json', { generations: [] });
  let trainError = null;
  if (needTrain) {
    // A failed retrain must never stall the public record: keep the current model,
    // still commit the replayed minutes, and try again on the next run.
    try {
      const tt = Date.now();
      const prevCfg = (!bootstrap && model?.configs) || structuredClone(GEN0);
      const generation = bootstrap ? 1 : (model?.generation || 0) + 1;
      const seed = Math.floor(nowMs / 86400000);
      log(`evolution: generation ${generation}`);
      // At launch the hand-picked generation 0 is used as is: it won a 300-day walk-forward test,
      // while evolving on the last ten days first would only fit their noise.
      let cfg = prevCfg, report = null;
      if (!bootstrap) ({ cfg, report } = evolve(ds, prevCfg, { seed, log }));
      const trainedAt = new Date().toISOString();
      const fresh = buildModel(ds, cfg, { id: `g${generation}-${trainedAt.slice(0, 16)}`, trainedAt, generation, seed });
      evo.generations.push({ gen: generation, at: trainedAt, day: today, report, cfg });
      log(`retrained generation ${generation} in ${((Date.now() - tt) / 1000).toFixed(1)} s`);

      if (bootstrap) {
        log(`warm-up simulation over ${WARMUP_DAYS} days`);
        const wu = warmup(ds, cfg, WARMUP_DAYS, { log, seed });
        eng = wu.engine;
        eng.model = fresh;
        eng.s.pending = []; // the public record starts clean with the published model
        state = eng.snapshot();
        const quant = (arr, q) => { const v = [...arr].sort((a, b) => a - b); return v[Math.floor(q * (v.length - 1))]; };
        const pStats = Object.fromEntries(HORIZONS.map((h) => [h, [0.5, 0.8, 0.95].map((q) => Number(quant(wu.pAbs[h], q).toFixed(4)))]));
        const days = {};
        for (const [dk, a] of Object.entries(wu.byDay)) days[dk] = Object.fromEntries(HORIZONS.map((h) => [h, roundAgg(a[h])]));
        writeJSON('warmup.json', { note: 'Warm-up simulation run once at launch (the long backtest is data/backtest.json, from engine/backtest.mjs): each day the experts were refit on earlier data only, then the full online system (ensemble weights, conformal bands, calibration) was stepped minute by minute. The generation-0 settings were chosen in a longer walk-forward test that overlaps these days, so treat this as slightly optimistic. The live record is what counts.', from: isoMinute(S.t[S.t.length - WARMUP_DAYS * DAY_MIN]), to: isoMinute(S.t[S.t.length - 1]), days, pAbsQuantiles: pStats });
        status.liveSince = new Date(state.t + 2 * MINUTE).toISOString();
        log('p-edge quantiles (50/80/95%):', JSON.stringify(pStats));
      }
      writeJSON('model.json', fresh);
      writeJSON('evolution.json', evo);
      model = fresh; // only once it is on disk
    } catch (e) {
      if (bootstrap) throw e;
      trainError = e.message;
      console.error(e);
      console.log(`::warning::retraining failed, keeping generation ${model.generation}: ${e.message}`);
    }
  }

  // ---- 4. public record ----
  if (rowsOut.length) appendPredictionRows(rowsOut);

  const monthsTouched = new Set(Object.keys(history.newAggs).map((d) => d.slice(0, 7)));
  monthsTouched.add(today.slice(0, 7));
  for (const m of monthsTouched) {
    const file = `daily/${m}.json`;
    const month = readJSON(file, { days: {}, snaps: [] });
    for (const [dk, aggs] of Object.entries(history.newAggs)) {
      if (dk.slice(0, 7) !== m) continue;
      const cur = month.days[dk] || {};
      month.days[dk] = Object.fromEntries(HORIZONS.map((h) => [h, roundAgg(mergeAgg(cur[h], aggs[h]))]));
    }
    if (m === today.slice(0, 7) && eng) {
      const bucket = new Date(nowMs).toISOString().slice(0, 11) + String(Math.floor(new Date(nowMs).getUTCHours() / 6) * 6).padStart(2, '0');
      const snap = { at: bucket, ...brainSnapshot(eng) };
      const k = month.snaps.findIndex((s) => s.at === bucket);
      if (k >= 0) month.snaps[k] = snap; else month.snaps.push(snap);
    }
    writeJSON(file, month);
  }

  // all-time / 7d / 30d totals from the monthly files
  const months = listMonths();
  const allDays = {};
  for (const m of months) Object.assign(allDays, readJSON(`daily/${m}.json`).days);
  const totals = { all: emptyHorizonAggs(), d7: emptyHorizonAggs(), d30: emptyHorizonAggs() };
  for (const [dk, a] of Object.entries(allDays)) {
    const age = (Date.parse(today) - Date.parse(dk)) / 86400000;
    for (const h of HORIZONS) {
      totals.all[h] = mergeAgg(totals.all[h], a[h]);
      if (age < 7) totals.d7[h] = mergeAgg(totals.d7[h], a[h]);
      if (age < 30) totals.d30[h] = mergeAgg(totals.d30[h], a[h]);
    }
  }
  for (const k of Object.keys(totals)) for (const h of HORIZONS) totals[k][h] = roundAgg(totals[k][h]);

  writeJSON('state.json', state);
  // the last 30 days of Fear & Greed: the browser reads the same values the record used
  writeJSON('fng.json', fng.filter((x) => x.t >= lastClosed - 30 * 86400000));
  const n = S.t.length;
  const out = {
    updatedAt: new Date().toISOString(),
    siteVersion: siteVersion(),
    t: state.t,
    price: S.c[n - 1],
    liveSince: status.liveSince,
    model: { id: model.id, generation: model.generation, trainedAt: model.trainedAt, dataEnd: model.dataEnd },
    experts: EXPERTS.map((e) => e.id),
    run: {
      id: process.env.GITHUB_RUN_ID || 'local',
      sha: (process.env.GITHUB_SHA || '').slice(0, 7),
      host: lastHost,
      replayed,
      retrained: needTrain,
      durationMs: Date.now() - started,
      runs: (status.run?.runs || 0) + 1,
      trainError,
    },
    months,
    days: listPredictionDays().slice(-3),
    totals,
  };
  writeJSON('status.json', out, true);
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  console.log(`::warning::pipeline failed: ${e.message}`);
  process.exitCode = 1;
});
