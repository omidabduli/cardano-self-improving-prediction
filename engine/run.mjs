#!/usr/bin/env node
// The pipeline GitHub Actions runs every 15 minutes (started by cron-job.org; the site doesn't
// depend on it, because the browser computes everything live).
//
//   1. fetch the newest 1-minute candles (the coin, its lead and its peer) and Fear & Greed
//   2. replay every minute since the last checkpoint with the *published* model:
//      make the official prediction, resolve the ones that matured, learn online
//   3. once per UTC day: evolve challengers vs. champions, retrain all experts
//   4. write the public record (data/) which the workflow commits and deploys
//
// Every forecast row says when it was generated and whether that was live (within
// LIVE_MAX_LAG_MIN of its candle's close) or a replay (backfilled after an outage); only live
// forecasts count in the live score. The git history of data/ is the proof of when each row was
// published.
//
// Flags: --bootstrap (start from scratch)  --evolve (force a retrain now)  --warmup-days N

import { MINUTE, DAY_MIN, HORIZONS, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, LIVE_MAX_LAG_MIN, ASSET, PRICE_DIGITS, isIssue } from '../site/core/config.js';
import { buildSeries, indexOf } from '../site/core/candles.js';
import { D, WARMUP, FEATURE_SCHEMA } from '../site/core/features.js';
import { expertPredictions, directionScores, EXPERTS } from '../site/core/models.js';
import { Engine, ORIGIN, STATE_VERSION } from '../site/core/engine.js';
import { emptyHorizonAggs, addResolution, mergeAgg, roundAgg, METRICS_VERSION } from '../site/core/metrics.js';
import { fetchKlines, fetchFearGreed, lastHost } from './binance.mjs';
import { makeDataset, evolve, buildModel, warmup, GEN0 } from './train.mjs';
import { readJSON, writeJSON, isoDay, isoMinute, appendPredictionRows, listPredictionDays, listMonths, ROOT, DATA, RECORD_SCHEMA, PER_HORIZON } from './store.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const log = (...a) => console.log(...a);
const FETCH_DAYS_TRAIN = 262; // 240-day direction window + 10 validation days + 1-day targets + 7-day warm-up + margin
const WARMUP_DAYS = opt('--warmup-days', 30);
// how far back one run can backfill if GitHub didn't run the job for a while
const REPLAY_DAYS = 7;
const SCHEMA = `r${RECORD_SCHEMA}-${FEATURE_SCHEMA}-s${STATE_VERSION}`;

const bps = (x, d) => (x * 1e4).toFixed(d);

// Fingerprint of the committed site code (git tree hash of site/). Open pages reload when it changes.
function siteVersion() {
  try {
    return execSync('git rev-parse HEAD:site', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12);
  } catch {
    return null;
  }
}

// One record row (store.CSV_HEADER). `pred` is null when no forecast could be made.
function csvRow(t, close, pred, m) {
  const head = [`${ASSET.ticker}-${isoMinute(t)}`, isoMinute(t), close, m.generated, m.origin, pred ? 'ok' : 'suspended', m.inputs, m.model, m.code, SCHEMA];
  if (!pred) return head.join(',') + ','.repeat(PER_HORIZON.length * HORIZONS.length);
  return head.concat(HORIZONS.flatMap((h) => {
    const x = pred.h[h];
    return [x.price.toFixed(PRICE_DIGITS), bps(x.est, 2), x.p.toFixed(6), x.direction, x.strong ? 1 : 0, x.pModel.toFixed(6), bps(x.shrunk, 2), bps(x.ret, 2), bps(x.lo[1], 1), bps(x.hi[1], 1)];
  })).join(',');
}

// Snapshot of what the online layer has learned, including the background measures: `shadow` is
// each horizon's direction model against a coin (log-loss gain per forecast, ~45-day memory), so
// a horizon shown as "no reliable signal" can be re-tested on the record.
function brainSnapshot(eng) {
  const o = { w: {}, skill: {}, aci: {}, platt: {}, beta: {}, shadow: {} };
  const r = (x, d = 4) => Number(x.toFixed(d));
  for (const h of HORIZONS) {
    o.w[h] = eng.weights(h).map((x) => r(x));
    o.skill[h] = eng.skills(h).map((x) => r(x, 3));
    o.aci[h] = eng.s.aci[h].map((x) => r(x));
    o.platt[h] = { a: r(eng.s.platt[h].a, 3) };
    o.beta[h] = r(eng.beta(h), 3);
    const g = eng.s.gate[h];
    o.shadow[h] = { llGain: g.n > 0 ? Number((g.g / g.n).toPrecision(4)) : null, n: Math.round(g.n) };
  }
  return o;
}

