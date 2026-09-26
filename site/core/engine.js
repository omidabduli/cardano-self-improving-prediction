// The online learner. It is stepped once per closed minute, in the backend (official record)
// and in every visitor's browser (live view), starting from the same published checkpoint.
// It issues a forecast every CADENCE minutes and learns whenever one of them matures:
//   1. Hedge: each expert's trust weight = exp(-eta * its discounted recent squared error).
//   2. Adaptive conformal inference: each prediction band widens after misses and narrows
//      after hits until its hit-rate matches the promised coverage (50/80/95 %).
//   3. Online logistic calibration: maps the direction signal to an honest P(up)
//      (a learned slope only; no up/down bias, so calls never just follow recent drift).
//      The direction signal is the direction model's score when the model has one
//      (models.directionScores), otherwise the ensemble's predicted move.
//   4. The shown price's shrinkage factor (forecast.js): least squares of the actual move on
//      the move implied by P(up), anchored at "no change".
//   5. The signal gate (ONLINE.gate): per horizon, the model's P(up) is shown only while its
//      recent log loss beats a coin flip; otherwise the forecast is "no clear direction" (50%),
//      while the model keeps being scored in the background so it can come back. Its counters
//      run for every horizon; SHADOW_HORIZONS always show 50% and are measured this way only.
// Every learner forgets by wall-clock time: it remembers (per horizon) the issue time of the
// last forecast it learned from, and discounts its memory by the time passed since.
// An outcome whose price was filled in (no real candle, candles.js) is "unavailable": nothing
// learns from it and it is not scored.

import { HORIZONS, BANDS, BAND_Q, Q_LEVELS, Z_CLIP, ONLINE, MINUTE, STRONG_WINDOW, STRONG_MIN, SHADOW_HORIZONS, SHOW_MOVE, isIssue } from './config.js';
import { FEATURE_SCHEMA } from './features.js';
import { shownForecast, impliedMove } from './forecast.js';

export const STATE_VERSION = 2;
// where a forecast came from: a simulation (backtest, warm-up), the pipeline shortly after the
// candle closed (live), the pipeline later (replay, backfilled), or a visitor's browser (preview)
export const ORIGIN = { sim: 0, live: 1, replay: 2, preview: 3 };
export const ORIGIN_NAME = ['sim', 'live', 'replay', 'preview'];

const LN2 = Math.LN2;
// Weight left after dt minutes with a half-life of hl minutes.
export const decayFor = (dtMin, hlMin) => Math.exp((-LN2 * dtMin) / hlMin);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function freshState(expertIds, t, on = ONLINE) {
  const s = { v: STATE_VERSION, t, experts: [...expertIds], hedge: {}, aci: {}, platt: {}, est: {}, sig: {}, gate: {}, pending: [] };
  for (const h of HORIZONS) {
    s.hedge[h] = { L: expertIds.map(() => 0), L0: 0, t: null };
    s.aci[h] = BANDS.map(() => 0);
    s.platt[h] = { a: 1.6, b: 0, H: plattPrior(on), t: null };
    s.est[h] = { sxy: 0, sxx: 0, t: null };
    s.sig[h] = [];
    s.gate[h] = { g: 0, n: 0, on: true, t: null };
  }
  return s;
}

function plattPrior(on) {
  // [Haa, Hab, Hbb]: prior information for slope a (on a signal of scale ~0.05) and bias b
  const n = on.plattPrior * 0.25;
  return [n * 0.05 * 0.05, 0, n];
}

// Pending predictions are stored compactly:
// [t, h, c, vol, mu, p (shown), lo50, hi50, lo80, hi80, lo95, hi95, dirSignal, strong, shownMove,
//  impliedMove (of the model's P(up)), origin, model P(up) (before the gate), ...expertMus]
const P_T = 0, P_H = 1, P_C = 2, P_VOL = 3, P_MU = 4, P_P = 5, P_B = 6, P_X = 12, P_S = 13, P_EST = 14, P_IM = 15, P_O = 16, P_PM = 17, P_E = 18;
// direction scores are in "typical signal" units (~1); the calibration works on the scale of
// the ensemble's predicted move (~0.05)
const DIR_SCALE = 0.05;

