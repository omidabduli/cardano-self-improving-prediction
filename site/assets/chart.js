// One SVG chart, two lines: the price as it happened, and the prediction. On the left, each
// point of the prediction line is what the 1-hour forecast made an hour earlier said the price
// would be at that moment, so the two lines can be compared directly. On the right, the line
// starts at the price now and runs through the latest 1 h, 3 h and 24 h predictions. Before the live record began, the line
// shows the backtest's forecasts for those hours, dashed. Colours come from the CSS tokens, so
// light and dark themes need no code.

import { hhmm } from './format.js';

const NS = 'http://www.w3.org/2000/svg';
const H_MS = 3600e3;

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * @param {SVGSVGElement} svg
 * @param {{now:number, price:number, series:{t:number,c:number}[], pred:{t:number,c:number}[],
 *          past?:{t:number,c:number}[], marks:{h:number,t:number,c:number}[]}} d  prices in USD, times in ms
 */
export function drawChart(svg, d) {
  const W = svg.clientWidth || 800, Hh = svg.clientHeight || 360;
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.replaceChildren();
  if (!d.series.length || !Number.isFinite(d.price)) return;

  const narrow = W < 560;
  const padL = 8, padR = narrow ? 52 : 64, padT = 20, padB = 28;
  const ahead = Math.max(3 * H_MS, ...d.marks.map((m) => m.t - d.now));
  const t0 = d.now - 24 * H_MS, t1 = d.now + ahead;
  let lo = Infinity, hi = -Infinity;
  const past = d.past || [];
  for (const p of [...d.series, ...d.pred, ...past, ...d.marks]) { if (p.t < t0) continue; if (p.c < lo) lo = p.c; if (p.c > hi) hi = p.c; }
  const pad = (hi - lo) * 0.1 || d.price * 0.002;
  lo -= pad; hi += pad;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (c) => padT + (1 - (c - lo) / (hi - lo)) * (Hh - padT - padB);
  const pts = (list) => list.map((p) => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');

  // grid: 4-5 price levels, 6-hour time ticks
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, svg);
    el('text', { x: W - padR + 8, y: y(v) + 4 }, svg).textContent = '$' + v.toLocaleString('en-US', { maximumFractionDigits: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) });
  }
  const tick = 6 * H_MS;
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    if (narrow && Math.round(t / tick) % 2) continue;
    el('text', { x: x(t), y: Hh - 8, 'text-anchor': 'middle' }, svg).textContent = hhmm(t);
  }
  el('line', { class: 'now-line', x1: x(d.now), x2: x(d.now), y1: padT, y2: Hh - padB }, svg);
  el('text', { class: 'lbl', x: x(d.now), y: padT - 6, 'text-anchor': 'middle' }, svg).textContent = 'now';

  // prediction: one line, past and future; the backtest part (before the live record) dashed,
  // joined to the first live point so it reads as one line
  const pred = d.pred.filter((p) => p.t >= t0 && p.t <= t1);
  const bt = past.filter((p) => p.t >= t0 && (!pred.length || p.t < pred[0].t));
  if (bt.length) el('polyline', { class: 'pred pred-bt', points: pts(pred.length ? bt.concat(pred[0]) : bt) }, svg);
  if (pred.length > 1) el('polyline', { class: 'pred', points: pts(pred) }, svg);

  // price as it happened
  const series = d.series.filter((p) => p.t >= t0).concat({ t: d.now, c: d.price });
  el('polyline', { class: 'price', points: pts(series) }, svg);

  // ahead: one line from the price now through the open predictions
  const open = [...d.marks].sort((a, b) => a.t - b.t).filter((m) => m.t > d.now);
  if (open.length) el('polyline', { class: 'pred pred-ahead', points: pts([{ t: d.now, c: d.price }, ...open]) }, svg);
  el('circle', { class: 'now-dot', cx: x(d.now), cy: y(d.price), r: 3.5 }, svg);

  // the open forecasts: a dot and a label at 1 h, 3 h and 24 h
  for (const m of d.marks) {
    if (m.t <= d.now) continue;
    const mx = x(m.t), my = y(m.c);
    el('circle', { class: 'dot', cx: mx, cy: my, r: 3.5 }, svg);
    // 1 h and 3 h sit close together: one label below its dot, the other above
    const below = m.h === 60;
    el('text', { class: 'lbl', x: mx, y: below ? my + 20 : my - 10, 'text-anchor': m.t >= t1 - H_MS ? 'end' : 'middle' }, svg).textContent = m.h >= 1440 ? '24 h' : `${m.h / 60} h`;
  }
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
