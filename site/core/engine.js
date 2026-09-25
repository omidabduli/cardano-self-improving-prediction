// The online learner. It is stepped once per closed minute, in the backend (official record)
// and in every visitor's browser (live view), starting from the same published checkpoint.
// It issues a forecast every CADENCE minutes and learns whenever one of them matures:
//   1. Hedge: each expert's trust weight = exp(-eta * its discounted recent squared error).
//   2. Adaptive conformal inference: each prediction band widens after misses and narrows
//      after hits until its hit-rate matches the promised coverage (50/80/95 %).
//   3. Online logistic calibration: maps the ensemble signal to an honest P(up)
//      (a learned slope only; no up/down bias, so calls never just follow recent drift).

import { HORIZONS, BANDS, BAND_Q, Q_LEVELS, Z_CLIP, ONLINE, STRONG_EDGE, isIssue } from './config.js';

const LN2 = Math.LN2;
const decay = (halfLife) => Math.exp(-LN2 / halfLife);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function freshState(expertIds, t) {
  const s = { v: 1, t, experts: [...expertIds], hedge: {}, aci: {}, platt: {}, pending: [] };
  for (const h of HORIZONS) {
    s.hedge[h] = { L: expertIds.map(() => 0), L0: 0 };
    s.aci[h] = BANDS.map(() => 0);
    s.platt[h] = { a: 1.6, b: 0, H: plattPrior() };
  }
  return s;
}

function plattPrior() {
  // [Haa, Hab, Hbb]: prior information for slope a (on a signal of scale ~0.05) and bias b
  const n = ONLINE.plattPrior * 0.25;
  return [n * 0.05 * 0.05, 0, n];
}

// Pending predictions are stored compactly: [t, h, c, vol, mu, p, lo50, hi50, lo80, hi80, lo95, hi95, ...expertMus]
const P_T = 0, P_H = 1, P_C = 2, P_VOL = 3, P_MU = 4, P_P = 5, P_B = 6, P_E = 12;

export class Engine {
  /**
   * @param {object} model published model (experts, resid quantiles)
   * @param {object} state checkpoint (see freshState); it is deep-copied
   */
  constructor(model, state) {
    this.model = model;
    this.s = structuredClone(state);
    this.ids = model.experts.map((e) => e.id);
    this._syncExperts();
    this.dH = decay(ONLINE.hedgeHalfLifeMin);
    this.dP = decay(ONLINE.plattHalfLifeMin);
  }

  // If the expert line-up changed between model versions, carry learning over by id.
  _syncExperts() {
    const old = this.s.experts;
    if (old.length === this.ids.length && old.every((id, k) => id === this.ids[k])) return;
    for (const h of HORIZONS) {
      const hs = this.s.hedge[h];
      const med = hs.L.length ? [...hs.L].sort((a, b) => a - b)[hs.L.length >> 1] : 0;
      hs.L = this.ids.map((id) => { const k = old.indexOf(id); return k >= 0 ? hs.L[k] : med; });
    }
    this.s.experts = [...this.ids];
    this.s.pending = []; // stored expert predictions no longer line up
  }

  weights(h) {
    const L = this.s.hedge[h].L;
    const eta = ONLINE.hedgeEta * Math.min(1, ONLINE.hedgeRefH / h);
    let m = Infinity;
    for (const x of L) if (x < m) m = x;
    const w = L.map((x) => Math.exp(-eta * (x - m)));
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map((x) => x / sum);
  }

  // Discounted out-of-sample skill (R^2 vs. "no change") of each expert, in percent.
  skills(h) {
    const hs = this.s.hedge[h];
    return hs.L.map((l) => (hs.L0 > 0 ? (1 - l / hs.L0) * 100 : 0));
  }

  /**
   * Process one closed minute.
   * @param {number} t      minute open time (ms); must be exactly previous t + 60s
   * @param {number} close  close price of that minute
   * @param {number} vol    volatility estimate at t (features.vol)
   * @param {object|null} mus expert predictions per horizon (models.expertPredictions) or null;
   *                        only used on issue minutes (config.isIssue), so callers may skip it otherwise
   * @returns {{resolved: object[], pred: object|null}}
   */
  step(t, close, vol, mus) {
    const resolved = [];
    const keep = [];
    for (const p of this.s.pending) {
      if (p[P_T] + p[P_H] * 60000 > t) { keep.push(p); continue; }
      resolved.push(this._resolve(p, close));
    }
    this.s.pending = keep;
    let pred = null;
    if (mus && isIssue(t) && Number.isFinite(vol) && vol > 0) pred = this._predict(t, close, vol, mus);
    this.s.t = t;
    return { resolved, pred };
  }

