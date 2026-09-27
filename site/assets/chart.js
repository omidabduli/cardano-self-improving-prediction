// One SVG chart: the price as it happened, and a shaded band for the 80% range of the 1-hour
// forecast. On the left, the band at each moment is where the forecast made an hour earlier
// expected the price to be (before the live record began, the backtest's forecasts fill it in).
// Arrows on the price line are the hourly 1-hour calls, drawn where they were made: a green ▲
// said up, a red ▼ said down; filled when it came true, hollow when it didn't. On the right, the
// band opens from the price now to the latest 1-hour and 3-hour ranges, and labels give the
// open 1-hour, 3-hour and 24-hour calls. Colours come from the CSS tokens, so light and dark
// themes need no code.

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
 * @param {{now:number, price:number, series:{t:number,c:number}[], band:{t:number,lo:number,hi:number}[],
 *          calls?:{t:number,c:number,up:boolean,right:boolean}[],
 *          marks:{h:number,t:number,lo:number,hi:number,label?:string}[]}} d
 *          (the 24-hour mark has no range drawn, so it can't squash the price)  prices in USD, times in ms
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
  const band = d.band.filter((b) => b.t >= t0 && b.t <= d.now);
  let lo = Infinity, hi = -Infinity;
  for (const p of d.series) { if (p.t < t0) continue; if (p.c < lo) lo = p.c; if (p.c > hi) hi = p.c; }
  for (const b of [...band, ...d.marks.filter((m) => m.h < 1440)]) { if (b.lo < lo) lo = b.lo; if (b.hi > hi) hi = b.hi; }
  const pad = (hi - lo) * 0.08 || d.price * 0.002;
  lo -= pad; hi += pad;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (c) => padT + (1 - (c - lo) / (hi - lo)) * (Hh - padT - padB);
  const pts = (list) => list.map((p) => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
  const area = (list) => pts([...list.map((b) => ({ t: b.t, c: b.hi })), ...list.slice().reverse().map((b) => ({ t: b.t, c: b.lo }))]);

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

  // the 80% range: past (what the forecast an hour earlier expected) and ahead (from now)
  if (band.length > 1) el('polygon', { class: 'band', points: area(band) }, svg);
  const open = [...d.marks].sort((a, b) => a.t - b.t).filter((m) => m.t > d.now);
  const cone = open.filter((m) => m.h < 1440);
  if (cone.length) el('polygon', { class: 'band band-ahead', points: area([{ t: d.now, lo: d.price, hi: d.price }, ...cone]) }, svg);

  // price as it happened
  const series = d.series.filter((p) => p.t >= t0).concat({ t: d.now, c: d.price });
  el('polyline', { class: 'price', points: pts(series) }, svg);

  // the hourly 1-hour calls, where they were made: green ▲ up, red ▼ down; filled = came true
  const s = narrow ? 4.5 : 5.5;
  const arrow = (cx, cy, up, right) => el('polygon', { class: `call ${up ? 'up' : 'down'}${right ? '' : ' wrong'}`, points: up
    ? `${cx},${cy - s} ${cx - s},${cy + s * 0.8} ${cx + s},${cy + s * 0.8}`
    : `${cx},${cy + s} ${cx - s},${cy - s * 0.8} ${cx + s},${cy - s * 0.8}` }, svg);
  for (const k of d.calls || []) if (k.t >= t0 && k.t <= d.now) arrow(x(k.t), y(k.c), k.up, k.right);
  el('circle', { class: 'now-dot', cx: x(d.now), cy: y(d.price), r: 3.5 }, svg);

  // the open calls: a label at 1 h, 3 h and 24 h; 1 h and 3 h sit close together, so one label
  // goes below its range and the other above
  for (const m of open) {
    const mx = x(m.t), my = y(d.price);
    const ly = m.h === 60 ? y(m.lo) + 16 : m.h === 180 ? y(m.hi) - 8 : my - 10;
    el('text', { class: 'lbl', x: mx, y: ly, 'text-anchor': m.t >= t1 - H_MS ? 'end' : 'middle' }, svg).textContent = m.label || `${m.h / 60} h`;
  }
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
