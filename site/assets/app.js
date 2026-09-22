// ADAptive front end. Loads the published model + checkpoint, replays every minute since
// the checkpoint with the same engine the backend uses, then keeps stepping on the live
// Binance stream. Everything shown is computed here, in the browser.

import { HORIZONS, MINUTE, SYMBOL, BTC_SYMBOL, STRONG_EDGE } from '../core/config.js';
import { buildSeries, indexOf } from '../core/candles.js';
import { computeFeatures, D, WARMUP, FEATURES } from '../core/features.js';
import { expertPredictions, EXPERTS } from '../core/models.js';
import { Engine } from '../core/engine.js';
import { emptyAgg, addResolution, mergeAgg, summarize } from '../core/metrics.js';
import { fetchKlines, LiveStream, serverClockOffset } from './feed.js';
import { ForecastChart } from './chart.js';
import * as mini from './mini.js';
import * as F from './format.js';

const HCOL = { 5: '#5b8cff', 15: '#2ee6c5', 60: '#ffc857' };
const EXCOL = { rw: '#6c7a96', micro: '#5b8cff', btc: '#ffb347', swing: '#c77dff', linear: '#2ee6c5', forest: '#22e39a' };
const KEEP_MIN = 3200;

const repo = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const seg = location.pathname.split('/').filter(Boolean)[0];
  return m && seg ? `${m[1]}/${seg}` : 'omidabduli/cardano-self-improving-prediction';
})();

const app = {
  status: null, model: null, state: null, evo: null, backtest: null, months: {},
  official: new Map(), live: new Map(), csvClose: new Map(),
  ada: new Map(), btc: new Map(), liveCandle: null,
  price: null, prevPrice: null,
  engine: null, lastPred: null,
  selH: 5, range: 180, councilH: 5, learnH: 5,
  loadedAt: Date.now(), session: Object.fromEntries(HORIZONS.map((h) => [h, emptyAgg()])),
  feedSeen: new Set(), firstFeed: true,
  marketOk: false, stream: null, closeTimer: null,
};

// Exposed for the curious: inspect the live engine from the browser console.
window.adaptive = app;

const $ = (id) => document.getElementById(id);
const bust = () => Date.now().toString(36);
// Binance server time: deciding which candle is closed must not depend on the visitor's clock.
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

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

// ---------------------------------------------------------------- data access

const lastClosedMinute = () => Math.floor(now() / MINUTE) * MINUTE - MINUTE;
const predAt = (t) => app.official.get(t) || app.live.get(t);
const closeAt = (t) => app.ada.get(t)?.c ?? app.csvClose.get(t);

function outcome(t, h) {
  const p = predAt(t);
  if (!p || !p.h[h]) return null;
  const c1 = closeAt(t + h * MINUTE);
  if (c1 === undefined) return null;
  const x = p.h[h];
  const y = Math.log(c1 / p.c);
  return { t, h, y, c0: p.c, c1, p: x.p, hit: y === 0 ? null : (y > 0) === (x.p >= 0.5) ? 1 : 0, in80: y >= x.lo80 && y <= x.hi80 };
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 2) continue;
    const t = Date.parse(c[0] + ':00Z');
    const close = Number(c[1]);
    app.csvClose.set(t, close);
    if (c[2] === '' || c[2] === undefined) continue;
    const pred = { t, c: close, official: true, h: {} };
    HORIZONS.forEach((h, k) => {
      const o = 2 + k * 4;
      pred.h[h] = { ret: Number(c[o]) / 1e4, p: Number(c[o + 1]), lo80: Number(c[o + 2]) / 1e4, hi80: Number(c[o + 3]) / 1e4 };
    });
    app.official.set(t, pred);
  }
}

function fromEngine(pred) {
  const o = { t: pred.t, c: pred.c, vol: pred.vol, h: {} };
  for (const h of HORIZONS) {
    const x = pred.h[h];
    o.h[h] = { ret: x.ret, med: x.med, p: x.p, mu: x.mu, w: x.w, mus: x.mus, lo50: x.lo[0], hi50: x.hi[0], lo80: x.lo[1], hi80: x.hi[1], lo95: x.lo[2], hi95: x.hi[2] };
  }
  return o;
}

// ---------------------------------------------------------------- loading

async function loadPublished() {
  const status = await getJSON(`data/status.json?t=${bust()}`);
  const modelChanged = !app.model || app.model.id !== status.model.id;
  const [model, state, evo, backtest] = await Promise.all([
    modelChanged ? getJSON(`data/model.json?v=${encodeURIComponent(status.model.id)}`) : app.model,
    getJSON(`data/state.json?v=${status.t}`),
    modelChanged ? getJSON(`data/evolution.json?v=${encodeURIComponent(status.model.id)}`) : app.evo,
    app.backtest ? app.backtest : getJSON('data/backtest.json').catch(() => null),
  ]);
  const recentMonths = status.months.slice(-6);
  const months = await Promise.all(recentMonths.map((m) => getJSON(`data/daily/${m}.json?v=${status.t}`).catch(() => null)));
  const csvs = await Promise.all(status.days.slice(-2).map((d) => getText(`data/predictions/${d}.csv?v=${status.t}`).catch(() => '')));
  Object.assign(app, { status, model, state, evo, backtest });
  app.siteVersion ??= status.siteVersion;
  recentMonths.forEach((m, i) => { if (months[i]) app.months[m] = months[i]; });
  for (const txt of csvs) if (txt) parseCSV(txt);
  // live predictions older than the new checkpoint are now in the official record
  for (const t of [...app.live.keys()]) if (t <= state.t) app.live.delete(t);
}

