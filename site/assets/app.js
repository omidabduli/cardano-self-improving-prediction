// Front end. Loads the published model + checkpoint, replays every minute since the checkpoint
// with the same engine the backend uses, then keeps stepping on the live Binance stream. Every
// forecast on the page is computed here, in the browser, with the same code that writes the
// record (site/core/forecast.js), so the price shown is the price recorded and scored. The
// scores on the page come from the published record only: live forecasts, never backfilled or
// browser-computed ones.

import { HORIZONS, MINUTE, CADENCE, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, PRICE_DIGITS, ASSET, SHADOW_HORIZONS, SHOW_MOVE, isIssue } from '../core/config.js';
import { buildSeries, indexOf } from '../core/candles.js';
import { computeFeatures, D, WARMUP, FEATURE_SCHEMA } from '../core/features.js';
import { expertPredictions, directionScores } from '../core/models.js';
import { Engine, ORIGIN, STATE_VERSION } from '../core/engine.js';
import { summarize } from '../core/metrics.js';
import { fetchKlines, fetchFearGreed, fetchPrice, LiveStream, serverClockOffset } from './feed.js';
import { drawChart } from './chart.js';
import * as F from './format.js';

const KEEP_MIN = WARMUP + 1500; // candles kept in memory: warm-up + a day for the chart
const LOG_ROWS = 8; // rows visible at once; the rest of the last LOG_DAYS scroll
const LOG_DAYS = 2;
const H_NAME = { 60: '1 hour', 180: '3 hours', 1440: '24 hours' };
const H_SHORT = { 60: '1 h', 180: '3 h', 1440: '24 h' };

const repo = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : ASSET.repo;
})();

const app = {
  status: null, model: null, state: null, evo: null, backtest: null, months: {},
  official: new Map(), live: new Map(), csvClose: new Map(),
  // backtest forecasts from just before the live record began (drawn dashed in the chart)
  btPred: new Map(),
  ada: new Map(), btc: new Map(), eth: new Map(), fng: [],
  price: null, engine: null, lastPred: null, incompatible: null,
  marketOk: false, marketTried: false, closeTimer: null,
};
window.adaptive = app; // for the curious: inspect the live engine from the console

const $ = (id) => document.getElementById(id);
const bust = () => Date.now().toString(36);
let clockOffset = 0; // Binance server time decides which candle is closed, not the visitor's clock
const now = () => Date.now() + clockOffset;
const lastClosedMinute = () => Math.floor(now() / MINUTE) * MINUTE - MINUTE;

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// ---------------------------------------------------------------- data

const predAt = (t) => app.official.get(t) || app.live.get(t);
const closeAt = (t) => app.ada.get(t)?.c ?? app.csvClose.get(t);
const issuedAt = (t) => t + MINUTE; // a forecast is made when candle t closes

// Record CSV (engine/store.mjs CSV_HEADER), read by column name.
function parseCSV(text) {
  const lines = text.trim().split('\n');
  const col = Object.fromEntries(lines[0].split(',').map((k, i) => [k, i]));
  if (col.time === undefined || col.price60 === undefined) return; // another schema (archived record)
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const t = Date.parse(c[col.time] + ':00Z');
    const close = Number(c[col.close]);
    if (!Number.isFinite(t)) continue;
    app.csvClose.set(t, close);
    if (c[col.status] !== 'ok') continue;
    const pred = { t, c: close, origin: c[col.origin], h: {} };
    for (const h of HORIZONS) pred.h[h] = { price: Number(c[col[`price${h}`]]), p: Number(c[col[`p${h}`]]), direction: c[col[`dir${h}`]], lo: Number(c[col[`lo${h}`]]) / 1e4, hi: Number(c[col[`hi${h}`]]) / 1e4 };
    app.official.set(t, pred);
  }
}

function fromEngine(pred) {
  const o = { t: pred.t, c: pred.c, h: {} };
  for (const h of HORIZONS) {
    const x = pred.h[h];
    o.h[h] = { price: x.price, p: x.p, direction: x.direction, lo: x.lo[1], hi: x.hi[1] };
  }
  return o;
}

