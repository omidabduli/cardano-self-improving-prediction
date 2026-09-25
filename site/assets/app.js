// ADAptive front end. Loads the published model + checkpoint, replays every minute since the
// checkpoint with the same engine the backend uses, then keeps stepping on the live Binance
// stream. Every forecast and score on the page is computed here, in the browser.

import { HORIZONS, MINUTE, CADENCE, SYMBOL, BTC_SYMBOL, ETH_SYMBOL, isIssue } from '../core/config.js';
import { buildSeries, indexOf } from '../core/candles.js';
import { computeFeatures, D, WARMUP } from '../core/features.js';
import { expertPredictions, EXPERTS } from '../core/models.js';
import { Engine } from '../core/engine.js';
import { emptyAgg, addResolution, mergeAgg, summarize } from '../core/metrics.js';
import { fetchKlines, fetchFearGreed, fetchPrice, LiveStream, serverClockOffset } from './feed.js';
import { drawChart } from './chart.js';
import * as F from './format.js';

const KEEP_MIN = WARMUP + 1500; // candles kept in memory: warm-up + a day for the chart
const LOG_ROWS = 10;
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
      const o = 2 + k * 4;
      pred.h[h] = { ret: Number(c[o]) / 1e4, p: Number(c[o + 1]), lo80: Number(c[o + 2]) / 1e4, hi80: Number(c[o + 3]) / 1e4 };
    });
    app.official.set(t, pred);
  }
}