async function loadCandles(fromMs) {
  const t = now();
  const [ada, btc] = await Promise.all([fetchKlines(SYMBOL, fromMs, t), fetchKlines(BTC_SYMBOL, fromMs, t)]);
  for (const k of ada) {
    if (k.T < t) app.ada.set(k.t, k);
    else app.liveCandle = k;
  }
  for (const k of btc) if (k.T < t) app.btc.set(k.t, k);
  if (app.liveCandle) app.price ??= app.liveCandle.c;
  app.marketOk = true;
}

function trim() {
  const cut = now() - KEEP_MIN * MINUTE;
  for (const m of [app.ada, app.btc, app.live]) for (const t of m.keys()) if (t < cut) m.delete(t);
}

// ---------------------------------------------------------------- engine

function rebuildEngine() {
  app.engine = new Engine(app.model, app.state);
  app.live.clear();
  advance(true);
}

// Step the engine through every closed minute we have both candles for.
function advance(replaying = false) {
  const eng = app.engine;
  if (!eng || !app.ada.size || !app.btc.size) return false;
  let end = -Infinity;
  for (const t of app.ada.keys()) if (t > end && app.btc.has(t)) end = t;
  if (end <= eng.s.t) return false;
  const start = Math.min(eng.s.t - (WARMUP + 5) * MINUTE, end - 400 * MINUTE);
  const pick = (m) => { const a = []; for (const [t, k] of m) if (t >= start && t <= end) a.push(k); return a; };
  const S = buildSeries(pick(app.ada), pick(app.btc), end);
  const Fx = computeFeatures(S);
  let i = indexOf(S, eng.s.t + MINUTE);
  if (i < 0) {
    // checkpoint older than our data window: restart from the first usable minute
    i = WARMUP;
    eng.s.pending = [];
    eng.s.t = S.t[i - 1];
  }
  let changed = false;
  for (; i < S.t.length; i++) {
    const mus = i >= WARMUP ? expertPredictions(app.model, Fx.X, D, i) : null;
    const { resolved, pred } = eng.step(S.t[i], S.c[i], Fx.vol[i], mus);
    if (pred) { app.live.set(S.t[i], fromEngine(pred)); app.lastPred = fromEngine(pred); }
    for (const r of resolved) {
      if (!replaying && r.t + r.h * MINUTE + MINUTE >= app.loadedAt) addResolution(app.session[r.h], r);
    }
    changed = true;
  }
  return changed;
}

async function catchUp() {
  if (!app.engine) return;
  try {
    const from = Math.min(app.engine.s.t, lastClosedMinute()) - 5 * MINUTE;
    await loadCandles(from);
    if (advance()) renderMinute();
  } catch (e) { /* the stream or next poll will retry */ }
}

function onClosed(t) {
  if (app.ada.has(t) && app.btc.has(t)) {
    clearTimeout(app.closeTimer);
    if (advance()) renderMinute();
    return;
  }
  clearTimeout(app.closeTimer);
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
    if (app.marketOk) rebuildEngine();
    renderStatic();
    renderMinute();
  } catch (e) { /* keep running on the current checkpoint */ }
}

// ---------------------------------------------------------------- live stream

function startStream() {
  app.stream = new LiveStream({
    onState(s) {
      const pill = $('livePill');
      pill.classList.toggle('on', s === 'live');
      pill.classList.toggle('warn', s !== 'live');
      $('liveText').textContent = s === 'live' ? 'live' : s === 'connecting' ? 'connecting' : 'reconnecting';
    },
    onOpen() { if (app.engine) catchUp(); },
    onKline(sym, k) {
      if (sym === SYMBOL) {
        if (k.closed) { app.ada.set(k.t, k); if (app.liveCandle && app.liveCandle.t <= k.t) app.liveCandle = null; onClosed(k.t); }
        else { app.liveCandle = k; setPrice(k.c); }
      } else if (sym === BTC_SYMBOL && k.closed) {
        app.btc.set(k.t, k);
        onClosed(k.t);
      }
    },
    onTrade(p) { setPrice(p); },
  });
  app.stream.connect();
}

let priceRaf = 0;
function setPrice(p) {
  if (!Number.isFinite(p)) return;
  app.prevPrice = app.price;
  app.price = p;
  if (!priceRaf) priceRaf = requestAnimationFrame(() => { priceRaf = 0; renderPrice(); renderChart(); });
}

// ---------------------------------------------------------------- rendering

function renderPrice() {
  const el = $('price');
  if (!Number.isFinite(app.price)) return;
  const txt = app.price.toFixed(4);
  if (el.textContent !== '$' + txt) {
    el.textContent = '$' + txt;
    if (Number.isFinite(app.prevPrice) && app.prevPrice !== app.price) {
      el.classList.remove('flash-up', 'flash-down');
      void el.offsetWidth;
      el.classList.add(app.price > app.prevPrice ? 'flash-up' : 'flash-down');
      setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 350);
    }
  }
  const t24 = lastClosedMinute() - 1440 * MINUTE;
  const c24 = closeAt(t24);
  const chg = $('chg24');
  if (c24) {
    const r = app.price / c24 - 1;
    chg.textContent = `${F.signedPct(r)} 24h`;
    chg.className = 'chg ' + (r > 0 ? 'up' : r < 0 ? 'down' : '');
  }
  document.title = `$${txt} ADA · ADAptive`;
}

const ARROW_UP = '<svg class="fc-arrow" viewBox="0 0 24 24"><path d="M12 4l8 10h-5v6H9v-6H4z" fill="currentColor"/></svg>';
const ARROW_DN = '<svg class="fc-arrow" viewBox="0 0 24 24"><path d="M12 20L4 10h5V4h6v6h5z" fill="currentColor"/></svg>';