// A release that changes the record's format ships a complete fresh record in data/launch/ (a
// --bootstrap and the backtest, made before the release). The first run that finds it moves the
// current record, unchanged, to data/archive/<the name in data/launch/ARCHIVE_AS>/ and puts the
// launch in its place. The release itself then only adds files the bot never changes, so it can
// be merged whenever it has been reviewed. Safe to repeat after a crash half-way.
const LIVE_ITEMS = ['predictions', 'daily', 'backtest', 'model.json', 'state.json', 'status.json', 'evolution.json', 'fng.json', 'warmup.json', 'backtest.json'];
export function switchToLaunch(data = DATA) {
  const L = path.join(data, 'launch');
  if (!fs.existsSync(L)) return null;
  const name = fs.readFileSync(path.join(L, 'ARCHIVE_AS'), 'utf8').trim();
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`data/launch/ARCHIVE_AS: bad archive name "${name}"`);
  const A = path.join(data, 'archive', name);
  fs.mkdirSync(A, { recursive: true });
  for (const f of LIVE_ITEMS) {
    const src = path.join(data, f), dst = path.join(A, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
  }
  for (const f of fs.readdirSync(L)) {
    if (f === 'ARCHIVE_AS') continue;
    const dst = path.join(data, f);
    if (!fs.existsSync(dst)) fs.renameSync(path.join(L, f), dst);
  }
  fs.rmSync(L, { recursive: true, force: true });
  return name;
}

