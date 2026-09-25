// One SVG chart: the last 24 hours of price, the 80% range each 1-hour forecast gave for it,
// and the current 1 h / 3 h / 24 h forecasts fanning out to the right. Colours come from the
// CSS tokens, so light and dark themes need no code.

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
 *          fc:{h:number,t:number,med:number,lo:number,hi:number}[]}} d  prices in USD, times in ms
 */
export function drawChart(svg, d) {
  const W = svg.clientWidth || 800, Hh = svg.clientHeight || 360;
  svg.setAttribute('viewBox', `0 0 ${W} ${Hh}`);
  svg.replaceChildren();
  if (!d.series.length || !Number.isFinite(d.price)) return;

  const narrow = W < 560;
  const padL = 8, padR = narrow ? 52 : 64, padT = 16, padB = 28;
  const t0 = d.now - 24 * H_MS, t1 = d.now + 24 * H_MS;
  let lo = Infinity, hi = -Infinity;
  for (const p of d.series) { if (p.c < lo) lo = p.c; if (p.c > hi) hi = p.c; }
  for (const b of d.band) { if (b.lo < lo) lo = b.lo; if (b.hi > hi) hi = b.hi; }
  for (const f of d.fc) { if (f.lo < lo) lo = f.lo; if (f.hi > hi) hi = f.hi; }
  const pad = (hi - lo) * 0.08 || d.price * 0.01;
  lo -= pad; hi += pad;
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (c) => padT + (1 - (c - lo) / (hi - lo)) * (Hh - padT - padB);

  // grid: 4-5 price levels, 6-hour time ticks
  const step = niceStep((hi - lo) / 4);
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }, svg);
    el('text', { x: W - padR + 8, y: y(v) + 4 }, svg).textContent = '$' + v.toFixed(step < 0.001 ? 4 : 3);
  }
  const tick = 6 * H_MS;
  for (let t = Math.ceil(t0 / tick) * tick; t <= t1; t += tick) {
    if (narrow && Math.round(t / tick) % 2) continue;
    el('text', { x: x(t), y: Hh - 8, 'text-anchor': 'middle' }, svg).textContent = hhmm(t);
  }

  // band that the 1-hour forecasts gave for each past moment
  const band = d.band.filter((b) => b.t >= t0 && b.t <= d.now);
  if (band.length > 1) {
    const top = band.map((b) => `${x(b.t).toFixed(1)},${y(b.hi).toFixed(1)}`);
    const bot = band.slice().reverse().map((b) => `${x(b.t).toFixed(1)},${y(b.lo).toFixed(1)}`);
    el('polygon', { class: 'band', points: top.concat(bot).join(' ') }, svg);
  }

  // price
  const pts = d.series.filter((p) => p.t >= t0).map((p) => `${x(p.t).toFixed(1)},${y(p.c).toFixed(1)}`);
  pts.push(`${x(d.now).toFixed(1)},${y(d.price).toFixed(1)}`);
  el('polyline', { class: 'price', points: pts.join(' ') }, svg);
  el('line', { class: 'now-line', x1: x(d.now), x2: x(d.now), y1: padT, y2: Hh - padB }, svg);

  // forecast fan from the forecast's own start to each horizon
  const fc = d.fc.slice().sort((a, b) => a.h - b.h);
  if (fc.length) {
    const sx = x(d.now), sy = y(d.price);
    const upper = fc.map((f) => `${x(f.t).toFixed(1)},${y(f.hi).toFixed(1)}`);
    const lower = fc.slice().reverse().map((f) => `${x(f.t).toFixed(1)},${y(f.lo).toFixed(1)}`);
    el('polygon', { class: 'fan', points: [`${sx},${sy}`, ...upper, ...lower].join(' ') }, svg);
    el('polyline', { class: 'fan-med', points: [`${sx},${sy}`, ...fc.map((f) => `${x(f.t).toFixed(1)},${y(f.med).toFixed(1)}`)].join(' ') }, svg);
    for (const f of fc) {
      const fx = x(f.t);
      el('line', { class: 'bar', x1: fx, x2: fx, y1: y(f.lo), y2: y(f.hi) }, svg);
      el('circle', { class: 'dot', cx: fx, cy: y(f.med), r: 3.5 }, svg);
      const label = el('text', { class: 'lbl', x: fx, y: Math.max(12, y(f.hi) - 8), 'text-anchor': f.h >= 1440 ? 'end' : 'middle' }, svg);
      label.textContent = f.h >= 1440 ? '24 h' : `${f.h / 60} h`;
    }
  }
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
