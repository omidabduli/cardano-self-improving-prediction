// ADAptive front end. Loads the published model + checkpoint, replays every minute since the
// checkpoint with the same engine the backend uses, then keeps stepping on the live Binance
// stream. Every forecast and score on the page is computed here, in the browser.

import { HORIZONS, MINUTE, CADENCE, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, PRICE_DIGITS, isIssue } from '../core/config.js';
import { buildSeries, indexOf } from '../core/candles.js';
import { computeFeatures, D, WARMUP } from '../core/features.js';
import { expertPredictions, directionScores, EXPERTS } from '../core/models.js';
import { Engine } from '../core/engine.js';
import { emptyAgg, addResolution, mergeAgg, summarize } from '../core/metrics.js';
import { fetchKlines, fetchFearGreed, fetchPrice, LiveStream, serverClockOffset } from './feed.js';
import { drawChart } from './chart.js';
import * as F from './format.js';

const KEEP_MIN = WARMUP + 1500; // candles kept in memory: warm-up + a day for the chart
const LOG_ROWS = 8;
const H_NAME = { 60: '1 hour', 180: '3 hours', 1440: '24 hours' };
const H_SHORT = { 60: '1 h', 180: '3 h', 1440: '24 h' };

const repo = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : 'omidabduli/cardano-self-improving-prediction';
})();

const app = {
  status: null, model: null, state: null, evo: null, backtest: null, months: {},
  official: new Map(), live: new Map(), csvClose: new Map(),
  // backtest forecasts from just before the live record began (drawn dashed in the chart)
  btPred: new Map(),
  ada: new Map(), btc: new Map(), eth: new Map(), fng: [],
  price: null, engine: null, lastPred: null,
  // scored in this browser since the published checkpoint: added to the official totals so
  // the page is complete up to this minute, however long ago GitHub last ran
  sinceCkpt: Object.fromEntries(HORIZONS.map((h) => [h, emptyAgg()])),
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

function parseCSV(text) {
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 2) continue;
    const t = Date.parse(c[0] + ':00Z');
    const close = Number(c[1]);
    app.csvClose.set(t, close);
    if (!c[2]) continue;
    const pred = { t, c: close, h: {} };
    HORIZONS.forEach((h, k) => {
      const o = 2 + k * 5;
      pred.h[h] = { ret: Number(c[o]) / 1e4, p: Number(c[o + 1]), lo80: Number(c[o + 2]) / 1e4, hi80: Number(c[o + 3]) / 1e4, strong: c[o + 4] === '1' };
    });
    app.official.set(t, pred);
  }
}