async function main() {
  const started = Date.now();
  const switched = switchToLaunch();
  if (switched) log(`::notice::started the new record from data/launch; the previous one is in data/archive/${switched}/`);
  let model = readJSON('model.json');
  let state = readJSON('state.json');
  const status = readJSON('status.json', {});
  const bootstrap = flag('--bootstrap') || !model || !state;
  // an incompatible checkpoint must stop the record, loudly: never silently start over
  if (!bootstrap) {
    if (model.featureSchema !== FEATURE_SCHEMA) throw new Error(`data/model.json uses feature schema ${model.featureSchema}, the code computes ${FEATURE_SCHEMA}: run --bootstrap (after archiving the old record)`);
    if (state.v !== STATE_VERSION) throw new Error(`data/state.json is version ${state.v}, the code needs ${STATE_VERSION}: run --bootstrap (after archiving the old record)`);
  }
  const nowMs = Date.now();
  const lastClosed = Math.floor(nowMs / MINUTE) * MINUTE - MINUTE;
  const today = isoDay(nowMs);
  const needTrain = bootstrap || flag('--evolve') || isoDay(Date.parse(model.trainedAt)) !== today;
  const code = (process.env.GITHUB_SHA || '').slice(0, 7) || 'local';

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
    fetchFearGreed(Math.ceil((lastClosed - fromMs) / 86400000) + 10, bootstrap ? [] : readJSON('fng.json', []), nowMs, { backfill: bootstrap }),
  ]);
  if (!ada.length || !btc.length || !eth.length) throw new Error('no candles returned');
  const end = Math.min(...[ada, btc, eth].map((a) => a.reduce((m, k) => Math.max(m, k.t), 0)));
  const S = buildSeries(ada, btc, end, { eth, fng });
  const ds = makeDataset(S);
  log(`data: ${ada.length} ${SYMBOL} + ${btc.length} ${LEAD_SYMBOL} + ${eth.length} ${PEER_SYMBOL} candles via ${lastHost}, ${fng.length} Fear & Greed days, in ${Date.now() - tf} ms; series ${isoMinute(S.t[0])} .. ${isoMinute(S.t[S.t.length - 1])}`);

  const history = { live: {}, replay: {} };
  let rowsOut = [];
  let eng = null;
  let replayed = 0;
  const counts = { live: 0, replay: 0, suspended: 0, unavailable: 0 };

  // ---- 2. replay official minutes with the published model ----
  if (!bootstrap) {
    eng = new Engine(model, state);
    let i0 = indexOf(S, state.t + MINUTE);
    if (i0 < 0 && state.t < S.t[0]) {
      log(`::warning::checkpoint ${isoMinute(state.t)} is older than the fetched data; skipping the gap`);
      i0 = WARMUP;
      eng.s.pending = [];
    }
    if (i0 >= 0) {
      const generated = new Date().toISOString().slice(0, 19) + 'Z';
      const genMs = Date.parse(generated);
      for (let i = Math.max(i0, 0); i < S.t.length; i++) {
        const issue = i >= WARMUP && isIssue(S.t[i]);
        const origin = genMs - (S.t[i] + MINUTE) <= LIVE_MAX_LAG_MIN * MINUTE ? ORIGIN.live : ORIGIN.replay;
        const mus = issue ? expertPredictions(model, ds.X, D, i) : null;
        const { resolved, pred } = eng.step(S.t[i], S.c[i], ds.vol[i], mus, issue ? directionScores(model, ds.X, D, i) : null, { real: !S.syn[i], origin });
        if (isIssue(S.t[i])) {
          const inputs = S.bad[i] || (Number.isFinite(ds.vol[i]) ? 0 : 8);
          rowsOut.push(csvRow(S.t[i], S.c[i], pred, { generated, origin: origin === ORIGIN.live ? 'live' : 'replay', inputs, model: model.id, code }));
          if (pred) counts[origin === ORIGIN.live ? 'live' : 'replay']++; else counts.suspended++;
        }
        for (const r of resolved) {
          const bucket = r.origin === ORIGIN.live ? history.live : r.origin === ORIGIN.replay ? history.replay : null;
          if (r.unavailable) counts.unavailable++;
          if (!bucket) continue; // warm-up leftovers never count
          const dk = isoDay(r.t);
          bucket[dk] ||= emptyHorizonAggs();
          addResolution(bucket[dk][r.h], r);
        }
        replayed++;
      }
    }
    state = eng.snapshot();
    log(`replayed ${replayed} minutes up to ${isoMinute(state.t)}; forecasts: ${counts.live} live, ${counts.replay} replay, ${counts.suspended} suspended; ${counts.unavailable} outcomes unavailable; pending ${state.pending.length}`);
    if (counts.replay) log(`::notice::${counts.replay} forecasts were backfilled after their time (replay): they are recorded but kept out of the live score`);
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
        writeJSON('warmup.json', { note: `Warm-up simulation run once at launch (the long backtest is data/backtest.json, from engine/backtest.mjs): each day the models were refit on earlier data only, then the full online system was stepped minute by minute, so the live record starts with learned trust weights, ranges and calibration. The live record is what counts.`, from: isoMinute(S.t[S.t.length - WARMUP_DAYS * DAY_MIN]), to: isoMinute(S.t[S.t.length - 1]), days, pAbsQuantiles: pStats });
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

  const monthsTouched = new Set([...Object.keys(history.live), ...Object.keys(history.replay)].map((d) => d.slice(0, 7)));
  monthsTouched.add(today.slice(0, 7));
  for (const m of monthsTouched) {
    const file = `daily/${m}.json`;
    const month = readJSON(file, { v: METRICS_VERSION, days: {}, replay: {}, snaps: [] });
    if (month.v !== METRICS_VERSION) throw new Error(`data/${file} has metrics version ${month.v}; refusing to mix it with version ${METRICS_VERSION}`);
    for (const [key, hist] of [['days', history.live], ['replay', history.replay]]) {
      for (const [dk, aggs] of Object.entries(hist)) {
        if (dk.slice(0, 7) !== m) continue;
        const cur = month[key][dk] || {};
        month[key][dk] = Object.fromEntries(HORIZONS.map((h) => [h, roundAgg(mergeAgg(cur[h], aggs[h]))]));
      }
    }
    if (m === today.slice(0, 7) && eng) {
      const bucket = new Date(nowMs).toISOString().slice(0, 11) + String(Math.floor(new Date(nowMs).getUTCHours() / 6) * 6).padStart(2, '0');
      const snap = { at: bucket, ...brainSnapshot(eng) };
      const k = month.snaps.findIndex((s) => s.at === bucket);
      if (k >= 0) month.snaps[k] = snap; else month.snaps.push(snap);
    }
    writeJSON(file, month);
  }

  // live totals (all-time / 7d / 30d) and the replayed ones, from the monthly files
  const months = listMonths();
  const allDays = {}, allReplay = {};
  for (const m of months) { const f = readJSON(`daily/${m}.json`); Object.assign(allDays, f.days); Object.assign(allReplay, f.replay || {}); }
  const totals = { all: emptyHorizonAggs(), d7: emptyHorizonAggs(), d30: emptyHorizonAggs(), replay: emptyHorizonAggs() };
  for (const [dk, a] of Object.entries(allDays)) {
    const age = (Date.parse(today) - Date.parse(dk)) / 86400000;
    for (const h of HORIZONS) {
      totals.all[h] = mergeAgg(totals.all[h], a[h]);
      if (age < 7) totals.d7[h] = mergeAgg(totals.d7[h], a[h]);
      if (age < 30) totals.d30[h] = mergeAgg(totals.d30[h], a[h]);
    }
  }
  for (const a of Object.values(allReplay)) for (const h of HORIZONS) totals.replay[h] = mergeAgg(totals.replay[h], a[h]);
  for (const k of Object.keys(totals)) for (const h of HORIZONS) totals[k][h] = roundAgg(totals[k][h]);

  writeJSON('state.json', state);
  // Fear & Greed as recorded (first-seen values, see candles.mergeFearGreed): the browser reads
  // exactly the values the record used; kept from 30 days before the live record began
  const keepFrom = Math.min(Date.parse(status.liveSince || new Date(nowMs).toISOString()), nowMs) - 30 * 86400000;
  writeJSON('fng.json', fng.filter((x) => x.t >= keepFrom));
  const n = S.t.length;
  const out = {
    updatedAt: new Date().toISOString(),
    siteVersion: siteVersion(),
    t: state.t,
    price: S.c[n - 1],
    liveSince: status.liveSince,
    schema: { record: RECORD_SCHEMA, features: FEATURE_SCHEMA, state: STATE_VERSION, metrics: METRICS_VERSION },
    model: { id: model.id, generation: model.generation, trainedAt: model.trainedAt, dataEnd: model.dataEnd, featureSchema: model.featureSchema },
    experts: EXPERTS.map((e) => e.id),
    run: {
      id: process.env.GITHUB_RUN_ID || 'local',
      sha: code,
      host: lastHost,
      replayed,
      retrained: needTrain,
      durationMs: Date.now() - started,
      runs: (status.run?.runs || 0) + 1,
      trainError,
      forecasts: counts,
    },
    // what a visitor should be warned about even when the site itself deployed fine
    health: {
      dataEnd: isoMinute(S.t[n - 1]),
      dataLagMin: Math.round((lastClosed - S.t[n - 1]) / MINUTE),
      modelAgeH: Math.round((nowMs - Date.parse(model.trainedAt)) / 3600e3),
      trainError,
      replayed: counts.replay,
      suspended: counts.suspended,
    },
    months,
    days: listPredictionDays().slice(-3),
    totals,
  };
  writeJSON('status.json', out, true);
  // problems show up as warnings on the workflow run, even when the site deploys fine
  const warn = (m) => console.log(`::warning::${m}`);
  if (out.health.dataLagMin > 30) warn(`market data is ${out.health.dataLagMin} minutes behind`);
  if (out.health.modelAgeH > 36) warn(`the model is ${out.health.modelAgeH} hours old: the nightly retraining has not succeeded`);
  if (counts.suspended) warn(`${counts.suspended} forecasts suspended: inputs were not real candles (see the inputs column)`);
  for (const h of HORIZONS) {
    const a = totals.d30[h];
    if (a.n >= 500 && Math.abs(a.c[1] / a.n - 0.8) > 0.05) warn(`${h}-minute 80% range held ${(a.c[1] / a.n * 100).toFixed(1)}% of the time over the last 30 days`);
  }
  log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'engine', 'run.mjs')) {
  main().catch((e) => {
    console.error(e);
    console.log(`::error::pipeline failed: ${e.message}`);
    process.exitCode = 1;
  });
}