async function loadPublished() {
  const status = await getJSON(`data/status.json?t=${bust()}`);
  const modelChanged = !app.model || app.model.id !== status.model.id;
  const [model, state, evo, backtest] = await Promise.all([
    modelChanged ? getJSON(`data/model.json?v=${encodeURIComponent(status.model.id)}`) : app.model,
    getJSON(`data/state.json?v=${status.t}`),
    modelChanged ? getJSON(`data/evolution.json?v=${encodeURIComponent(status.model.id)}`) : app.evo,
    app.backtest ? app.backtest : getJSON('data/backtest.json').catch(() => null),
  ]);
  const months = await Promise.all(status.months.slice(-3).map((m) => getJSON(`data/daily/${m}.json?v=${status.t}`).catch(() => null)));
  const csvs = await Promise.all(status.days.slice(-3).map((d) => getText(`data/predictions/${d}.csv?v=${status.t}`).catch(() => '')));
  Object.assign(app, { status, model, state, evo, backtest });
  app.siteVersion ??= status.siteVersion;
  // a model or checkpoint from another version of the code: say so instead of computing nonsense
  app.incompatible = model.featureSchema !== FEATURE_SCHEMA || state.v !== STATE_VERSION
    ? `The published model (${model.featureSchema || 'old'}, checkpoint v${state.v}) does not match this page's code (${FEATURE_SCHEMA}, v${STATE_VERSION}). Reload the page in a few minutes.` : null;
  status.months.slice(-3).forEach((m, i) => { if (months[i]) app.months[m] = months[i]; });
  for (const txt of csvs) if (txt) parseCSV(txt);
  for (const t of [...app.live.keys()]) if (t <= state.t) app.live.delete(t);
}

// The backtest runs right up to the live record, so its last day of forecasts continues the
// prediction line to the left of the first live one. Only the newest monthly file is needed
// (plus the one before early in a month).
async function loadBacktestTail() {
  const ms = app.backtest?.months || [];
  if (!ms.length) return;
  const since = now() - 26 * 3600e3;
  for (const m of ms.slice(-2).reverse()) {
    let text;
    try { text = await getText(`data/backtest/${m}.csv`); } catch { continue; }
    const lines = text.trim().split('\n');
    let older = false;
    const col = Object.fromEntries(lines[0].split(',').map((k, i) => [k, i]));
    if (col['1h_price'] === undefined) continue; // an older schema
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const t = Date.parse(c[0] + ':00Z');
      if (!(t >= since)) { older = true; continue; }
      app.btPred.set(t, { t, c: Number(c[1]), h: { 60: { price: Number(c[col['1h_price']]), direction: c[col['1h_dir']], lo: Number(c[col['1h_lo80_bp']]) / 1e4, hi: Number(c[col['1h_hi80_bp']]) / 1e4, actual: c[col['1h_actual_bp']] === '' ? null : Number(c[col['1h_actual_bp']]) / 1e4 } } });
    }
    if (older) break; // this file already reaches back far enough
  }
  renderChart();
}

async function loadCandles(fromMs) {
  const t = now();
  const [ada, btc, eth] = await Promise.all([SYMBOL, LEAD_SYMBOL, PEER_SYMBOL].map((s) => fetchKlines(s, fromMs, t)));
  for (const [list, map] of [[ada, app.ada], [btc, app.btc], [eth, app.eth]]) {
    for (const k of list) if (k.T < t) map.set(k.t, k); else if (map === app.ada) app.price ??= k.c;
  }
  if (!Number.isFinite(app.price) && app.ada.size) app.price = [...app.ada.values()].at(-1).c;
  app.marketOk = true;
}

function trim() {
  const cut = now() - KEEP_MIN * MINUTE;
  for (const m of [app.ada, app.btc, app.eth]) for (const t of m.keys()) if (t < cut) m.delete(t);
  for (const t of app.live.keys()) if (t < now() - 2 * 1440 * MINUTE) app.live.delete(t);
}

// ---------------------------------------------------------------- engine

function rebuildEngine() {
  if (app.incompatible) { app.engine = null; return; }
  app.engine = new Engine(app.model, app.state);
  app.live.clear();
  advance();
}