function latestPred() {
  if (app.lastPred) return app.lastPred;
  let best = null;
  for (const [t, p] of app.official) if (!best || t > best.t) best = p;
  return best;
}

function renderCards() {
  const pred = latestPred();
  const box = $('forecastCards');
  if (!pred) { box.innerHTML = '<div class="fc"><div class="fc-main">Waiting for the first forecast…</div></div>'; return; }
  const tNow = now();
  box.innerHTML = HORIZONS.map((h) => {
    const x = pred.h[h];
    const up = x.p >= 0.5;
    const conf = Math.max(x.p, 1 - x.p);
    const edge = Math.abs(x.p - 0.5);
    const badge = edge >= STRONG_EDGE ? '<span class="fc-badge strong">confident</span>' : edge >= 0.01 ? '<span class="fc-badge">lean</span>' : '<span class="fc-badge">no clear edge</span>';
    const target = pred.c * Math.exp(x.med ?? x.ret);
    const lo = pred.c * Math.exp(x.lo80), hi = pred.c * Math.exp(x.hi80);
    const due = pred.t + (h + 1) * MINUTE;
    // the forecast being checked at the end of the current minute
    const checkT = lastClosedMinute() - (h - 1) * MINUTE;
    const chk = predAt(checkT);
    let check = '';
    if (chk && Number.isFinite(app.price)) {
      const y = Math.log(app.price / chk.c);
      const cu = chk.h[h].p >= 0.5;
      const state = y === 0 ? '<b>flat</b>' : (y > 0) === cu ? '<b class="win">winning</b>' : '<b class="lose">losing</b>';
      check = `<span>Checking the ${F.hhmm(checkT + MINUTE)} call (${cu ? '▲' : '▼'}): ${state}</span>`;
    }
    const gl = up ? 50 : 50 - Math.min(50, (edge / 0.1) * 50);
    const gw = Math.min(50, (edge / 0.1) * 50);
    return `<div class="fc ${edge < 0.004 ? '' : up ? 'up' : 'down'} ${h === app.selH ? 'sel' : ''}" data-h="${h}">
      <div class="fc-h"><b>${F.horizonLabel(h)}</b><span>ahead</span></div>
      <div class="fc-main">${up ? ARROW_UP : ARROW_DN}<span class="fc-p">${(conf * 100).toFixed(1)}%</span><span class="fc-word">${up ? 'up' : 'down'}</span></div>
      ${badge}
      <div class="fc-detail"><span>median <b>${F.price(target, 5)}</b></span><span>80% range <b>${lo.toFixed(4)}–${hi.toFixed(4)}</b></span></div>
      <div class="fc-gauge"><i style="left:${gl}%;width:${gw}%;background:${up ? 'var(--up)' : 'var(--down)'}"></i></div>
      <div class="fc-foot"><span>Checked at ${F.hhmm(due)} · in <b>${F.countdown(due - tNow)}</b></span>${check}</div>
    </div>`;
  }).join('');
}

function interpBand(pred, key, k) {
  // bands at 5/15/60 minutes, interpolated in sqrt-time (uncertainty grows like sqrt(t))
  const knots = [0, 5, 15, 60];
  const val = (h) => (h === 0 ? 0 : pred.h[h][key]);
  if (k <= 5) return key === 'ret' ? val(5) * (k / 5) : val(5) * Math.sqrt(k / 5);
  for (let j = 1; j < knots.length - 1; j++) {
    const a = knots[j], b = knots[j + 1];
    if (k <= b) {
      const f = key === 'ret' ? (k - a) / (b - a) : (Math.sqrt(k) - Math.sqrt(a)) / (Math.sqrt(b) - Math.sqrt(a));
      return val(a) + (val(b) - val(a)) * f;
    }
  }
  return val(60);
}

function fanFor(pred) {
  if (!pred) return null;
  const p = structuredClone(pred);
  for (const h of HORIZONS) {
    const x = p.h[h];
    if (x.lo50 === undefined) {
      // official rows carry the 80% band only: derive the others from its width
      const c = (x.lo80 + x.hi80) / 2, w = (x.hi80 - x.lo80) / 2;
      Object.assign(x, { lo50: c - w * 0.526, hi50: c + w * 0.526, lo95: c - w * 1.53, hi95: c + w * 1.53 });
    }
  }
  const steps = [];
  for (let k = 1; k <= 60; k++) {
    const s = { x: p.t + (k + 1) * MINUTE, mid: p.c * Math.exp(interpBand(p, 'ret', k)) };
    for (const key of ['lo50', 'hi50', 'lo80', 'hi80', 'lo95', 'hi95']) s[key] = p.c * Math.exp(interpBand(p, key, k));
    steps.push(s);
  }
  const p60 = p.h[app.selH].p;
  return { x0: p.t + MINUTE, y0: p.c, steps, dir: Math.abs(p60 - 0.5) < 0.004 ? 0 : p60 > 0.5 ? 1 : -1 };
}

