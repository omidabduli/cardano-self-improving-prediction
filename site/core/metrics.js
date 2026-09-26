// Scoring (record schema v4). Aggregates are plain sums so they can be added across days and
// sessions, and turned into rates only for display. What is scored is what the page shows:
// the call from P(up) (forecast.directionOf, "no clear direction" is no call), the shown price
// (forecast.shownForecast) and the ranges. v3's aggregates (archived with the v3 record) used
// other definitions and must not be merged with these.

import { HORIZONS, BANDS } from './config.js';
import { directionOf } from './forecast.js';

export const METRICS_VERSION = 4;

export function emptyAgg() {
  return {
    n: 0, // forecasts whose outcome is a real price
    nu: 0, // outcomes unavailable (no real candle at the horizon): not scored
    nm: 0, // ... with a price move (a tie says nothing about direction)
    bs: 0, ll: 0, // Brier score and log loss of P(up), summed over nm (a 50% forecast scores like a coin)
    nc: 0, hit: 0, // calls among nm (up or down; "no clear direction" is not a call) and right ones
    nin: 0, // non-overlapping forecasts with a move (issued on a multiple of h: hourly, 3-hourly,
    //        daily at 00:00 UTC): a 24-hour forecast made every 15 minutes is not 96 bets
    ni: 0, hi: 0, // non-overlapping calls and right ones (significance uses these only)
    sni: 0, shi: 0, // ... of them with a strong signal, and right ones
    c: [0, 0, 0], // outcomes inside the 50/80/95% range
    w: [0, 0, 0], // range widths (log-move, summed)
    is: [0, 0, 0], // interval scores (width + 2/alpha x the miss outside the range)
    ae: 0, se: 0, // the shown price: absolute / squared error of its log-move
    ae0: 0, se0: 0, // "no change"
    abv: 0, // outcomes above the shown price (exactly on it counts half)
    aeE: 0, seE: 0, // the experts' ensemble move (not shown; kept for the record)
    zse: 0, zse0: 0, // legacy (v3 "R^2"): ensemble vs "no change", standardised and clipped
  };
}

export function addResolution(a, r) {
  if (r.unavailable) { a.nu++; return a; }
  a.n++;
  const y = r.y;
  for (let k = 0; k < BANDS.length; k++) {
    if (r.inb[k]) a.c[k]++;
    const lo = r.lo[k], hi = r.hi[k], al = 1 - BANDS[k];
    a.w[k] += hi - lo;
    a.is[k] += hi - lo + (2 / al) * (Math.max(0, lo - y) + Math.max(0, y - hi));
  }
  a.ae += Math.abs(y - r.est); a.se += (y - r.est) ** 2;
  a.ae0 += Math.abs(y); a.se0 += y * y;
  a.abv += y > r.est ? 1 : y === r.est ? 0.5 : 0;
  a.aeE += Math.abs(y - r.ret); a.seE += (y - r.ret) ** 2;
  a.zse += (r.z - r.mu) ** 2; a.zse0 += r.z ** 2;
  if (y !== 0) {
    const u = y > 0 ? 1 : 0;
    a.nm++;
    a.bs += (r.p - u) ** 2;
    const pp = Math.min(Math.max(r.p, 1e-6), 1 - 1e-6);
    a.ll += -(u ? Math.log(pp) : Math.log(1 - pp));
    const dir = directionOf(r.p);
    const nonOverlap = (Math.round(r.t / 60000) + 1) % r.h === 0;
    if (nonOverlap) a.nin++;
    if (dir !== 'neutral') {
      const hit = (y > 0) === (dir === 'up') ? 1 : 0;
      a.nc++; a.hit += hit;
      if (nonOverlap) {
        a.ni++; a.hi += hit;
        if (r.strong) { a.sni++; a.shi += hit; }
      }
    }
  }
  return a;
}

export function mergeAgg(a, b) {
  const o = emptyAgg();
  for (const x of [a, b]) {
    if (!x) continue;
    for (const k of Object.keys(o)) {
      if (Array.isArray(o[k])) for (let j = 0; j < o[k].length; j++) o[k][j] += (x[k] && x[k][j]) || 0;
      else o[k] += x[k] || 0;
    }
  }
  return o;
}

const coinZ = (hit, n) => (n ? (hit - n / 2) / Math.sqrt(n / 4) : null);

// Rates for display. The z-scores against a fair coin use non-overlapping calls only; they
// ignore that neighbouring days share market conditions, so treat them as rough (research/
// reports block-bootstrap intervals instead).
export function summarize(a) {
  if (!a || !a.n) return null;
  const nm = a.nm || 0;
  return {
    n: a.n, unavailable: a.nu,
    acc: a.nc ? a.hit / a.nc : null,
    accI: a.ni ? a.hi / a.ni : null, ni: a.ni, zI: coinZ(a.hi, a.ni),
    callShare: a.nin ? a.ni / a.nin : null,
    strongAccI: a.sni ? a.shi / a.sni : null, sni: a.sni, strongZ: coinZ(a.shi, a.sni),
    strongShare: a.nin ? a.sni / a.nin : null,
    brier: nm ? a.bs / nm : null,
    bss: nm ? 1 - a.bs / nm / 0.25 : null,
    logloss: nm ? a.ll / nm : null,
    llGain: nm ? Math.LN2 - a.ll / nm : null,
    cov: a.c.map((x) => x / a.n),
    width: a.w.map((x) => x / a.n),
    iscore: a.is.map((x) => x / a.n),
    mae: a.ae / a.n, mae0: a.ae0 / a.n, maeSkill: a.ae0 > 0 ? 1 - a.ae / a.ae0 : null,
    rmse: Math.sqrt(a.se / a.n), rmse0: Math.sqrt(a.se0 / a.n), mseSkill: a.se0 > 0 ? 1 - a.se / a.se0 : null,
    above: a.abv / a.n,
    ensMseSkill: a.se0 > 0 ? 1 - a.seE / a.se0 : null,
    legacyR2: a.zse0 > 0 ? 1 - a.zse / a.zse0 : null,
  };
}

export function roundAgg(a) {
  const o = {};
  for (const [k, v] of Object.entries(a)) {
    if (Array.isArray(v)) o[k] = v.map((x) => (Number.isInteger(x) ? x : Number(x.toPrecision(10))));
    else o[k] = Number.isInteger(v) ? v : Number(v.toPrecision(10));
  }
  return o;
}

export function emptyHorizonAggs() {
  const o = {};
  for (const h of HORIZONS) o[h] = emptyAgg();
  return o;
}
