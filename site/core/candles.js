// Candle utilities: parse Binance klines and align ADA + BTC onto one gap-free minute grid.

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

const FIELDS = ['t', 'o', 'h', 'l', 'c', 'v', 'qv', 'tr', 'tb', 'bc', 'bv', 'btb'];

/**
 * Build an aligned, gap-free minute series (columnar typed arrays).
 * Missing minutes are filled with flat zero-volume candles at the previous close,
 * so index i always corresponds to S.t[0] + i * MINUTE.
 *
 * Fields: t o h l c v qv tr tb (ADA) · bc bv btb (BTC close, volume, taker-buy volume) · syn (1 = filled)
 *
 * @param {Array} ada   ADAUSDT candles (any order, duplicates allowed)
 * @param {Array} btc   BTCUSDT candles
 * @param {number} endMs open time of the last minute to include
 */
export function buildSeries(ada, btc, endMs) {
  const A = new Map(), B = new Map();
  for (const k of ada) if (k.t <= endMs) A.set(k.t, k);
  for (const k of btc) if (k.t <= endMs) B.set(k.t, k);
  if (!A.size || !B.size) return allocSeries(0);
  let firstA = Infinity, firstB = Infinity;
  for (const t of A.keys()) if (t < firstA) firstA = t;
  for (const t of B.keys()) if (t < firstB) firstB = t;
  const start = Math.max(firstA, firstB);
  const n = Math.floor((endMs - start) / MINUTE) + 1;
  if (n <= 0) return allocSeries(0);
  const S = allocSeries(n);
  // previous candles: the latest ones at or before `start` (start itself always exists for one side)
  let pa = latestBefore(A, start), pb = latestBefore(B, start);
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
    pa = a; pb = b;
  }
  return S;
}

function latestBefore(M, t) {
  let best = null;
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