export class Engine {
  /**
   * @param {object} model published model (experts, resid quantiles, direction model)
   * @param {object} state checkpoint (see freshState); it is deep-copied
   * @param {object} [opt] research variants only (research/stage2.mjs); production uses the defaults:
   *   online: overrides for ONLINE · legacyDecay: v3's once-per-outcome forgetting ·
   *   intercept: learn an up/down bias in the calibration · strong: 'recent' (default) or 'thr'
   *   (v3: the model's training-window median) · shrink: false = show the implied move unshrunk (v3) ·
   *   learn: false = no online learning at all (every learner stays at its starting state) ·
   *   gate: true/false overrides ONLINE.gate · shadow: overrides SHADOW_HORIZONS ·
   *   showMove: overrides SHOW_MOVE
   */
  constructor(model, state, opt = {}) {
    if (!state || state.v !== STATE_VERSION) throw new Error(`checkpoint version ${state && state.v} is not ${STATE_VERSION}: it was written by another version of the code`);
    if (model.featureSchema !== undefined && model.featureSchema !== FEATURE_SCHEMA) throw new Error(`model uses feature schema ${model.featureSchema}, this code computes ${FEATURE_SCHEMA}`);
    this.model = model;
    this.s = structuredClone(state);
    this.ids = model.experts.map((e) => e.id);
    this.opt = opt;
    this.on = { ...ONLINE, ...(opt.online || {}) };
    if (opt.gate !== undefined) this.on.gate = opt.gate;
    this._syncExperts();
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

  // Decay for a learner last updated at issue time `last`, now learning from one issued at t.
  _decay(last, t, hlMin) {
    if (this.opt.legacyDecay) return decayFor(1, hlMin);
    return last === null ? 1 : decayFor((t - last) / MINUTE, hlMin);
  }

  weights(h) {
    const L = this.s.hedge[h].L;
    const eta = this.on.hedgeEta * Math.min(1, this.on.hedgeRefH / h);
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

  // The shown price's shrinkage factor for horizon h, in [0, 1].
  beta(h) {
    if (this.opt.shrink === false) return 1;
    const e = this.s.est[h];
    return clamp(e.sxy / (e.sxx + this.on.estPrior), 0, 1);
  }

  /**
   * Process one closed minute.
   * @param {number} t      minute open time (ms), later than the previous step's
   * @param {number} close  close price of that minute
   * @param {number} vol    volatility estimate at t (features.vol)
   * @param {object|null} mus expert predictions per horizon (models.expertPredictions) or null;
   *                        only used on issue minutes (config.isIssue), so callers may skip it otherwise
   * @param {object|null} dir direction scores per horizon (models.directionScores) or null
   * @param {{real?: boolean, origin?: number}} [o] real: the coin had a real candle at t (else
   *                        forecasts maturing now are unavailable); origin: ORIGIN of a new forecast
   * @returns {{resolved: object[], pred: object|null}}
   */
  step(t, close, vol, mus, dir = null, { real = true, origin = ORIGIN.sim } = {}) {
    const resolved = [];
    const keep = [];
    for (const p of this.s.pending) {
      const due = p[P_T] + p[P_H] * 60000;
      if (due > t) { keep.push(p); continue; }
      // only the maturity minute itself is the outcome; a skipped one is unavailable
      resolved.push(this._resolve(p, close, real && due === t));
    }
    this.s.pending = keep;
    let pred = null;
    if (mus && isIssue(t) && Number.isFinite(vol) && vol > 0) pred = this._predict(t, close, vol, mus, dir, origin);
    this.s.t = t;
    return { resolved, pred };
  }

  _resolve(p, close, real) {
    const h = p[P_H], t = p[P_T];
    const base = { t, h, c0: p[P_C], origin: p[P_O], p: p[P_P], pModel: p[P_PM], strong: p[P_S] === 1, est: p[P_EST] };
    if (!real) return { ...base, unavailable: true };
    const y = Math.log(close / p[P_C]);
    const z = y / (p[P_VOL] * Math.sqrt(h));
    const zc = clamp(z, -Z_CLIP, Z_CLIP);
    const mu = p[P_MU];
    const on = this.on;
    const out = {
      ...base, c1: close, y, z: zc, mu, ret: mu * p[P_VOL] * Math.sqrt(h), implied: p[P_IM],
      inb: [0, 1, 2].map((k) => y >= p[P_B + 2 * k] && y <= p[P_B + 2 * k + 1]),
      lo: [p[P_B], p[P_B + 2], p[P_B + 4]], hi: [p[P_B + 1], p[P_B + 3], p[P_B + 5]],
      mus: p.slice(P_E),
    };
    if (this.opt.learn === false) return out;

    // 1. Hedge: discounted squared error per expert (a repeated or out-of-order outcome is ignored)
    const hs = this.s.hedge[h];
    if (hs.t === null || t > hs.t || this.opt.legacyDecay) {
      const d = this._decay(hs.t, t, on.hedgeHalfLifeMin);
      for (let e = 0; e < hs.L.length; e++) {
        const err = zc - p[P_E + e];
        hs.L[e] = d * hs.L[e] + Math.min(err * err, on.lossCap);
      }
      hs.L0 = d * hs.L0 + Math.min(zc * zc, on.lossCap);
      hs.t = t;
    }

    // 2. Adaptive conformal inference on each band
    const aci = this.s.aci[h];
    const g = on.aciGamma[h];
    for (let k = 0; k < BANDS.length; k++) aci[k] = clamp(aci[k] + g * ((out.inb[k] ? 0 : 1) - (1 - BANDS[k])), on.aciMin, on.aciMax);

    // 3. Online logistic calibration of P(up) (ties carry no direction information)
    if (y !== 0) this._platt(h, t, p[P_X], y > 0 ? 1 : 0);

    // 5. The signal gate: the model's own P(up) against a coin, decayed by wall-clock time
    const gt = this.s.gate[h];
    if (y !== 0 && (gt.t === null || t > gt.t || this.opt.legacyDecay)) {
      const pm = Math.min(Math.max(p[P_PM], 1e-6), 1 - 1e-6);
      const gain = LN2 + (y > 0 ? Math.log(pm) : Math.log(1 - pm));
      const d = this._decay(gt.t, t, on.gateHalfLifeMin);
      gt.g = d * gt.g + gain;
      gt.n = d * gt.n + 1;
      gt.t = t;
      if (gt.n >= on.gateMinN) {
        const mean = gt.g / gt.n;
        if (gt.on && mean <= -on.gateDelta) gt.on = false;
        else if (!gt.on && mean >= on.gateDelta) gt.on = true;
      }
    }

    // 4. The shown price's shrinkage: z on the implied move, both in volatility units
    const es = this.s.est[h];
    if (es.t === null || t > es.t || this.opt.legacyDecay) {
      const x = p[P_IM] / (p[P_VOL] * Math.sqrt(h));
      const d = this._decay(es.t, t, on.estHalfLifeMin);
      es.sxy = d * es.sxy + x * zc;
      es.sxx = d * es.sxx + x * x;
      es.t = t;
    }
    return out;
  }

  // Online logistic calibration: P(up) = sigmoid(a * x) (+ b with the research option
  // `intercept`). Discounted Newton steps anchored by a prior. There is deliberately no bias
  // term in production: a learned up/down bias just chases recent drift.
  _platt(h, t, x, u) {
    const pl = this.s.platt[h];
    const d = this._decay(pl.t, t, this.on.plattHalfLifeMin);
    const pr = plattPrior(this.on);
    const b = this.opt.intercept ? pl.b : 0;
    const q = sigmoid(pl.a * x + b);
    const w = q * (1 - q);
    const Haa = Math.max(d * pl.H[0] + w * x * x, pr[0]);
    if (this.opt.intercept) {
      const Hab = d * pl.H[1] + w * x;
      const Hbb = Math.max(d * pl.H[2] + w, pr[2] * 0.02);
      const det = Haa * Hbb - Hab * Hab;
      const ga = (u - q) * x, gb = u - q;
      pl.a = clamp(pl.a + (Hbb * ga - Hab * gb) / det, 0, this.on.plattAMax);
      pl.b = clamp(pl.b + (Haa * gb - Hab * ga) / det, -0.2, 0.2);
      pl.H = [Haa, Hab, Hbb];
    } else {
      pl.a = clamp(pl.a + ((u - q) * x) / Haa, 0, this.on.plattAMax);
      pl.b = 0;
      pl.H = [Haa, 0, pl.H[2]];
    }
    pl.t = t;
  }

  // Is this call's signal among the stronger half of the last STRONG_WINDOW forecasts? Every
  // forecast's signal joins the recent spread, calls or not.
  _strong(h, ax, isCall, thr) {
    if (this.opt.strong === 'thr') return isCall && thr !== undefined && ax >= thr * DIR_SCALE;
    const sig = this.s.sig[h];
    let strong = false;
    if (isCall && sig.length >= STRONG_MIN) {
      const v = [...sig].sort((a, b) => a - b);
      strong = ax >= v[v.length >> 1];
    }
    sig.push(ax);
    if (sig.length > STRONG_WINDOW) sig.splice(0, sig.length - STRONG_WINDOW);
    return strong;
  }

  _predict(t, close, vol, mus, dir, origin) {
    const out = { t, c: close, vol, h: {} };
    for (const h of HORIZONS) {
      const m = mus[h];
      const w = this.weights(h);
      let mu = 0;
      for (let e = 0; e < m.length; e++) mu += w[e] * m[e];
      const x = dir ? dir[h].d * DIR_SCALE : mu;
      const pl = this.s.platt[h];
      const pm = sigmoid(pl.a * x + (this.opt.intercept ? pl.b : 0)); // the model's P(up)
      const shadow = (this.opt.shadow ?? SHADOW_HORIZONS).includes(h);
      const p = shadow || (this.on.gate && !this.s.gate[h].on) ? 0.5 : pm; // shown and scored
      const q = this.model.resid[h]; // quantiles of standardised returns at Q_LEVELS
      const scale = vol * Math.sqrt(h);
      const lo = [], hi = [];
      for (let k = 0; k < BANDS.length; k++) {
        const mult = Math.exp(this.s.aci[h][k]);
        const [qi, qj] = BAND_Q[k];
        lo.push((mu + mult * q[qi]) * scale);
        hi.push((mu + mult * q[qj]) * scale);
      }
      // each band's multiplier adapts on its own, so enforce nesting: 50% inside 80% inside 95%
      for (let k = 1; k < BANDS.length; k++) { lo[k] = Math.min(lo[k], lo[k - 1]); hi[k] = Math.max(hi[k], hi[k - 1]); }
      const med = (mu + q[Q_LEVELS.indexOf(0.5)]) * scale;
      const beta = this.beta(h);
      const f = shownForecast(close, p, lo[1], hi[1], beta, this.opt.showMove ?? SHOW_MOVE);
      const implied = impliedMove(pm, lo[1], hi[1]); // the shrinkage keeps learning while gated
      const strong = this._strong(h, Math.abs(x), f.direction !== 'neutral', dir && dir[h].thr);
      out.h[h] = { mu, ret: mu * scale, med, p, pModel: pm, gated: p !== pm, shadow, direction: f.direction, strong, lo, hi, est: f.move, price: f.price, shrunk: f.shrunk, implied, beta, w, mus: m };
      this.s.pending.push([t, h, close, vol, mu, p, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], x, strong ? 1 : 0, f.move, implied, origin, pm, ...m]);
    }
    return out;
  }

  // Compact, JSON-safe checkpoint (rounded so the file stays small and diffs stay readable).
  // A non-finite number means something broke: fail loudly instead of publishing a zero.
  snapshot() {
    const r = (x, d = 6) => {
      if (!Number.isFinite(x)) throw new Error('engine state holds a non-finite number; refusing to write a checkpoint');
      return Number(x.toPrecision(d));
    };
    const s = this.s;
    const o = { v: STATE_VERSION, t: s.t, experts: s.experts, hedge: {}, aci: {}, platt: {}, est: {}, sig: {}, gate: {}, pending: [] };
    for (const h of HORIZONS) {
      o.hedge[h] = { L: s.hedge[h].L.map((x) => r(x, 8)), L0: r(s.hedge[h].L0, 8), t: s.hedge[h].t };
      o.aci[h] = s.aci[h].map((x) => r(x, 6));
      o.platt[h] = { a: r(s.platt[h].a), b: r(s.platt[h].b), H: s.platt[h].H.map((x) => r(x)), t: s.platt[h].t };
      o.est[h] = { sxy: r(s.est[h].sxy, 8), sxx: r(s.est[h].sxx, 8), t: s.est[h].t };
      o.sig[h] = s.sig[h].map((x) => r(x, 4));
      o.gate[h] = { g: r(s.gate[h].g, 8), n: r(s.gate[h].n, 8), on: s.gate[h].on, t: s.gate[h].t };
    }
    // times, horizon, price and origin exactly; the rest to 7 digits
    o.pending = s.pending.map((p) => p.map((x, k) => (k < 2 || k === P_C || k === P_O ? r(x, 17) : r(x, 7))));
    return o;
  }
}

export const PENDING_LAYOUT = { P_T, P_H, P_C, P_VOL, P_MU, P_P, P_B, P_X, P_S, P_EST, P_IM, P_O, P_PM, P_E };