// Step the engine through every closed minute for which all three markets have a candle.
function advance() {
  const eng = app.engine;
  if (!eng || !app.ada.size) return false;
  let end = -Infinity;
  for (const t of app.ada.keys()) if (t > end && app.btc.has(t) && app.eth.has(t)) end = t;
  if (end <= eng.s.t) return false;
  const start = Math.min(eng.s.t - (WARMUP + 5) * MINUTE, end - (WARMUP + 5) * MINUTE);
  const pick = (m) => { const a = []; for (const [t, k] of m) if (t >= start && t <= end) a.push(k); return a; };
  const S = buildSeries(pick(app.ada), pick(app.btc), end, { eth: pick(app.eth), fng: app.fng });
  const Fx = computeFeatures(S, WARMUP, CADENCE);
  let i = indexOf(S, eng.s.t + MINUTE);
  if (i < 0) {
    // checkpoint older than our data window: restart from the first usable minute
    i = WARMUP;
    eng.s.pending = [];
    eng.s.t = S.t[i - 1];
  }
  let changed = false;
  for (; i < S.t.length; i++) {
    const issue = i >= WARMUP && isIssue(S.t[i]);
    const mus = issue ? expertPredictions(app.model, Fx.X, D, i) : null;
    const { pred } = eng.step(S.t[i], S.c[i], Fx.vol[i], mus, issue ? directionScores(app.model, Fx.X, D, i) : null, { real: !S.syn[i], origin: ORIGIN.preview });
    if (pred) { app.live.set(S.t[i], fromEngine(pred)); app.lastPred = fromEngine(pred); }
    changed = true;
  }
  return changed;
}

async function catchUp() {
  if (!app.engine) return;
  try {
    await loadCandles(Math.min(app.engine.s.t, lastClosedMinute()) - 5 * MINUTE);
    if (advance()) renderMinute();
  } catch { /* the stream or the next poll will retry */ }
}

function onClosed(t) {
  clearTimeout(app.closeTimer);
  if (app.ada.has(t) && app.btc.has(t) && app.eth.has(t)) { if (advance()) renderMinute(); return; }
  app.closeTimer = setTimeout(catchUp, 3500);
}

async function pollStatus() {
  try {
    const s = await getJSON(`data/status.json?t=${bust()}`);
    if (app.siteVersion && s.siteVersion && s.siteVersion !== app.siteVersion && !app.reloadAt) {
      // new site code was deployed: reload once GitHub Pages' 10-minute cache has expired,
      // so long-open pages keep running exactly the code that writes the record
      app.reloadAt = Date.now() + 11 * 60e3;
      setTimeout(() => location.reload(), 11 * 60e3);
    }
    if (app.status && s.t === app.status.t) return;
    await loadPublished();
    app.fng = await fetchFearGreed(`data/fng.json?v=${s.t}`);
    if (app.marketOk) rebuildEngine();
    renderStatic();
    renderMinute();
  } catch { /* keep running on the current checkpoint */ }
}

function startStream() {
  const stream = new LiveStream({
    onState(s) {
      const el = $('liveState');
      el.className = 'live ' + (s === 'live' ? 'on' : 'warn');
      el.textContent = s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : 'reconnecting';
    },
    onOpen() { if (app.engine) catchUp(); },
    onKline(sym, k) {
      const map = sym === SYMBOL ? app.ada : sym === LEAD_SYMBOL ? app.btc : sym === PEER_SYMBOL ? app.eth : null;
      if (!map) return;
      if (k.closed) { map.set(k.t, k); onClosed(k.t); } else if (sym === SYMBOL) setPrice(k.c);
    },
    onTrade(p) { setPrice(p); },
  });
  stream.connect();
}

let priceRaf = 0;
function setPrice(p) {
  if (!Number.isFinite(p)) return;
  app.price = p;
  if (!priceRaf) priceRaf = requestAnimationFrame(() => { priceRaf = 0; renderPrice(); });
}

// ---------------------------------------------------------------- rendering

function latestPred() {
  if (app.lastPred) return app.lastPred;
  let best = null;
  for (const [t, p] of app.official) if (!best || t > best.t) best = p;
  return best;
}

function renderPrice() {
  if (!Number.isFinite(app.price)) return;
  $('price').textContent = F.price(app.price, PRICE_DIGITS);
  const c24 = closeAt(lastClosedMinute() - 1440 * MINUTE);
  if (c24) $('chg24').textContent = F.signedPct(app.price / c24 - 1);
  document.title = `${F.price(app.price, PRICE_DIGITS > 2 ? PRICE_DIGITS : 0)} ${ASSET.ticker} · ${ASSET.brand}`;
}

const pctText = (r, d = 2) => `${r > 0 ? '+' : r < 0 ? '\u2212' : '\u00b1'}${Math.abs(r * 100).toFixed(d)}%`;

