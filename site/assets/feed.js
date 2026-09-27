// Live market data in the browser: REST history + a WebSocket stream, both straight from
// Binance's public market-data endpoints (no key, no server in between).

import { REST_HOSTS, WS_HOSTS, SYMBOL, LEAD_SYMBOL, PEER_SYMBOL, MINUTE } from '../core/config.js';
import { parseKline, parseWsKline } from '../core/candles.js';

let restHost = 0;
const HEDGE_MS = 800; // ask the next host if the current one hasn't answered by then
const TIMEOUT_MS = 8000;

// One request, hedged across hosts: the preferred host goes first, and every HEDGE_MS without
// an answer the next host is asked too. The first good answer wins and the rest are cancelled.
// (data-api.binance.vision sometimes hangs for 10 s+ while api.binance.com answers at once.)
function getJSON(path) {
  return new Promise((resolve, reject) => {
    const ctls = [];
    let done = false, failed = 0, lastErr = null, next = 0;
    const finish = () => { done = true; clearInterval(timer); for (const c of ctls) c.abort(); };
    const launch = () => {
      if (done || next >= REST_HOSTS.length) return;
      const k = (restHost + next++) % REST_HOSTS.length;
      const ctl = new AbortController();
      ctls.push(ctl);
      const kill = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      fetch(REST_HOSTS[k] + path, { signal: ctl.signal, cache: 'no-store' })
        .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then((json) => { if (done) return; restHost = k; finish(); resolve(json); })
        .catch((e) => {
          if (done) return;
          lastErr = e;
          if (++failed >= REST_HOSTS.length) { finish(); reject(lastErr); } else launch();
        })
        .finally(() => clearTimeout(kill));
    };
    const timer = setInterval(launch, HEDGE_MS);
    launch();
  });
}

/** Latest traded price (one tiny request, so the page can show the price at once). */
export async function fetchPrice(symbol) {
  const { price } = await getJSON(`/api/v3/ticker/price?symbol=${symbol}`);
  return Number(price);
}

/** Milliseconds to add to the local clock to match Binance's server clock. */
export async function serverClockOffset() {
  const t0 = Date.now();
  const { serverTime } = await getJSON('/api/v3/time');
  const t1 = Date.now();
  const off = Math.round(serverTime - (t0 + t1) / 2); // whole ms: Binance rejects fractional times
  return Math.abs(off) > 2000 ? off : 0; // ignore sub-2s differences (network jitter)
}

/**
 * Daily Fear & Greed values [{t, v, seen?}] exactly as the pipeline recorded them (data/fng.json),
 * so the browser computes the same features as the record. (Asking alternative.me directly could
 * give a value the pipeline hadn't seen yet, and the page would disagree with the record.)
 */
export async function fetchFearGreed(publishedUrl) {
  const r = await fetch(publishedUrl, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${publishedUrl}: HTTP ${r.status}`);
  const rows = await r.json();
  return rows.filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
}

/** Closed and open 1m klines for [startMs, endMs]. */
export async function fetchKlines(symbol, startMs, endMs) {
  startMs = Math.floor(startMs); endMs = Math.floor(endMs);
  const pages = [];
  for (let s = startMs; s <= endMs; s += 1000 * MINUTE) pages.push(s);
  const res = await Promise.all(pages.map((s) =>
    getJSON(`/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${s}&endTime=${Math.min(s + 999 * MINUTE, endMs)}&limit=1000`)));
  return res.flat().map(parseKline);
}

/**
 * WebSocket stream with host fallback, heartbeat watchdog and exponential reconnect.
 * Callbacks: onKline(symbol, kline), onTrade(price, timeMs), onState('live'|'connecting'|'down')
 */
export class LiveStream {
  constructor(cb) {
    this.cb = cb;
    this.hostIdx = 0;
    this.retry = 0;
    this.ws = null;
    this.lastMsg = 0;
    this.watch = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 && Date.now() - this.lastMsg > 25000) this.ws.close();
    }, 5000);
  }

  connect() {
    const streams = [SYMBOL, LEAD_SYMBOL, PEER_SYMBOL].map((s) => `${s.toLowerCase()}@kline_1m`).concat(`${SYMBOL.toLowerCase()}@aggTrade`).join('/');
    const url = `${WS_HOSTS[this.hostIdx % WS_HOSTS.length]}/stream?streams=${streams}`;
    this.cb.onState?.('connecting');
    let opened = false;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { opened = true; this.retry = 0; this.lastMsg = Date.now(); this.cb.onState?.('live'); this.cb.onOpen?.(); };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const d = m.data;
      if (!d) return;
      if (d.e === 'kline') this.cb.onKline?.(d.s, parseWsKline(d.k));
      else if (d.e === 'aggTrade') this.cb.onTrade?.(Number(d.p), Number(d.T));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.cb.onState?.('down');
      if (!opened) this.hostIdx++;
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
}