let chart;
function renderChart() {
  if (!chart) return;
  const tNow = now();
  const H = app.selH;
  const x0 = tNow - app.range * MINUTE, x1 = tNow + 62 * MINUTE;
  const points = [];
  const lc = lastClosedMinute();
  const startT = Math.floor(x0 / MINUTE) * MINUTE - 3 * MINUTE;
  for (let t = startT; t <= lc; t += MINUTE) {
    const c = closeAt(t);
    if (c !== undefined) points.push({ x: t + MINUTE, y: c });
  }
  let live = null;
  if (app.marketOk && Number.isFinite(app.price)) { live = { x: tNow, y: app.price }; points.push(live); }
  else if (points.length) live = null;
  const corridor = [], results = [];
  for (let t = startT - (H + 1) * MINUTE; t <= lc; t += MINUTE) {
    const p = predAt(t);
    if (!p) continue;
    const x = p.h[H];
    const xt = t + (H + 1) * MINUTE;
    corridor.push({ x: xt, lo: p.c * Math.exp(x.lo80), hi: p.c * Math.exp(x.hi80), mid: p.c * Math.exp(x.ret) });
    const o = outcome(t, H);
    if (o) results.push({ x: xt, s: o.hit === null ? -1 : o.hit });
  }
  const pred = latestPred();
  chart.set({ x0, x1, now: live ? tNow : (points.at(-1)?.x ?? tNow), points, live, corridor, results, fan: fanFor(pred), lookup: tooltip });
  $('chartLoading').hidden = points.length > 0;
}

function tooltip(x) {
  const H = app.selH;
  const t = x - MINUTE; // candle whose close is shown at x
  const c = closeAt(t);
  if (c === undefined) {
    const p = latestPred();
    if (!p || x <= p.t + MINUTE) return '';
    const k = Math.round((x - p.t - MINUTE) / MINUTE);
    if (k < 1 || k > 60) return '';
    const f = fanFor(p).steps[k - 1];
    return `<div class="t">${F.hhmm(x)} · forecast +${k} min</div>
      <div class="r"><span>Median</span><b>${f.mid.toFixed(5)}</b></div>
      <div class="r"><span>50% range</span><b>${f.lo50.toFixed(4)}–${f.hi50.toFixed(4)}</b></div>
      <div class="r"><span>80% range</span><b>${f.lo80.toFixed(4)}–${f.hi80.toFixed(4)}</b></div>
      <div class="r"><span>95% range</span><b>${f.lo95.toFixed(4)}–${f.hi95.toFixed(4)}</b></div>`;
  }
  let html = `<div class="t">${F.hhmm(x)} · ${F.price(c)}</div>`;
  const made = predAt(t);
  if (made) {
    const x5 = made.h[H];
    const up = x5.p >= 0.5;
    html += `<div class="r"><span>${F.horizonLabel(H)} call made here</span><b class="${up ? 'ok' : 'no'}">${up ? '▲' : '▼'} ${(Math.max(x5.p, 1 - x5.p) * 100).toFixed(1)}%</b></div>`;
    const o = outcome(t, H);
    if (o) html += `<div class="r"><span>Result</span><b class="${o.hit === 1 ? 'ok' : o.hit === 0 ? 'no' : ''}">${o.hit === null ? 'no change' : o.hit ? '✓ right' : '✗ wrong'} (${F.signedPct(Math.exp(o.y) - 1, 2)})</b></div>`;
    else html += `<div class="r"><span>Result</span><b>pending</b></div>`;
  }
  const back = predAt(t - H * MINUTE);
  if (back) {
    const lo = back.c * Math.exp(back.h[H].lo80), hi = back.c * Math.exp(back.h[H].hi80);
    const inside = c >= lo - 1e-12 && c <= hi + 1e-12;
    html += `<div class="r"><span>Predicted ${H}m earlier</span><b class="${inside ? 'ok' : 'no'}">${lo.toFixed(4)}–${hi.toFixed(4)} ${inside ? '✓' : '✗'}</b></div>`;
  }
  return html;
}

function aggWindow(fromT, toT) {
  const out = Object.fromEntries(HORIZONS.map((h) => [h, emptyAgg()]));
  const lc = lastClosedMinute();
  for (let t = Math.floor(fromT / MINUTE) * MINUTE; t <= Math.min(toT, lc); t += MINUTE) {
    const p = predAt(t);
    if (!p) continue;
    for (const h of HORIZONS) {
      const o = outcome(t, h);
      if (!o) continue;
      const x = p.h[h];
      const hi = o.hit;
      const r = { t, h, y: o.y, z: 0, mu: 0, p: x.p, hit: hi, inb: [false, o.in80, false], strong: Math.abs(x.p - 0.5) >= STRONG_EDGE };
      addResolution(out[h], r);
    }
  }
  return out;
}