// One forecast box. The price shown is exactly the number the record stores and scores
// (forecast.js). With SHOW_MOVE off (no price formula beat "no change" in testing) the box leads
// with the direction call and gives today's price as the price estimate. P(up) within half a
// point of 50% is no call; a SHADOW horizon makes no call at all.
function forecastBox(pred, h) {
  const x = pred.h[h];
  const r = Math.log(x.price / pred.c);
  const call = x.direction === 'up' || x.direction === 'down';
  const up = x.direction === 'up', pr = up ? x.p : 1 - x.p;
  const cls = call ? x.direction : 'flat';
  if (!SHOW_MOVE) {
    const shadow = SHADOW_HORIZONS.includes(h);
    const head = shadow ? 'No call' : call ? `${up ? '▲ Up' : '▼ Down'}, ${(pr * 100).toFixed(0)}% likely` : 'No clear direction';
    return `<div class="fc">
    <h3 class="fc-h">In ${H_NAME[h]}</h3>
    <p class="fc-call ${shadow ? 'flat' : cls}">${head}</p>
  </div>`;
  }
  const arrow = call ? (up ? '▲' : '▼') : '■';
  const dirText = call ? `${up ? 'Up' : 'Down'}, ${(pr * 100).toFixed(0)}% likely` : 'No clear direction (50%)';
  return `<div class="fc">
    <h3 class="fc-h">In ${H_NAME[h]}</h3>
    <p class="fc-head"><span class="fc-price">${F.price(x.price, PRICE_DIGITS)}</span><span class="fc-chg ${cls}">${arrow} ${pctText(r)}</span></p>
    <p class="fc-dir"><span class="${cls}">${dirText}</span></p>
  </div>`;
}

// A forecast is current until the next one is due. An older one is never shown as if it were
// fresh: while live data loads the boxes say "calculating", and only if live data can't be
// reached at all is the last published forecast shown, with its time.
function renderForecasts() {
  const pred = latestPred();
  const tNow = now();
  const current = pred && issuedAt(pred.t) > tNow - CADENCE * MINUTE;
  if (!current && !(pred && app.marketTried && !app.marketOk)) {
    $('forecasts').innerHTML = HORIZONS.map((h) => `<div class="fc">
      <h3 class="fc-h">In ${H_NAME[h]}</h3>
      <p class="fc-head"><span class="fc-wait">calculating…</span></p>
      <p class="fc-due">${app.marketTried ? 'Waiting for the next forecast' : 'Reading the live market'}</p>
    </div>`).join('');
    $('issueLine').innerHTML = '<span>A new forecast is made at :00, :15, :30 and :45</span>';
    return;
  }
  const t0 = issuedAt(pred.t);
  if (app.incompatible) { $('forecasts').innerHTML = `<div class="fc"><p class="eyebrow">${app.incompatible}</p></div>`; return; }
  $('forecasts').innerHTML = HORIZONS.map((h) => forecastBox(pred, h)).join('');
  const next = issuedAt(pred.t) + CADENCE * MINUTE;
  const stale = issuedAt(pred.t) <= tNow - CADENCE * MINUTE;
  $('issueLine').innerHTML = `<span>${stale ? 'Last published forecast, made' : 'Made'} at <b>${F.hhmm(t0)}</b> from ${F.price(pred.c, PRICE_DIGITS)}</span>`
    + `<span>Next forecast in <b>${next > tNow ? F.countdown(next - tNow) : 'a moment'}</b></span>`;
}

