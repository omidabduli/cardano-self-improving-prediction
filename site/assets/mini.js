// Tiny dependency-free SVG charts. Each render function remembers its last arguments and
// re-renders itself when the container is resized.

import { esc } from './format.js';

const observers = new WeakMap();

function mount(el, render) {
  const draw = () => {
    const w = el.clientWidth, h = el.clientHeight;
    if (w > 0 && h > 0) el.innerHTML = render(w, h);
  };
  if (!observers.has(el)) {
    const ro = new ResizeObserver(() => observers.get(el)?.());
    ro.observe(el);
  }
  observers.set(el, draw);
  draw();
}

export function empty(el, msg) {
  observers.set(el, () => {});
  el.innerHTML = `<div class="empty">${esc(msg)}</div>`;
}

function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/**
 * Line chart over categorical x (e.g. days).
 * opts: { labels: string[], series: [{ name, color, values: (number|null)[], dash, width, dots }],
 *         yMin, yMax, ref: {y, label, color}, yFmt, band: {lo, hi, color} }
 */
export function lineChart(el, opts) {
  mount(el, (w, h) => {
    const P = { l: 40, r: 10, t: 10, b: 22 };
    const W = w - P.l - P.r, H = h - P.t - P.b;
    const n = opts.labels.length;
    const X = (i) => P.l + (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    let lo = opts.yMin, hi = opts.yMax;
    if (lo === undefined || hi === undefined) {
      const vals = opts.series.flatMap((s) => s.values).filter(Number.isFinite);
      if (opts.ref) vals.push(opts.ref.y);
      lo = lo ?? Math.min(...vals); hi = hi ?? Math.max(...vals);
      const pad = (hi - lo) * 0.12 || 0.01;
      lo -= pad; hi += pad;
    }
    const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * H;
    const fmt = opts.yFmt || ((v) => String(v));
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
    s += '<g class="axis">';
    for (const v of niceTicks(lo, hi, Math.max(2, Math.round(H / 40)))) {
      s += `<line x1="${P.l}" x2="${P.l + W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${esc(fmt(v))}</text>`;
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 64))));
    opts.labels.forEach((lb, i) => {
      if (i % every === 0 || i === n - 1) s += `<text x="${X(i)}" y="${h - 5}" text-anchor="middle">${esc(lb)}</text>`;
    });
    s += '</g>';
    if (opts.band) s += `<rect x="${P.l}" width="${W}" y="${Y(opts.band.hi)}" height="${Math.max(0, Y(opts.band.lo) - Y(opts.band.hi))}" fill="${opts.band.color}"/>`;
    if (opts.ref) {
      s += `<line x1="${P.l}" x2="${P.l + W}" y1="${Y(opts.ref.y)}" y2="${Y(opts.ref.y)}" stroke="${opts.ref.color || 'rgba(232,238,251,0.35)'}" stroke-dasharray="4 4"/>`;
      if (opts.ref.label) s += `<text x="${P.l + W}" y="${Y(opts.ref.y) - 5}" text-anchor="end" fill="rgba(232,238,251,0.5)" font-size="10.5" font-family="JetBrains Mono">${esc(opts.ref.label)}</text>`;
    }
    for (const se of opts.series) {
      let d = '', pen = false;
      se.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(Math.max(lo, Math.min(hi, v))).toFixed(1)}`;
        pen = true;
      });
      if (d) s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${se.dash ? `stroke-dasharray="${se.dash}"` : ''} opacity="${se.opacity ?? 1}"/>`;
      if (se.dots !== false) se.values.forEach((v, i) => {
        if (Number.isFinite(v)) s += `<circle cx="${X(i)}" cy="${Y(Math.max(lo, Math.min(hi, v)))}" r="${n > 40 ? 1.8 : 3}" fill="${se.color}" opacity="${se.opacity ?? 1}"><title>${esc(opts.labels[i])}: ${esc(fmt(v))}</title></circle>`;
      });
    }
    return s + '</svg>';
  });
}

/**
 * Stacked area of shares over time. opts: { labels, layers: [{ name, color, values }] }
 */