function renderScoreboard() {
  const tNow = now();
  const d1 = aggWindow(tNow - 24 * 3600e3, tNow);
  const tot = app.status?.totals;
  const cell = (v, sub, cls = '', barPct = null, tick = null, extra = '') => `<div class="score-cell ${extra}"><div class="v ${cls}">${v}</div><div class="s">${sub}</div>${barPct !== null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, barPct))}%"></i>${tick !== null ? `<span class="tick" style="left:${tick}%"></span>` : ''}</div>` : ''}</div>`;
  let html = `<div class="score-row head"><span></span><span>Last 24 hours</span><span>All time</span><span class="opt">80% band hit</span><span class="opt">Confident calls</span></div>`;
  for (const h of HORIZONS) {
    const a = summarize(d1[h]);
    const all = tot ? summarize(tot.all[h]) : null;
    const accCls = (s) => (!s || s.acc === null ? '' : s.acc > 0.5 ? 'good' : s.acc < 0.5 ? 'bad' : '');
    const c24 = a ? cell(F.pct(a.acc), `${F.num(a.nm)} checked`, accCls(a), a.acc !== null ? (a.acc - 0.4) / 0.2 * 100 : 0, 50) : cell('—', 'no results yet');
    let sig = 'no data yet';
    if (all && all.ni < 50) {
      // the z-test uses non-overlapping calls only; below ~50 of them any verdict is noise
      sig = `too early to judge (${all.ni}/50 independent calls)`;
    } else if (all && all.zscore !== null) {
      const z = all.zscore;
      sig = `z = ${z.toFixed(1)} · ${z >= 3 ? 'strong evidence of skill' : z >= 2 ? 'likely skill' : z >= 1 ? 'weak evidence' : 'not beating chance yet'}`;
    }
    const call = all ? cell(F.pct(all.acc), `${F.num(all.nm)} · ${sig}`, accCls(all), all.acc !== null ? (all.acc - 0.4) / 0.2 * 100 : 0, 50) : cell('—', 'no results yet');
    const cov = a ? cell(F.pct(a.cov[1]), `24h · all-time ${all ? F.pct(all.cov[1]) : '—'}`, '', a.cov[1] * 100, 80, 'opt') : cell('—', '', '', null, null, 'opt');
    const strong = all && all.strongN ? cell(F.pct(all.strongAcc), `${F.num(all.strongN)} calls ≥${(50 + STRONG_EDGE * 100).toFixed(0)}% sure`, accCls({ acc: all.strongAcc }), null, null, 'opt') : cell('—', 'none yet', '', null, null, 'opt');
    html += `<div class="score-row"><div class="score-h">${F.horizonLabel(h)}</div>${c24}${call}${cov}${strong}</div>`;
  }
  $('scoreTable').innerHTML = html;
  const s = Object.values(app.session).reduce((a, b) => mergeAgg(a, b), null);
  const ss = summarize(s);
  $('session').innerHTML = ss
    ? `Since you opened this page: <b>${ss.n}</b> forecasts checked · <b>${ss.nm ? F.pct(ss.acc) : '—'}</b> right direction (${s.hit}/${s.nm}) · <b>${F.pct(ss.cov[1])}</b> inside their 80% band.`
    : 'Since you opened this page: the first forecasts will be checked within a minute. Keep watching.';
}

function renderFeed() {
  const lc = lastClosedMinute();
  const items = [];
  for (let t = lc - 70 * MINUTE; t <= lc; t += MINUTE) {
    for (const h of HORIZONS) {
      const o = outcome(t, h);
      if (o) items.push({ ...o, due: t + (h + 1) * MINUTE });
    }
  }
  items.sort((a, b) => b.due - a.due || a.h - b.h);
  const top = items.slice(0, 40);
  if (!top.length) { $('feed').innerHTML = '<li class="empty">The first forecasts are being checked. This list fills up as their time comes.</li>'; return; }
  $('feed').innerHTML = top.map((o) => {
    const key = `${o.t}-${o.h}`;
    const fresh = !app.firstFeed && !app.feedSeen.has(key);
    app.feedSeen.add(key);
    const up = o.p >= 0.5;
    const res = o.hit === null ? '<span class="res tie">=</span>' : o.hit ? '<span class="res ok">✓</span>' : '<span class="res no">✗</span>';
    const mv = Math.exp(o.y) - 1;
    return `<li class="${fresh ? 'new' : ''}">${res}<span class="tm">${F.hhmm(o.due)}</span><span class="hz">${F.horizonLabel(o.h)}</span><span class="call">said <span class="${up ? 'u' : 'd'}">${up ? '▲' : '▼'} ${(Math.max(o.p, 1 - o.p) * 100).toFixed(1)}%</span> at ${o.c0.toFixed(4)}</span><span class="mv">${o.c1.toFixed(4)} (${F.signedPct(mv, 2)})<span class="band">${o.in80 ? 'in band' : 'outside'}</span></span></li>`;
  }).join('');
  app.firstFeed = false;
  if (app.feedSeen.size > 3000) app.feedSeen = new Set([...app.feedSeen].slice(-1500));
}

const ICONS = {
  rw: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18"/><circle cx="12" cy="12" r="3"/></svg>',
  micro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 18V9M9 18V5M14 18v-6M19 18V8"/></svg>',
  btc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h6a3 3 0 010 6H8zm0 6h7a3 3 0 010 6H8zM10 4v2m0 12v2m3-16v2m0 12v2"/></svg>',
  swing: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 16c3 0 3-8 6-8s3 8 6 8 3-8 6-8"/></svg>',
  linear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19L20 5"/><circle cx="7" cy="14" r="1.2"/><circle cx="11" cy="12" r="1.2"/><circle cx="15" cy="7" r="1.2"/><circle cx="17" cy="11" r="1.2"/></svg>',
  forest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M12 8l-5 5m5-5l5 5M7 13l-3 4m3-4l3 4m7-4l-3 4m3-4l3 4"/></svg>',
};

function renderCouncil() {
  const h = app.councilH;
  const eng = app.engine || (app.model && app.state ? new Engine(app.model, app.state) : null);
  if (!eng) return;
  const w = eng.weights(h), sk = eng.skills(h);
  const pred = app.lastPred;
  $('council').innerHTML = EXPERTS.map((e, k) => {
    let vote = '<div class="ex-vote flat">—</div>';
    if (pred && pred.h[h].mus) {
      const mv = pred.h[h].mus[k] * pred.vol * Math.sqrt(h);
      const cls = Math.abs(mv) < 0.05e-4 ? 'flat' : mv > 0 ? 'up' : 'down';
      vote = `<div class="ex-vote ${cls}" title="Expected move over ${F.horizonWords(h)}">${cls === 'flat' ? '● flat' : (mv > 0 ? '▲ ' : '▼ ') + F.bps(mv, 1).replace(/^[+−]/, '')}</div>`;
    }
    return `<div class="expert"><div class="ex-icon" style="color:${EXCOL[e.id]};border-color:${EXCOL[e.id]}55;background:${EXCOL[e.id]}18">${ICONS[e.id]}</div>
      <div style="min-width:0"><div class="ex-name">${e.name}</div><div class="ex-role">${e.role}</div></div>
      ${vote}
      <div class="ex-w"><b>${(w[k] * 100).toFixed(1)}%</b><div class="bar"><i style="width:${Math.min(100, w[k] * 100 * 2.5)}%"></i></div><small>skill ${sk[k] >= 0 ? '+' : ''}${sk[k].toFixed(2)}%</small></div></div>`;
  }).join('');

  const snaps = Object.keys(app.months).sort().flatMap((m) => app.months[m].snaps || []);
  const labels = snaps.map((s) => s.at.slice(5, 10) + ' ' + s.at.slice(11, 13) + 'h');
  const layers = EXPERTS.map((e, k) => ({ name: e.name, color: EXCOL[e.id], values: snaps.map((s) => s.w[h]?.[k] ?? 0) }));
  labels.push('now');
  layers.forEach((L, k) => L.values.push(w[k]));
  mini.stackedArea($('weightsChart'), { labels, layers });
  $('weightsLegend').innerHTML = EXPERTS.map((e) => `<span><i style="background:${EXCOL[e.id]}"></i>${e.name}</span>`).join('');
}

function describeCfg(kind, c) {
  if (!c) return '';
  if (kind === 'linear') return `λ=${Number(c.lambda).toExponential(1)} · ${c.window}d window · ${c.groups.length} signal groups`;
  return `${c.trees} trees · depth ${c.depth} · lr ${c.lr} · leaf ≥${c.minLeaf} · ${c.window}d`;
}

function renderEvolution() {
  const gens = app.evo?.generations || [];
  if (!gens.length) { mini.empty($('evoChart'), 'No generations yet'); return; }
  const last = gens.at(-1);
  const promotions = gens.reduce((a, g) => a + (g.report.linear.promoted ? 1 : 0) + (g.report.forest.promoted ? 1 : 0), 0);
  const imp = (r) => r.winner - r.gen0;
  $('evoStats').innerHTML = `
    <div class="evo-stat"><span>Generation</span><b>${last.gen}</b><small>${F.dateShort(Date.parse(last.at))} · next ${nextEvolution()}</small></div>
    <div class="evo-stat"><span>Promotions</span><b>${promotions}</b><small>challengers that won so far</small></div>
    <div class="evo-stat"><span>vs. generation 0</span><b style="color:${imp(last.report.forest) + imp(last.report.linear) >= 0 ? 'var(--up)' : 'var(--down)'}">${(imp(last.report.forest) >= 0 ? '+' : '') + imp(last.report.forest).toFixed(3)}</b><small>forest R² points · linear ${(imp(last.report.linear) >= 0 ? '+' : '') + imp(last.report.linear).toFixed(3)}</small></div>`;
  mini.evoChart($('evoChart'), {
    labels: gens.map((g) => 'G' + g.gen),
    series: [
      { name: 'Linear Brain', color: EXCOL.linear, values: gens.map((g) => g.report.linear.winner) },
      { name: 'Boosted Forest', color: EXCOL.forest, values: gens.map((g) => g.report.forest.winner) },
      { name: 'Generation-0 settings', color: '#6c7a96', values: gens.map((g) => (g.report.linear.gen0 + g.report.forest.gen0) / 2) },
    ],
  });
  $('evoLegend').innerHTML = `<span><i style="background:${EXCOL.linear}"></i>Linear Brain</span><span><i style="background:${EXCOL.forest}"></i>Boosted Forest</span><span><i style="background:#6c7a96"></i>Gen-0 settings (avg)</span><span>score = out-of-sample R² (%) on the last 5 days</span>`;
  $('evoLog').innerHTML = [...gens].reverse().slice(0, 30).map((g) => {
    const r = g.report;
    const part = (name, x, kind) => `${name}: ${x.promoted ? `<span class="pr">new champion</span> ${x.champion.toFixed(3)} → ${x.winner.toFixed(3)}` : `champion kept at ${x.winner.toFixed(3)}${x.challenger !== null ? ` (best challenger ${x.challenger.toFixed(3)})` : ''}`} <span style="color:var(--text-3)">· ${describeCfg(kind, g.cfg[kind])}</span>`;
    return `<li><span class="g">Gen ${g.gen}</span><span>${F.dateShort(Date.parse(g.at))} · ${r.linear.candidates + r.forest.candidates} candidates tested<br>${part('Linear', r.linear, 'linear')}<br>${part('Forest', r.forest, 'forest')}</span></li>`;
  }).join('');
}

function nextEvolution() {
  const n = new Date();
  const ms = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1, 0, 5) - n.getTime();
  return `in ${Math.floor(ms / 3600e3)}h ${Math.floor((ms % 3600e3) / 60e3)}m`;
}

function renderLearning() {
  const h = app.learnH;
  const bt = app.backtest?.days || {};
  const live = {};
  for (const m of Object.values(app.months)) Object.assign(live, m.days || {});
  const days = [...new Set([...Object.keys(bt), ...Object.keys(live)])].sort();
  if (!days.length) { mini.empty($('learnChart'), 'No scored days yet'); mini.empty($('covChart'), ''); return; }
  const acc = (a) => (a && a.nm ? a.hit / a.nm : null);
  const labels = days.map((d) => d.slice(5));
  mini.lineChart($('learnChart'), {
    labels,
    series: [
      { name: 'backtest', color: HCOL[h], values: days.map((d) => (live[d] ? null : acc(bt[d]?.[h]))), dash: '3 4', opacity: 0.6 },
      { name: 'live', color: HCOL[h], values: days.map((d) => acc(live[d]?.[h])), width: 2.5 },
    ],
    ref: { y: 0.5, label: 'coin flip' },
    yFmt: (v) => Math.round(v * 100) + '%',
  });
  const cov = (a) => (a && a.n ? a.c[1] / a.n : null);
  mini.lineChart($('covChart'), {
    labels,
    series: [
      { name: 'backtest', color: HCOL[h], values: days.map((d) => (live[d] ? null : cov(bt[d]?.[h]))), dash: '3 4', opacity: 0.6 },
      { name: 'live', color: HCOL[h], values: days.map((d) => cov(live[d]?.[h])), width: 2.5 },
    ],
    yMin: 0.7, yMax: 0.9,
    ref: { y: 0.8, label: 'target 80%' },
    yFmt: (v) => Math.round(v * 100) + '%',
  });
}

function renderCalibration() {
  const lc = lastClosedMinute();
  const edges = [0, 0.47, 0.49, 0.51, 0.53, 1];
  const bins = [];
  for (const h of HORIZONS) {
    const acc = edges.slice(1).map(() => ({ sp: 0, up: 0, n: 0 }));
    for (let t = lc - 48 * 60 * MINUTE; t <= lc; t += MINUTE) {
      const o = outcome(t, h);
      if (!o || o.hit === null) continue;
      let k = 0;
      while (k < edges.length - 2 && o.p >= edges[k + 1]) k++;
      acc[k].sp += o.p; acc[k].up += o.y > 0 ? 1 : 0; acc[k].n++;
    }
    for (const b of acc) if (b.n >= 60) bins.push({ p: b.sp / b.n, f: b.up / b.n, n: b.n, color: HCOL[h], label: `${F.horizonLabel(h)}: said ${(b.sp / b.n * 100).toFixed(1)}% up → was up ${(b.up / b.n * 100).toFixed(1)}% of ${b.n}` });
  }
  if (!bins.length) { mini.empty($('calChart'), 'Needs a few hours of scored forecasts'); $('calLegend').innerHTML = ''; }
  else {
    mini.reliability($('calChart'), { bins, lo: 0.4, hi: 0.6 });
    $('calLegend').innerHTML = HORIZONS.map((h) => `<span><i style="background:${HCOL[h]}"></i>${F.horizonLabel(h)}</span>`).join('') + '<span>last 48h · bubble size = number of forecasts · bars = ±1σ</span>';
  }
  const st = app.engine?.s || app.state;
  if (!st) return;
  $('calibParams').innerHTML = HORIZONS.map((h) => {
    const m80 = Math.exp(st.aci[h][1]);
    return `<div>${F.horizonLabel(h)} self-correction<b>bands ×${m80.toFixed(2)}</b><b>P(up) slope ${st.platt[h].a.toFixed(2)}</b></div>`;
  }).join('');
}

function renderModelCard() {
  const m = app.model, s = app.status;
  if (!m || !s) return;
  const c = m.configs;
  const cells = [
    ['Model', `generation ${m.generation} · ${m.id}`],
    ['Trained', `${new Date(m.trainedAt).toUTCString().replace(' GMT', ' UTC')}`],
    ['Signals', `${FEATURES.length} features from ADA + BTC 1-minute candles`],
    ['Linear Brain', describeCfg('linear', c.linear) + ` · groups: ${c.linear.groups.join(', ')}`],
    ['Boosted Forest', describeCfg('forest', c.forest) + ` · subsample ${c.forest.subsample}`],
    ['Specialists', Object.entries(c.specialists.lambda).map(([k, v]) => `${k} λ=${Number(v).toExponential(0)}`).join(' · ')],
    ['Last pipeline run', `${F.ago(Date.parse(s.updatedAt))} · run #${s.run.runs} · ${s.run.replayed} min replayed · ${(s.run.durationMs / 1000).toFixed(0)}s`],
    ['Checkpoint', `${new Date(s.t + MINUTE).toISOString().slice(0, 16).replace('T', ' ')} UTC`],
  ];
  $('modelCard').innerHTML = cells.map(([k, v]) => `<div>${k}<b>${F.esc(v)}</b></div>`).join('');
}