function renderChart() {
  const tNow = now(), t0 = tNow - 1440 * MINUTE;
  const series = [];
  for (const [t, k] of app.ada) if (t >= t0 && (Math.round(t / MINUTE) % 5 === 0)) series.push({ t: t + MINUTE, c: k.c });
  if (series.length < 10) for (const [t, c] of app.csvClose) if (t >= t0) series.push({ t: t + MINUTE, c });
  series.sort((a, b) => a.t - b.t);
  // the 80% range, past: every 1-hour forecast's range at the moment it came due; before the
  // live record began, the backtest's forecasts fill it in
  const all = new Map([...app.official, ...app.live]);
  const firstLive = Math.min(...[...all.keys()]);
  const band = [];
  const addBand = (t, p) => {
    const x = p.h[60], at = issuedAt(t) + 60 * MINUTE;
    if (at >= t0 && at <= tNow && Number.isFinite(x.lo) && Number.isFinite(x.hi)) band.push({ t: at, lo: p.c * Math.exp(x.lo), hi: p.c * Math.exp(x.hi) });
  };
  for (const [t, p] of all) addBand(t, p);
  for (const [t, p] of app.btPred) if (t < firstLive) addBand(t, p);
  band.sort((a, b) => a.t - b.t);
  // the hourly 1-hour calls (issued on the hour), where they were made; filled = came true
  const calls = [];
  const addCall = (t, p, y) => {
    const x = p.h[60];
    const due = issuedAt(t) + 60 * MINUTE;
    if ((Math.round(t / MINUTE) + 1) % 60 || issuedAt(t) < t0 || due > tNow) return;
    if ((x.direction !== 'up' && x.direction !== 'down') || !Number.isFinite(y) || y === 0) return;
    calls.push({ t: issuedAt(t), c: p.c, up: x.direction === 'up', right: (y > 0) === (x.direction === 'up') });
  };
  for (const [t, p] of all) { const c1 = closeAt(t + 60 * MINUTE); if (c1 !== undefined) addCall(t, p, Math.log(c1 / p.c)); }
  for (const [t, p] of app.btPred) if (t < firstLive) addCall(t, p, p.h[60].actual);
  const last = latestPred();
  // ahead: the latest 1-hour, 3-hour and 24-hour calls, with their ranges
  const tag = (x, h) => (SHADOW_HORIZONS.includes(h) ? '' : x.direction === 'up' ? ` ▲${Math.round(x.p * 100)}%` : x.direction === 'down' ? ` ▼${Math.round((1 - x.p) * 100)}%` : '');
  const marks = last ? HORIZONS.map((h) => ({ h, t: issuedAt(last.t) + h * MINUTE, lo: last.c * Math.exp(last.h[h].lo), hi: last.c * Math.exp(last.h[h].hi), label: `${H_SHORT[h]}${tag(last.h[h], h)}` })).filter((m) => Number.isFinite(m.lo) && Number.isFinite(m.hi)) : [];
  drawChart($('chartSvg'), { now: tNow, price: app.price ?? series.at(-1)?.c, series, band, calls, marks });
}

// the published live record only (forecasts made on time; backfilled ones are counted apart)
const totals = (h) => (app.status?.schema?.metrics === 4 ? app.status.totals.all[h] : null);

const pct = (x, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);

// Per horizon: how often the direction was right (non-overlapping calls), and how many calls.
function scoreCell(a, empty) {
  const s = a && summarize(a);
  if (!s || !s.ni) {
    if (s && s.callShare === 0) return `<td class="big">no call</td>`;
    return `<td class="big">—<small>${empty}</small></td>`;
  }
  return `<td class="big">${pct(s.accI)}<small>${F.num(s.ni)} calls</small></td>`;
}

function renderScores() {
  $('scores').querySelector('tbody').innerHTML = HORIZONS.map((h) => {
    if (SHADOW_HORIZONS.includes(h)) return `<tr><td class="h">${H_SHORT[h]}</td><td class="big">no call</td></tr>`;
    return `<tr><td class="h">${H_SHORT[h]}</td>${scoreCell(totals(h), 'first results after ' + H_NAME[h])}</tr>`;
  }).join('');
  const s = app.status;
  $('recordNote').textContent = s ? `Updated ${F.ago(Date.parse(s.updatedAt))}.` : '';
  if (s?.liveSince) $('liveSince').textContent = `live since ${F.dateShort(Date.parse(s.liveSince))}`;
}