export function stackedArea(el, opts) {
  mount(el, (w, h) => {
    const P = { l: 34, r: 8, t: 6, b: 20 };
    const W = w - P.l - P.r, H = h - P.t - P.b;
    const n = opts.labels.length;
    const X = (i) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * W);
    const Y = (v) => P.t + (1 - v) * H;
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img"><g class="axis">`;
    for (const v of [0, 0.5, 1]) s += `<line x1="${P.l}" x2="${P.l + W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v * 100}%</text>`;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 70))));
    opts.labels.forEach((lb, i) => { if (i % every === 0 || i === n - 1) s += `<text x="${X(i)}" y="${h - 4}" text-anchor="middle">${esc(lb)}</text>`; });
    s += '</g>';
    const base = new Array(n).fill(0);
    for (const L of opts.layers) {
      const top = base.map((b, i) => b + (L.values[i] || 0));
      let d = `M${X(0)},${Y(top[0])}`;
      for (let i = 1; i < n; i++) d += `L${X(i)},${Y(top[i])}`;
      if (n === 1) d += `L${P.l + W},${Y(top[0])}L${P.l + W},${Y(base[0])}`;
      for (let i = n - 1; i >= 0; i--) d += `L${X(i)},${Y(base[i])}`;
      s += `<path d="${d}Z" fill="${L.color}" opacity="0.85"><title>${esc(L.name)}</title></path>`;
      for (let i = 0; i < n; i++) base[i] = top[i];
    }
    return s + '</svg>';
  });
}

/**
 * Reliability diagram. opts: { bins: [{ p, f, n }], lo, hi }
 */
export function reliability(el, opts) {
  mount(el, (w, h) => {
    const P = { l: 44, r: 12, t: 10, b: 30 };
    const W = w - P.l - P.r, H = h - P.t - P.b;
    const lo = opts.lo, hi = opts.hi;
    const X = (v) => P.l + ((v - lo) / (hi - lo)) * W;
    const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * H;
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img"><g class="axis">`;
    for (const v of niceTicks(lo, hi, 4)) {
      s += `<line x1="${P.l}" x2="${P.l + W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${Math.round(v * 100)}%</text>`;
      s += `<text x="${X(v)}" y="${P.t + H + 14}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
    }
    s += `<text x="${P.l + W / 2}" y="${h - 2}" text-anchor="middle">forecast P(up)</text>`;
    s += '</g>';
    s += `<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" stroke="rgba(232,238,251,0.35)" stroke-dasharray="4 4"/>`;
    const maxN = Math.max(1, ...opts.bins.map((b) => b.n));
    for (const b of opts.bins) {
      if (!b.n) continue;
      const r = 3 + 9 * Math.sqrt(b.n / maxN);
      const x = X(Math.max(lo, Math.min(hi, b.p))), y = Y(Math.max(lo, Math.min(hi, b.f)));
      // 1-sigma error bar
      const se = Math.sqrt(Math.max(b.f * (1 - b.f), 0.01) / b.n);
      const cl = (v) => Math.max(lo, Math.min(hi, v));
      s += `<line x1="${x}" x2="${x}" y1="${Y(cl(b.f + se))}" y2="${Y(cl(b.f - se))}" stroke="${b.color}" opacity="0.5"/>`;
      s += `<circle cx="${x}" cy="${y}" r="${r}" fill="${b.color}" fill-opacity="0.35" stroke="${b.color}"><title>${esc(b.label)}</title></circle>`;
    }
    return s + '</svg>';
  });
}

/** Bars + line for the evolution history. opts: { labels, bars: [{values, color, name}], line: {values, color} } */
export function evoChart(el, opts) {
  mount(el, (w, h) => {
    const P = { l: 44, r: 10, t: 10, b: 22 };
    const W = w - P.l - P.r, H = h - P.t - P.b;
    const n = opts.labels.length;
    const vals = opts.series.flatMap((s) => s.values).filter(Number.isFinite);
    let lo = Math.min(0, ...vals), hi = Math.max(0.05, ...vals);
    const pad = (hi - lo) * 0.15; hi += pad; lo -= lo < 0 ? pad : 0;
    const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * H;
    const bw = Math.min(26, (W / Math.max(1, n)) * 0.6);
    const X = (i) => P.l + (i + 0.5) * (W / Math.max(1, n));
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img"><g class="axis">`;
    for (const v of niceTicks(lo, hi, 3)) s += `<line x1="${P.l}" x2="${P.l + W}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${P.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v.toFixed(2)}</text>`;
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 50))));
    opts.labels.forEach((lb, i) => { if (i % every === 0 || i === n - 1) s += `<text x="${X(i)}" y="${h - 5}" text-anchor="middle">${esc(lb)}</text>`; });
    s += '</g>';
    const k = opts.series.length;
    opts.series.forEach((se, j) => {
      se.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return;
        const x = X(i) - bw / 2 + (j * bw) / k;
        const y0 = Y(0), y1 = Y(v);
        s += `<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw / k - 1}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="2" fill="${se.color}"><title>${esc(se.name)} · ${esc(opts.labels[i])}: ${v.toFixed(3)}</title></rect>`;
      });
    });
    return s + '</svg>';
  });
}