function fromEngine(pred) {
  const o = { t: pred.t, c: pred.c, h: {} };
  for (const h of HORIZONS) {
    const x = pred.h[h];
    o.h[h] = { ret: x.ret, med: x.med, p: x.p, strong: x.strong, w: x.w, lo80: x.lo[1], hi80: x.hi[1] };
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
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(',');
      const t = Date.parse(c[0] + ':00Z');
      if (!(t >= since)) { older = true; continue; }
      // columns per horizon: est_bp, p_up, confident, lo80_bp, hi80_bp, actual_bp
      app.btPred.set(t, { t, c: Number(c[1]), h: { 60: { p: Number(c[3]), strong: c[4] === '1', lo80: Number(c[5]) / 1e4, hi80: Number(c[6]) / 1e4 } } });
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
  app.engine = new Engine(app.model, app.state);
  app.live.clear();
  app.sinceCkpt = Object.fromEntries(HORIZONS.map((h) => [h, emptyAgg()]));
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
    const { resolved, pred } = eng.step(S.t[i], S.c[i], Fx.vol[i], mus, issue ? directionScores(app.model, Fx.X, D, i) : null);
    if (pred) { app.live.set(S.t[i], fromEngine(pred)); app.lastPred = fromEngine(pred); }
    for (const r of resolved) addResolution(app.sinceCkpt[r.h], r);
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
  document.title = `${F.price(app.price, PRICE_DIGITS)} ADA · ADAptive`;
}

const pctText = (r, d = 2) => `${r > 0 ? '+' : r < 0 ? '\u2212' : '\u00b1'}${Math.abs(r * 100).toFixed(d)}%`;

// The predicted move as one number (log-return): the direction call (P(up)) times how far the
// price typically moves over the horizon, read off the calibrated 80% range (for a normal-shaped
// move, the mean absolute move is 0.798 sigma and the 80% range spans 2 x 1.2816 sigma). It is
// small when the model isn't sure and grows with its confidence.
const estMove = (x) => (2 * x.p - 1) * 0.798 * (x.hi80 - x.lo80) / (2 * 1.2816);

// One forecast box: the predicted price, its change and the direction call.
function forecastBox(pred, h) {
  const x = pred.h[h];
  const c = pred.c, r = estMove(x), est = c * Math.exp(r);
  const up = x.p >= 0.5, pr = up ? x.p : 1 - x.p;
  const dir = up ? 'up' : 'down';
  return `<div class="fc">
    <h3 class="fc-h">In ${H_NAME[h]}</h3>
    <p class="fc-head"><span class="fc-price">${F.price(est, PRICE_DIGITS)}</span><span class="fc-chg ${dir}">${up ? '▲' : '▼'} ${pctText(r)}</span></p>
    <p class="fc-dir"><span class="${dir}">${up ? 'Up' : 'Down'}, ${(pr * 100).toFixed(0)}% likely</span>${x.strong ? ' <span class="status done">confident</span>' : ''}</p>
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
  // prediction line, past: every 1-hour prediction at the moment it came due
  const pred = [];
  const all = new Map([...app.official, ...app.live]);
  for (const [t, p] of all) {
    const at = issuedAt(t) + 60 * MINUTE;
    if (at >= t0 && at <= tNow) pred.push({ t: at, c: p.c * Math.exp(estMove(p.h[60])) });
  }
  pred.sort((a, b) => a.t - b.t);
  const firstLive = Math.min(...[...all.keys()]);
  const past = [];
  for (const [t, p] of app.btPred) {
    const at = issuedAt(t) + 60 * MINUTE;
    if (t < firstLive && at >= t0) past.push({ t: at, c: p.c * Math.exp(estMove(p.h[60])) });
  }
  past.sort((a, b) => a.t - b.t);
  const last = latestPred();
  // ahead: from the price now through the latest 1 h, 3 h and 24 h predictions
  const marks = last ? HORIZONS.map((h) => ({ h, t: issuedAt(last.t) + h * MINUTE, c: last.c * Math.exp(estMove(last.h[h])) })) : [];
  drawChart($('chartSvg'), { now: tNow, price: app.price ?? series.at(-1)?.c, series, pred, past, marks });
}

function totals(h) {
  return mergeAgg(app.status?.totals?.all?.[h], app.sinceCkpt[h]);
}

const pctCell = (hit, n) => (n ? `${(hit / n * 100).toFixed(1)}%` : '—');

// Per horizon: direction right on confident calls (non-overlapping), with all calls underneath.
function scoreCell(a, empty) {
  if (!a || !a.ni) return `<td class="big">—<small>${empty}</small></td>`;
  return `<td class="big">${pctCell(a.shi, a.sni)}<small>confident calls (${F.num(a.sni)}) · all calls ${pctCell(a.hi, a.ni)}</small></td>`;
}

function renderScores() {
  const b = app.backtest, keys = Object.keys(b?.days || {});
  $('scores').querySelector('tbody').innerHTML = HORIZONS.map((h) => {
    const bt = keys.reduce((a, d) => mergeAgg(a, b.days[d][h]), null);
    return `<tr><td class="h">${H_SHORT[h]}</td>${scoreCell(totals(h), 'first results after ' + H_NAME[h])}${scoreCell(bt, 'no test yet')}</tr>`;
  }).join('');
  const s = app.status;
  $('recordNote').textContent = (s ? `Live record updated ${F.ago(Date.parse(s.updatedAt))}. ` : '')
    + 'Each call counts once: one per hour, per 3 hours or per day, so a single lucky move is never counted twice. At 24 hours there is no edge yet.';
  if (s?.liveSince) $('liveSince').textContent = `live since ${F.dateShort(Date.parse(s.liveSince))}`;
}

function renderLog() {
  const tNow = lastClosedMinute();
  const rows = [];
  const all = new Map([...app.official, ...app.live]);
  for (const [t, p] of all) {
    for (const h of HORIZONS) {
      const c1 = closeAt(t + h * MINUTE);
      if (t + h * MINUTE > tNow || c1 === undefined) continue;
      rows.push({ t, h, p, c1, due: issuedAt(t) + h * MINUTE });
    }
  }
  rows.sort((a, b) => b.due - a.due || a.h - b.h);
  const today = new Date().toDateString();
  const when = (ms) => (new Date(ms).toDateString() === today ? F.hhmm(ms) : `${F.dateShort(ms)} ${F.hhmm(ms)}`);
  $('log').querySelector('tbody').innerHTML = rows.slice(0, LOG_ROWS).map(({ t, h, p, c1 }) => {
    const x = p.h[h];
    const y = Math.log(c1 / p.c);
    const right = y !== 0 && (y > 0) === (x.p >= 0.5);
    return `<tr>
      <td class="num">${when(issuedAt(t))}</td>
      <td>${H_SHORT[h]}</td>
      <td class="num">${F.price(p.c * Math.exp(estMove(x)), PRICE_DIGITS)}</td>
      <td class="num">${F.price(c1, PRICE_DIGITS)}</td>
      <td>${y === 0 ? '<span class="status planned">flat</span>' : `<span class="status ${right ? 'done' : 'active'}">${right ? 'right' : 'wrong'}</span>`}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="5">The first predictions are checked one hour after launch.</td></tr>`;
}

function renderStatic() {
  const s = app.status;
  if (!s) return;
  const banner = $('banner');
  const stale = Date.now() - Date.parse(s.updatedAt) > 12 * 3600e3;
  if (!app.marketOk && app.marketTried) {
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
  $('btCsvLink').href = `${gh}/tree/main/data/backtest`;
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
