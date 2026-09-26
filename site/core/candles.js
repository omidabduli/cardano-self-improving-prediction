// Candle utilities: parse Binance klines and align the coin and its lead onto one gap-free minute grid.

import { MINUTE } from './config.js';

// Binance kline array -> compact candle object.
// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
export function parseKline(k) {
  return {
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    T: Number(k[6]),
    qv: Number(k[7]),
    tr: Number(k[8]),
    tb: Number(k[9]),
  };
}

// WebSocket kline payload (data.k) -> same shape.
export function parseWsKline(k) {
  return {
    t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c),
    v: Number(k.v), T: Number(k.T), qv: Number(k.q), tr: Number(k.n), tb: Number(k.V),
    closed: !!k.x,
  };
}

const FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'qv', 'tr', 'tb', 'bc', 'bv', 'btb', 'ec', 'fg', 'fg7'];

// Delay before a daily Fear & Greed value (stamped 00:00 UTC) counts as public.
export const FNG_LAG = 15 * MINUTE;

/**
 * Build an aligned, gap-free minute series (columnar typed arrays).
 * Missing minutes are filled with flat zero-volume candles at the previous close,
 * so index i always corresponds to S.t[0] + i * MINUTE.
 *
 * Fields: t o h l c v qv tr tb (SYMBOL) · bc bv btb (LEAD_SYMBOL close, volume, taker-buy volume) · ec
 * (PEER_SYMBOL close) · fg fg7 (Fear & Greed now and 7 days earlier: the last value that was public at the
 * close of each minute; 50 = neutral when unknown) · syn (1 = filled).
 *
 * @param {Array} ada   SYMBOL candles (any order, duplicates allowed)
 * @param {Array} btc   LEAD_SYMBOL candles
 * @param {number} endMs open time of the last minute to include
 * @param {{eth?: Array, fng?: {t:number,v:number}[]}} extra
 */
export function buildSeries(ada, btc, endMs, extra = {}) {
  const A = new Map(), B = new Map(), E = new Map();
  for (const k of ada) if (k.t <= endMs) A.set(k.t, k);
  for (const k of btc) if (k.t <= endMs) B.set(k.t, k);
  for (const k of extra.eth || []) if (k.t <= endMs) E.set(k.t, k);
  if (!A.size || !B.size) return allocSeries(0);
  let firstA = Infinity, firstB = Infinity;
  for (const t of A.keys()) if (t < firstA) firstA = t;
  for (const t of B.keys()) if (t < firstB) firstB = t;
  const start = Math.max(firstA, firstB);
  const n = Math.floor((endMs - start) / MINUTE) + 1;
  if (n <= 0) return allocSeries(0);
  const S = allocSeries(n);
  // previous candles: the latest ones at or before `start` (start itself always exists for one side)
  let pa = latestBefore(A, start), pb = latestBefore(B, start), pe = latestBefore(E, start);
  const fng = sortedByT(extra.fng);
  let jg = -1, jg7 = -1;
  for (let i = 0; i < n; i++) {
    const t = start + i * MINUTE;
    S.t[i] = t;
    let a = A.get(t);
    if (!a) { a = flat(t, pa.c); S.syn[i] = 1; }
    let b = B.get(t);
    if (!b) b = flat(t, pb.c);
    S.o[i] = a.o; S.h[i] = a.h; S.l[i] = a.l; S.c[i] = a.c;
    S.v[i] = a.v; S.qv[i] = a.qv; S.tr[i] = a.tr; S.tb[i] = a.tb;
    S.bc[i] = b.c; S.bv[i] = b.v; S.btb[i] = b.tb;
    const e = E.get(t) || pe;
    S.ec[i] = e ? e.c : 1; // no peer data: constant, so peer returns read as zero
    pa = a; pb = b; pe = e;
    // a value is usable at the close of minute t if it was public by then
    const close = t + MINUTE;
    while (jg + 1 < fng.length && fng[jg + 1].t + FNG_LAG <= close) jg++;
    while (jg7 + 1 < fng.length && fng[jg7 + 1].t + FNG_LAG <= close - 7 * 1440 * MINUTE) jg7++;
    S.fg[i] = jg >= 0 ? fng[jg].v : 50;
    S.fg7[i] = jg7 >= 0 ? fng[jg7].v : S.fg[i];
  }
  return S;
}

function sortedByT(a) {
  return (a || []).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((x, y) => x.t - y.t);
}

function latestBefore(M, t) {
  let best = null;
  if (!M.size) return null;
  for (const [k, v] of M) if (k <= t && (!best || k > best.t)) best = v;
  return best;
}

function flat(t, c) {
  return { t, o: c, h: c, l: c, c, v: 0, qv: 0, tr: 0, tb: 0 };
}

export function allocSeries(n) {
  const S = { syn: new Uint8Array(n) };
  for (const f of FIELDS) S[f] = new Float64Array(n);
  return S;
}

// Index of a minute timestamp inside a series (or -1).
export function indexOf(S, t) {
  const n = S.t.length;
  if (!n) return -1;
  const i = Math.round((t - S.t[0]) / MINUTE);
  return i >= 0 && i < n && S.t[i] === t ? i : -1;
}