function fromEngine(pred) {
  const o = { t: pred.t, c: pred.c, h: {} };
  for (const h of HORIZONS) {
    const x = pred.h[h];
    o.h[h] = { ret: x.ret, med: x.med, p: x.p, w: x.w, lo80: x.lo[1], hi80: x.hi[1] };
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

async function loadCandles(fromMs) {
  const t = now();
  const [ada, btc, eth] = await Promise.all([SYMBOL, BTC_SYMBOL, ETH_SYMBOL].map((s) => fetchKlines(s, fromMs, t)));
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
    const mus = i >= WARMUP && isIssue(S.t[i]) ? expertPredictions(app.model, Fx.X, D, i) : null;
    const { resolved, pred } = eng.step(S.t[i], S.c[i], Fx.vol[i], mus);
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
      const map = sym === SYMBOL ? app.ada : sym === BTC_SYMBOL ? app.btc : sym === ETH_SYMBOL ? app.eth : null;
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
  $('price').textContent = F.price(app.price, 4);
  const c24 = closeAt(lastClosedMinute() - 1440 * MINUTE);
  if (c24) $('chg24').textContent = F.signedPct(app.price / c24 - 1);
  document.title = `$${app.price.toFixed(4)} ADA · ADAptive`;
}

const pctText = (r, d = 2) => `${r > 0 ? '+' : r < 0 ? '\u2212' : '\u00b1'}${Math.abs(r * 100).toFixed(d)}%`;

// One forecast box: the expected change in words and colour, the likely range as a small bar,
// and the chance of going up. Colour is never the only signal: arrows and words say it too.
function forecastBox(pred, h, t0, tNow) {
  const x = pred.h[h];
  const due = t0 + h * MINUTE;
  const c = pred.c;
  const med = c * Math.exp(x.med ?? x.ret), lo = c * Math.exp(x.lo80), hi = c * Math.exp(x.hi80);
  const chg = med / c - 1, loChg = lo / c - 1, hiChg = hi / c - 1;
  const flat = Math.abs(chg) < 0.00005; // rounds to ±0.00%
  const dir = flat ? 'flat' : chg > 0 ? 'up' : 'down';
  const arrow = flat ? '\u2248' : dir === 'up' ? '\u25b2' : '\u25bc';
  // how big the expected move is compared with how far the price could go
  const rel = Math.abs(chg) / Math.max(1e-9, (hiChg - loChg) / 2);
  const words = rel < 0.05 ? 'About the same as' : `${rel < 0.25 ? 'Slightly ' : ''}${chg > 0 ? 'higher' : 'lower'} than`;
  // range bar: the 80% range, the start price (tick), the live price (ring) and the estimate (dot)
  const live = Number.isFinite(app.price) ? app.price : null;
  const a = Math.min(lo, c, live ?? c), b = Math.max(hi, c, live ?? c), pad = (b - a) * 0.08 || c * 0.001;
  const pos = (v) => (((v - (a - pad)) / (b - a + 2 * pad)) * 100).toFixed(1);
  return `<div class="fc">
    <h3 class="fc-h">In ${H_NAME[h]}</h3>
    <p class="fc-head"><span class="fc-price">${F.price(med, 4)}</span><span class="fc-chg ${dir}">${arrow} ${flat ? '\u00b10.00%' : pctText(chg)}</span></p>
    <p class="fc-words">${words} ${F.price(c, 4)} at ${F.hhmm(t0)}</p>
    <div class="fc-bar" role="img" aria-label="80% range ${F.price(lo, 4)} to ${F.price(hi, 4)}, estimate ${F.price(med, 4)}">
      <i class="band" style="left:${pos(lo)}%;width:${(pos(hi) - pos(lo)).toFixed(1)}%"></i>
      <i class="now" style="left:${pos(c)}%" title="${F.price(c, 4)} at ${F.hhmm(t0)}"></i>
      ${live !== null && Math.abs(live / c - 1) > 0.0002 ? `<i class="cur" style="left:${pos(live)}%" title="now ${F.price(live, 4)}"></i>` : ''}
      <i class="est ${dir}" style="left:${pos(med)}%"></i>
    </div>
    <p class="fc-range"><span>${F.price(lo, 4)} <b class="down">${pctText(loChg, 1)}</b></span><span>80% range</span><span>${F.price(hi, 4)} <b class="up">${pctText(hiChg, 1)}</b></span></p>
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
  $('forecasts').innerHTML = HORIZONS.map((h) => forecastBox(pred, h, t0, tNow)).join('');
  const next = issuedAt(pred.t) + CADENCE * MINUTE;
  const committed = app.status ? F.ago(Date.parse(app.status.updatedAt)) : '—';
  const stale = issuedAt(pred.t) <= tNow - CADENCE * MINUTE;
  $('issueLine').innerHTML = `<span>${stale ? 'Last published forecast, made' : 'Made'} at <b>${F.hhmm(t0)}</b> from ${F.price(pred.c, 4)}</span>`
    + `<span>Next forecast in <b>${next > tNow ? F.countdown(next - tNow) : 'a moment'}</b></span>`
    + `<span>Times in your time zone</span><span>Record committed ${committed}</span>`;
}

function renderChart() {
  const tNow = now(), t0 = tNow - 1440 * MINUTE;
  const series = [];
  for (const [t, k] of app.ada) if (t >= t0 && (Math.round(t / MINUTE) % 5 === 0)) series.push({ t: t + MINUTE, c: k.c });
  if (series.length < 10) for (const [t, c] of app.csvClose) if (t >= t0) series.push({ t: t + MINUTE, c });
  series.sort((a, b) => a.t - b.t);
  const band = [];
  const all = new Map([...app.official, ...app.live]);
  for (const [t, p] of all) {
    const at = issuedAt(t) + 60 * MINUTE;
    if (at < t0 || at > tNow) continue;
    band.push({ t: at, lo: p.c * Math.exp(p.h[60].lo80), hi: p.c * Math.exp(p.h[60].hi80) });
  }
  band.sort((a, b) => a.t - b.t);
  const pred = latestPred();
  const fc = pred ? HORIZONS.map((h) => {
    const x = pred.h[h];
    return { h, t: issuedAt(pred.t) + h * MINUTE, med: pred.c * Math.exp(x.med ?? x.ret), lo: pred.c * Math.exp(x.lo80), hi: pred.c * Math.exp(x.hi80) };
  }) : [];
  drawChart($('chartSvg'), { now: tNow, price: app.price ?? series.at(-1)?.c, series, band, fc });
}

function totals(h) {
  return mergeAgg(app.status?.totals?.all?.[h], app.sinceCkpt[h]);
}

function renderScores() {
  $('scores').querySelector('tbody').innerHTML = HORIZONS.map((h) => {
    const a = totals(h), s = summarize(a);
    if (!s) return `<tr><td class="h">${H_SHORT[h]}</td><td colspan="4">No forecast has reached its time yet. The first ${H_NAME[h]} forecast is checked ${H_NAME[h]} after launch.</td></tr>`;
    const dir = a.ni ? `${(a.hi / a.ni * 100).toFixed(1)}%` : '—';
    const z = s.ni >= 10 ? `z = ${s.zscore.toFixed(1)} vs. a coin flip` : 'too few to judge yet';
    const goal = h === 60 ? ' · goal 54%' : '';
    return `<tr>
      <td class="h">${H_SHORT[h]}</td>
      <td class="big">${dir}<small>${F.num(s.ni)} independent · ${z}${goal}</small></td>
      <td class="big">${(s.cov[1] * 100).toFixed(1)}%<small>of ${F.num(s.n)} forecasts</small></td>
      <td class="big">${(s.mae * 100).toFixed(2)}%<small>"no change": ${(s.mae0 * 100).toFixed(2)}%</small></td>
      <td class="num">${F.num(s.n)}</td>
    </tr>`;
  }).join('');
  const since = HORIZONS.reduce((a, h) => a + app.sinceCkpt[h].n, 0);
  const s = app.status;
  let note = s ? `Official record committed ${F.ago(Date.parse(s.updatedAt))}.` : '';
  if (app.marketOk && since) note += ` The ${F.num(since)} results since then were scored in your browser with the same code and data.`;
  const bt = app.backtest && summarizeBacktest(app.backtest);
  if (bt) note += ` Launch backtest (${bt.days} simulated days before going live): direction ${bt.dir}, 80% range held ${bt.cov}.`;
  $('recordNote').textContent = note;
  if (s?.liveSince) $('liveSince').textContent = `live since ${F.dateShort(Date.parse(s.liveSince))}`;
}

function summarizeBacktest(b) {
  const days = Object.values(b.days || {});
  if (!days.length) return null;
  const per = HORIZONS.map((h) => days.reduce((a, d) => mergeAgg(a, d[h]), null));
  return {
    days: days.length,
    dir: HORIZONS.map((h, k) => `${H_SHORT[h]} ${(per[k].hi / per[k].ni * 100).toFixed(0)}% of ${per[k].ni}`).join(', '),
    cov: HORIZONS.map((h, k) => `${(per[k].c[1] / per[k].n * 100).toFixed(0)}%`).join(' / '),
  };
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
    const inside = y >= x.lo80 && y <= x.hi80;
    const dir = y === 0 ? 'flat' : (y > 0) === (x.p >= 0.5) ? 'direction right' : 'direction wrong';
    return `<tr>
      <td class="num">${when(issuedAt(t))}</td>
      <td>${H_SHORT[h]}</td>
      <td class="num">${F.price(p.c * Math.exp(x.med ?? x.ret), 4)}</td>
      <td class="num">${F.price(p.c * Math.exp(x.lo80), 4)} – ${F.price(p.c * Math.exp(x.hi80), 4)}</td>
      <td class="num">${F.price(c1, 4)}</td>
      <td><span class="status ${inside ? 'done' : 'active'}">${inside ? 'in range' : 'outside'}</span> <small>${dir}</small></td>
    </tr>`;
  }).join('') || `<tr><td colspan="6">The first forecasts are checked one hour after launch.</td></tr>`;
}

function renderCouncil() {
  const eng = app.engine;
  const w = Object.fromEntries(HORIZONS.map((h) => [h, eng ? eng.weights(h) : null]));
  $('council').querySelector('tbody').innerHTML = EXPERTS.map((e, k) => `<tr>
    <td class="name">${F.esc(e.name)}</td>
    <td class="reads">${F.esc(e.role)}</td>
    ${HORIZONS.map((h) => {
      const v = w[h]?.[k];
      return `<td class="num">${Number.isFinite(v) ? `<span class="trust"><i style="width:${Math.round(v * 120)}px"></i>${(v * 100).toFixed(0)}%</span>` : '—'}</td>`;
    }).join('')}
  </tr>`).join('');
}

function renderEvolution() {
  const gens = app.evo?.generations || [];
  const m = app.model;
  if (!m) return;
  const promos = gens.reduce((a, g) => a + (g.report?.linear?.promoted ? 1 : 0) + (g.report?.forest?.promoted ? 1 : 0), 0);
  const last = gens.at(-1);
  let txt = `Generation ${m.generation}, trained ${F.ago(Date.parse(m.trainedAt))}. `;
  txt += promos ? `${promos} challenger${promos === 1 ? ' has' : 's have'} won so far.` : 'No challenger has beaten the launch settings yet.';
  if (last?.report) {
    const r = last.report;
    txt += ` Last tournament: Linear Brain ${r.linear.promoted ? 'replaced' : 'kept'}, Boosted Forest ${r.forest.promoted ? 'replaced' : 'kept'}.`;
  }
  $('evoNote').textContent = txt;
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
  renderEvolution();
}

function renderMinute() {
  trim();
  renderPrice();
  renderForecasts();
  renderChart();
  renderScores();
  renderLog();
  renderCouncil();
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
  fetchPrice(SYMBOL).then((p) => { app.price ??= p; renderPrice(); renderChart(); }).catch(() => {});
  await startLive();
  setInterval(tick, 1000);
  setInterval(pollStatus, 120_000);
  setInterval(renderStatic, 60_000);
}

boot();