  _resolve(p, close) {
    const h = p[P_H];
    const y = Math.log(close / p[P_C]);
    const z = y / (p[P_VOL] * Math.sqrt(h));
    const zc = clamp(z, -Z_CLIP, Z_CLIP);
    const mu = p[P_MU];

    // 1. Hedge: discounted squared error per expert
    const hs = this.s.hedge[h];
    for (let e = 0; e < hs.L.length; e++) {
      const err = zc - p[P_E + e];
      hs.L[e] = this.dH * hs.L[e] + Math.min(err * err, ONLINE.lossCap);
    }
    hs.L0 = this.dH * hs.L0 + Math.min(zc * zc, ONLINE.lossCap);

    // 2. Adaptive conformal inference on each band
    const inb = [];
    const aci = this.s.aci[h];
    const g = ONLINE.aciGamma[h];
    for (let k = 0; k < BANDS.length; k++) {
      const inside = y >= p[P_B + 2 * k] && y <= p[P_B + 2 * k + 1];
      inb.push(inside);
      aci[k] = clamp(aci[k] + g * ((inside ? 0 : 1) - (1 - BANDS[k])), ONLINE.aciMin, ONLINE.aciMax);
    }

    // 3. Online logistic calibration of P(up) (ties carry no direction information)
    let hit = null;
    if (y !== 0) {
      const u = y > 0 ? 1 : 0;
      hit = (y > 0) === (p[P_P] >= 0.5) ? 1 : 0;
      this._platt(h, mu, u);
    }

    return {
      t: p[P_T], h, c0: p[P_C], c1: close, y, z: zc, mu, ret: mu * p[P_VOL] * Math.sqrt(h), p: p[P_P], hit, inb,
      strong: Math.abs(p[P_P] - 0.5) >= STRONG_EDGE,
      mus: p.slice(P_E),
    };
  }

  // Online logistic calibration through the origin: P(up) = sigmoid(a * mu). Only the slope
  // is learned (discounted Newton steps). There is deliberately no bias term: a learned
  // up/down bias just chases recent drift and made every horizon worse in testing.
  _platt(h, x, u) {
    const pl = this.s.platt[h];
    const q = sigmoid(pl.a * x);
    const Haa = Math.max(this.dP * pl.H[0] + q * (1 - q) * x * x, plattPrior()[0]);
    pl.a = clamp(pl.a + ((u - q) * x) / Haa, 0, ONLINE.plattAMax);
    pl.b = 0;
    pl.H = [Haa, 0, pl.H[2]];
  }

  _predict(t, close, vol, mus) {
    const out = { t, c: close, vol, h: {} };
    for (const h of HORIZONS) {
      const m = mus[h];
      const w = this.weights(h);
      let mu = 0;
      for (let e = 0; e < m.length; e++) mu += w[e] * m[e];
      const p = sigmoid(this.s.platt[h].a * mu);
      const q = this.model.resid[h]; // quantiles of standardised residuals at Q_LEVELS
      const scale = vol * Math.sqrt(h);
      const lo = [], hi = [];
      for (let k = 0; k < BANDS.length; k++) {
        const mult = Math.exp(this.s.aci[h][k]);
        const [qi, qj] = BAND_Q[k];
        lo.push((mu + mult * q[qi]) * scale);
        hi.push((mu + mult * q[qj]) * scale);
      }
      const med = (mu + q[Q_LEVELS.indexOf(0.5)]) * scale;
      out.h[h] = { mu, ret: mu * scale, med, p, lo, hi, w, mus: m };
      this.s.pending.push([t, h, close, vol, mu, p, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], ...m]);
    }
    return out;
  }

  // Compact, JSON-safe checkpoint (rounded so the file stays small and diffs stay readable).
  snapshot() {
    const r = (x, d = 6) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : 0);
    const s = this.s;
    const o = { v: 1, t: s.t, experts: s.experts, hedge: {}, aci: {}, platt: {}, pending: [] };
    for (const h of HORIZONS) {
      o.hedge[h] = { L: s.hedge[h].L.map((x) => r(x, 8)), L0: r(s.hedge[h].L0, 8) };
      o.aci[h] = s.aci[h].map((x) => r(x, 6));
      o.platt[h] = { a: r(s.platt[h].a), b: 0, H: s.platt[h].H.map((x) => r(x)) };
    }
    o.pending = s.pending.map((p) => p.map((x, k) => (k < 2 ? x : k === P_C ? x : r(x, 7))));
    return o;
  }
}

export const PENDING_LAYOUT = { P_T, P_H, P_C, P_VOL, P_MU, P_P, P_B, P_E };