function renderHowDiagram() {
  $('howDiagram').innerHTML = `<svg viewBox="0 0 980 230" xmlns="http://www.w3.org/2000/svg" font-family="Inter, sans-serif">
    <defs>
      <marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#5b8cff"/></marker>
      <linearGradient id="hg" x1="0" x2="1"><stop offset="0" stop-color="#5b8cff" stop-opacity=".25"/><stop offset="1" stop-color="#2ee6c5" stop-opacity=".18"/></linearGradient>
    </defs>
    <g font-size="13" fill="#e8eefb">
      <rect x="10" y="80" width="150" height="70" rx="14" fill="rgba(255,179,71,.08)" stroke="rgba(255,179,71,.5)"/>
      <text x="85" y="110" text-anchor="middle" font-weight="600">Binance</text><text x="85" y="130" text-anchor="middle" fill="#a3b1cc" font-size="11.5">public market data</text>
      <rect x="220" y="60" width="230" height="110" rx="14" fill="url(#hg)" stroke="rgba(91,140,255,.55)"/>
      <text x="335" y="88" text-anchor="middle" font-weight="600">GitHub Actions</text>
      <text x="335" y="110" text-anchor="middle" fill="#a3b1cc" font-size="11.5">every 15 min: replay · score · learn</text>
      <text x="335" y="128" text-anchor="middle" fill="#a3b1cc" font-size="11.5">daily 00:00 UTC: evolve · retrain</text>
      <text x="335" y="152" text-anchor="middle" fill="#2ee6c5" font-size="11" font-family="JetBrains Mono">node engine/run.mjs</text>
      <rect x="510" y="80" width="170" height="70" rx="14" fill="rgba(148,170,220,.06)" stroke="rgba(148,170,220,.35)"/>
      <text x="595" y="110" text-anchor="middle" font-weight="600">git commit</text><text x="595" y="130" text-anchor="middle" fill="#a3b1cc" font-size="11.5">public, timestamped record</text>
      <rect x="740" y="80" width="230" height="70" rx="14" fill="rgba(34,227,154,.07)" stroke="rgba(34,227,154,.5)"/>
      <text x="855" y="108" text-anchor="middle" font-weight="600">GitHub Pages → your browser</text><text x="855" y="128" text-anchor="middle" fill="#a3b1cc" font-size="11.5">same engine, live every minute</text>
    </g>
    <g stroke="#5b8cff" stroke-width="1.6" fill="none" marker-end="url(#ah)">
      <path d="M160 115 H214"/><path d="M450 115 H504"/><path d="M680 115 H734"/>
      <path d="M85 150 V200 H855 V156" stroke-dasharray="5 5" stroke="#ffb347"/>
      <path d="M300 60 C300 20, 370 20, 370 56" stroke="#2ee6c5"/>
    </g>
    <text x="470" y="218" text-anchor="middle" fill="#ffb347" font-size="11.5">live WebSocket stream, straight to your browser</text>
    <text x="335" y="18" text-anchor="middle" fill="#2ee6c5" font-size="11.5">self-improvement loop</text>
  </svg>`;
}