function renderLog() {
  const tNow = lastClosedMinute();
  const rows = [];
  const all = new Map([...app.official, ...app.live]);
  for (const [t, p] of all) {
    for (const h of HORIZONS) {
      if (SHADOW_HORIZONS.includes(h)) continue;
      const c1 = closeAt(t + h * MINUTE);
      if (t + h * MINUTE > tNow || c1 === undefined) continue;
      rows.push({ t, h, p, c1, due: issuedAt(t) + h * MINUTE });
    }
  }
  rows.sort((a, b) => b.due - a.due || a.h - b.h);
  const since = tNow - LOG_DAYS * 1440 * MINUTE;
  const today = new Date().toDateString();
  const when = (ms) => (new Date(ms).toDateString() === today ? F.hhmm(ms) : `${F.dateShort(ms)} ${F.hhmm(ms)}`);
  $('log').querySelector('tbody').innerHTML = rows.filter((r, i) => i < LOG_ROWS || r.due >= since).map(({ t, h, p, c1 }) => {
    const x = p.h[h];
    const y = Math.log(c1 / p.c);
    const call = x.direction === 'up' || x.direction === 'down';
    const right = y !== 0 && (y > 0) === (x.direction === 'up');
    const likely = call ? `<span class="${x.direction}">${x.direction === 'up' ? '▲ Up' : '▼ Down'} ${Math.round((x.direction === 'up' ? x.p : 1 - x.p) * 100)}%</span>` : '<span class="flat">none</span>';
    const verdict = !call ? '<span class="status planned">no call</span>' : y === 0 ? '<span class="status planned">flat</span>' : `<span class="status ${right ? 'done' : 'active'}">${right ? 'right' : 'wrong'}</span>`;
    return `<tr>
      <td class="num">${when(issuedAt(t))}</td>
      <td>${H_SHORT[h]}</td>
      <td class="num">${likely}</td>
      <td class="num">${F.price(x.price, PRICE_DIGITS)}</td>
      <td class="num">${F.price(c1, PRICE_DIGITS)}</td>
      <td>${verdict}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6">The first predictions are checked one hour after launch.</td></tr>`;
  // the box stays LOG_ROWS rows tall; older rows scroll
  const wrap = $('logWrap'), trs = wrap.querySelectorAll('tbody tr');
  wrap.style.maxHeight = trs.length > LOG_ROWS ? `${trs[LOG_ROWS].offsetTop}px` : '';
}

function renderStatic() {
  const s = app.status;
  if (!s) return;
  const banner = $('banner');
  const stale = Date.now() - Date.parse(s.updatedAt) > 12 * 3600e3;
  const hl = s.health || {};
  if (app.incompatible) {
    banner.hidden = false;
    banner.textContent = app.incompatible;
  } else if (hl.trainError || hl.modelAgeH > 36) {
    banner.hidden = false;
    banner.textContent = `The nightly retraining ${hl.trainError ? 'failed' : 'has not run'}: the model is ${hl.modelAgeH} hours old. Forecasts continue with it.`;
  } else if (!app.marketOk && app.marketTried) {
    banner.hidden = false;
    banner.textContent = 'The live Binance feed is not reachable from your network, so this page shows the last committed record.';
  } else if (stale) {
    banner.hidden = false;
    banner.textContent = `GitHub last committed the official record ${F.ago(Date.parse(s.updatedAt))}. The forecasts and scores on this page are still computed live.`;
  } else banner.hidden = true;
}

function renderMinute() {
  trim();
  renderPrice();
  renderForecasts();
  renderChart();
  renderScores();
  renderLog();
}

function tick() {
  renderForecasts();
}

// ---------------------------------------------------------------- boot

// Load recent candles and go live; if Binance is unreachable or rate-limits us, keep showing
// the published record and try again with a growing pause.
async function startLive(attempt = 0) {
  try {
    clockOffset = await serverClockOffset().catch(() => 0);
    const lc = lastClosedMinute();
    const from = Math.max(Math.min(lc - 1500 * MINUTE, app.state.t - (WARMUP + 10) * MINUTE), lc - 3 * 1440 * MINUTE - (WARMUP + 10) * MINUTE);
    const [fng] = await Promise.all([fetchFearGreed(`data/fng.json?v=${app.status.t}`), loadCandles(from)]);
    app.fng = fng;
    rebuildEngine();
    startStream();
  } catch (e) {
    console.warn('live market data unavailable', e);
    app.marketOk = false;
    $('liveState').className = 'live warn';
    $('liveState').textContent = 'offline, retrying';
    setTimeout(() => startLive(attempt + 1), Math.min(300e3, 20e3 * 2 ** attempt));
  }
  app.marketTried = true;
  renderStatic();
  renderMinute();
}

async function boot() {
  const gh = `https://github.com/${repo}`;
  $('ghLink').href = gh;
  $('csvLink').href = `${gh}/tree/main/data/predictions`;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { catchUp(); pollStatus(); } });
  let resizeT = 0;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderChart, 150); });
  try {
    await loadPublished();
  } catch (e) {
    $('forecasts').innerHTML = '<div class="fc"><p class="eyebrow">Could not load the published model. Please retry in a minute.</p></div>';
    console.error(e);
    return;
  }
  // show the page straight away: the published record, the live price as soon as one tiny
  // request answers, and the forecast once the browser has caught up with the market
  renderStatic();
  renderMinute();
  loadBacktestTail();
  fetchPrice(SYMBOL).then((p) => { app.price ??= p; renderPrice(); renderChart(); }).catch(() => {});
  await startLive();
  setInterval(tick, 1000);
  setInterval(pollStatus, 120_000);
  setInterval(renderStatic, 60_000);
}

boot();
