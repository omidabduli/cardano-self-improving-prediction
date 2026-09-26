// Candle utilities: parse Binance klines and align the coin, its lead and its peer onto one
// gap-free minute grid, with a validity mask per source (a filled-in minute is never real data).

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

// Validity mask bits (S.bad): which source had no candle in that minute, so its values there
// are carried forward from the previous minute instead of being real.
export const BAD_TARGET = 1, BAD_LEAD = 2, BAD_PEER = 4;

// Delay before a daily Fear & Greed value (stamped 00:00 UTC) counts as public, when nothing
// better is known. This is an assumption: alternative.me doesn't say when it publishes. Values
// the pipeline fetched itself carry `seen` (when it first saw them), and then the later of the
// two counts, so a live forecast never uses a value before the pipeline actually had it.
export const FNG_LAG = 15 * MINUTE;
export const fngPublicAt = (x) => Math.max(x.t + FNG_LAG, Number.isFinite(x.seen) ? x.seen : 0);

/**
 * Build an aligned, gap-free minute series (columnar typed arrays).
 * Missing minutes are filled with flat zero-volume candles at the previous close,
 * so index i always corresponds to S.t[0] + i * MINUTE. Filled minutes are marked in S.bad
 * (BAD_TARGET | BAD_LEAD | BAD_PEER), so features, labels and scores can refuse them.
 *
 * Fields: t o h l c v qv tr tb (SYMBOL) · bc bv btb (LEAD_SYMBOL close, volume, taker-buy volume) · ec
 * (PEER_SYMBOL close) · fg fg7 (Fear & Greed now and 7 days earlier: the last value that was public at the
 * close of each minute, see fngPublicAt; 50 = neutral when unknown) · syn (1 = the coin's own candle
 * was filled) · bad (validity bits).
 *
 * @param {Array} ada   SYMBOL candles (any order, duplicates allowed)
 * @param {Array} btc   LEAD_SYMBOL candles
 * @param {number} endMs open time of the last minute to include
 * @param {{eth?: Array, fng?: {t:number,v:number,seen?:number}[]}} extra
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
  // sentiment in the order it became public (ties: the later stamp wins)
  const fng = sortedByT(extra.fng).map((x) => ({ at: fngPublicAt(x), t: x.t, v: x.v })).sort((x, y) => x.at - y.at || x.t - y.t);
  let jg = -1, jg7 = -1;
  for (let i = 0; i < n; i++) {
    const t = start + i * MINUTE;
    S.t[i] = t;
    let bad = 0;
    let a = A.get(t);
    if (!a) { a = flat(t, pa.c); S.syn[i] = 1; bad |= BAD_TARGET; }
    let b = B.get(t);
    if (!b) { b = flat(t, pb.c); bad |= BAD_LEAD; }
    S.o[i] = a.o; S.h[i] = a.h; S.l[i] = a.l; S.c[i] = a.c;
    S.v[i] = a.v; S.qv[i] = a.qv; S.tr[i] = a.tr; S.tb[i] = a.tb;
    S.bc[i] = b.c; S.bv[i] = b.v; S.btb[i] = b.tb;
    let e = E.get(t);
    if (!e) { e = pe; bad |= BAD_PEER; }
    S.ec[i] = e ? e.c : 1; // no peer data yet: constant (and marked), so peer returns read as zero
    S.bad[i] = bad;
    pa = a; pb = b; pe = e;
    // a value is usable at the close of minute t if it was public by then
    const close = t + MINUTE;
    while (jg + 1 < fng.length && fng[jg + 1].at <= close) jg++;
    while (jg7 + 1 < fng.length && fng[jg7 + 1].at <= close - 7 * 1440 * MINUTE) jg7++;
    S.fg[i] = jg >= 0 ? fng[jg].v : 50;
    S.fg7[i] = jg7 >= 0 ? fng[jg7].v : S.fg[i];
  }
  return S;
}

/**
 * Merge a fresh download of the daily Fear & Greed index into the recorded copy, the same way
 * everywhere: the first value recorded for a day is kept for good (a different value arriving
 * later is kept in `rev` for the record, but never used), and a day not recorded yet is added.
 * A value first seen within a day of its stamp gets `seen` = now: from then on it counts as
 * public only once the pipeline actually had it (fngPublicAt). Older values, and every value at a
 * fresh start (backfill: nothing was being watched yet), get no `seen`; for them the FNG_LAG
 * assumption stands, as in all training data.
 */
export function mergeFearGreed(recorded = [], fetched = [], now = Date.now(), { backfill = false } = {}) {
  const ok = (x) => x && Number.isFinite(x.t) && Number.isFinite(x.v);
  const m = new Map();
  for (const x of recorded) if (ok(x)) m.set(x.t, { ...x });
  for (const x of [...fetched].filter(ok).sort((a, b) => a.t - b.t || a.v - b.v)) {
    const cur = m.get(x.t);
    if (!cur) m.set(x.t, !backfill && now - x.t < 1440 * MINUTE ? { t: x.t, v: x.v, seen: now } : { t: x.t, v: x.v });
    else if (cur.v !== x.v && !(cur.rev || []).some((r) => r.v === x.v)) cur.rev = [...(cur.rev || []), { v: x.v, seen: now }];
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
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
  const S = { syn: new Uint8Array(n), bad: new Uint8Array(n) };
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