function renderStatic() {
  const s = app.status;
  if (!s) return;
  $('genBadge').textContent = `Gen ${s.model.generation} · ${F.ago(Date.parse(s.model.trainedAt))}`;
  $('liveSince').textContent = s.liveSince ? F.dateShort(Date.parse(s.liveSince)) : '—';
  const scored = HORIZONS.reduce((a, h) => a + (s.totals?.all?.[h]?.n || 0), 0);
  $('madeCount').textContent = F.num(scored);
  $('lastUpdate').textContent = `record updated ${F.ago(Date.parse(s.updatedAt))}`;
  const stale = Date.now() - Date.parse(s.updatedAt) > 75 * 60e3;
  const banner = $('banner');
  if (!app.marketOk) {
    banner.hidden = false;
    banner.textContent = 'The live Binance feed is not reachable from your network, so this page is showing the last published record (updated every 15 minutes).';
  } else if (stale) {
    banner.hidden = false;
    banner.textContent = `The public record was last updated ${F.ago(Date.parse(s.updatedAt))} (GitHub's scheduler can run late). Your browser is still forecasting live from the last checkpoint.`;
  } else banner.hidden = true;
  renderEvolution();
  renderModelCard();
  renderLearning();
}

function renderMinute() {
  trim();
  renderCards();
  renderChart();
  renderScoreboard();
  renderFeed();
  renderCouncil();
  renderCalibration();
}

