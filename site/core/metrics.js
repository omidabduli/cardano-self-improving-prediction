// Scoring. Aggregates are plain sums so they can be added across days/sessions and
// turned into rates only for display.

import { HORIZONS } from './config.js';

export function emptyAgg() {
  // n: resolved, nm: resolved with a price move (ties excluded from direction stats)
  // hit: correct direction, bs: Brier sum, ll: log-loss sum, c: band hits [50,80,95]
  // se/se0: squared error of the forecast / of "no change" (standardised units)
  // ae/ae0: absolute error of the predicted log-return / of "no change" (the typical miss)
  // sn/sh: confident calls and their hits
  // ni/hi: non-overlapping calls (issued on a multiple of h: every hour, every 3 h, daily at
  //        00:00 UTC) and their hits. A 24-hour call made every 15 minutes is not 96 independent
  //        bets, so significance uses these only.
  return { n: 0, nm: 0, hit: 0, bs: 0, ll: 0, c: [0, 0, 0], se: 0, se0: 0, ae: 0, ae0: 0, sn: 0, sh: 0, ni: 0, hi: 0 };
}

export function addResolution(a, r) {
  a.n++;
  for (let k = 0; k < 3; k++) if (r.inb[k]) a.c[k]++;
  a.se += (r.z - r.mu) ** 2;
  a.se0 += r.z ** 2;
  a.ae += Math.abs(r.y - r.ret);
  a.ae0 += Math.abs(r.y);
  if (r.hit !== null) {
    a.nm++;
    a.hit += r.hit;
    const u = r.y > 0 ? 1 : 0;
    a.bs += (r.p - u) ** 2;
    const pp = Math.min(Math.max(r.p, 1e-6), 1 - 1e-6);
    a.ll += -(u ? Math.log(pp) : Math.log(1 - pp));
    if (r.strong) { a.sn++; a.sh += r.hit; }
    if ((Math.round(r.t / 60000) + 1) % r.h === 0) { a.ni++; a.hi += r.hit; }
  }
  return a;
}

export function mergeAgg(a, b) {
  const o = emptyAgg();
  for (const x of [a, b]) {
    if (!x) continue;
    o.n += x.n; o.nm += x.nm; o.hit += x.hit; o.bs += x.bs; o.ll += x.ll;
    o.se += x.se; o.se0 += x.se0; o.sn += x.sn; o.sh += x.sh;
    o.ae += x.ae || 0; o.ae0 += x.ae0 || 0;
    o.ni += x.ni || 0; o.hi += x.hi || 0;
    for (let k = 0; k < 3; k++) o.c[k] += x.c[k];
  }
  return o;
}

// Rates for display. Includes a z-score of the hit rate against a fair coin.
export function summarize(a) {
  if (!a || !a.n) return null;
  const acc = a.nm ? a.hit / a.nm : null;
  return {
    n: a.n,
    nm: a.nm,
    acc,
    // z-test vs. a fair coin on non-overlapping calls only (honest significance)
    zscore: a.ni ? (a.hi - a.ni / 2) / Math.sqrt(a.ni / 4) : null,
    ni: a.ni,
    brier: a.nm ? a.bs / a.nm : null,
    bss: a.nm ? 1 - a.bs / a.nm / 0.25 : null,
    cov: a.c.map((x) => x / a.n),
    r2: a.se0 > 0 ? 1 - a.se / a.se0 : null,
    mae: a.ae / a.n,
    mae0: a.ae0 / a.n,
    strongN: a.sn,
    strongAcc: a.sn ? a.sh / a.sn : null,
  };
}

export function roundAgg(a) {
  const r = (x) => Number(x.toFixed(4));
  const r6 = (x) => Number(x.toFixed(6));
  return { ...a, bs: r(a.bs), ll: r(a.ll), se: r(a.se), se0: r(a.se0), ae: r6(a.ae), ae0: r6(a.ae0), c: [...a.c] };
}

export function emptyHorizonAggs() {
  const o = {};
  for (const h of HORIZONS) o[h] = emptyAgg();
  return o;
}