function tick() {
  const tNow = now();
  const next = Math.ceil(tNow / MINUTE) * MINUTE;
  $('nextTick').textContent = F.countdown(next - tNow);
  renderCards();
  renderChart();
}

// ---------------------------------------------------------------- UI wiring

function setSeg(id, attr, val) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === String(val));
}

function wire() {
  const gh = `https://github.com/${repo}`;
  $('ghLink').href = gh;
  $('repoLink').href = gh;
  $('dataLink').href = `${gh}/tree/main/data`;
  $('csvLink').href = `${gh}/tree/main/data/predictions`;
  $('actionsLink').href = `${gh}/actions`;
  const selectH = (h) => {
    app.selH = h;
    setSeg('hSeg', 'h', h);
    $('headH').textContent = h >= 60 ? 'an hour' : `${h} minutes`;
    $('corrH').textContent = h >= 60 ? '1 hour' : `${h} minutes`;
    renderCards();
    renderChart();
  };
  $('hSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) selectH(Number(b.dataset.h)); });
  $('forecastCards').addEventListener('click', (e) => { const c = e.target.closest('.fc'); if (c?.dataset.h) selectH(Number(c.dataset.h)); });
  $('rSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.range = Number(b.dataset.r); setSeg('rSeg', 'r', app.range); renderChart(); });
  $('cSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.councilH = Number(b.dataset.h); setSeg('cSeg', 'h', app.councilH); renderCouncil(); });
  $('lSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; app.learnH = Number(b.dataset.h); setSeg('lSeg', 'h', app.learnH); renderLearning(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { catchUp(); pollStatus(); } });
  chart = new ForecastChart($('chart'), { tip: $('tip'), dot: $('nowDot'), strip: $('strip') });
  renderHowDiagram();
}

async function boot() {
  wire();
  try {
    await loadPublished();
  } catch (e) {
    $('chartLoading').textContent = 'Could not load the published model. Please retry in a minute.';
    console.error(e);
    return;
  }
  renderStatic();
  try {
    clockOffset = await serverClockOffset().catch(() => 0);
    const lc = lastClosedMinute();
    const from = Math.max(Math.min(lc - 1500 * MINUTE, app.state.t - (WARMUP + 10) * MINUTE), lc - 2900 * MINUTE);
    await loadCandles(from);
    rebuildEngine();
    startStream();
  } catch (e) {
    console.warn('live market data unavailable', e);
    app.marketOk = false;
    const last = [...app.csvClose.entries()].at(-1);
    if (last) app.price = last[1];
    $('livePill').classList.add('warn');
    $('liveText').textContent = 'offline';
  }
  renderStatic();
  renderPrice();
  renderMinute();
  setInterval(tick, 1000);
  setInterval(pollStatus, 60_000);
  setInterval(() => { renderStatic(); }, 60_000);
}

boot();
