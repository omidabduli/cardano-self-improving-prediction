// Live market data in the browser: REST history + a WebSocket stream, both straight from
// Binance's public market-data endpoints (no key, no server in between).

import { REST_HOSTS, WS_HOSTS, SYMBOL, BTC_SYMBOL, ETH_SYMBOL, MINUTE } from '../core/config.js';
import { parseKline, parseWsKline } from '../core/candles.js';

let restHost = 0;

async function getJSON(path) {
  let err;
  for (let a = 0; a < REST_HOSTS.length * 2; a++) {
    const host = REST_HOSTS[(restHost + a) % REST_HOSTS.length];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const res = await fetch(host + path, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (res.ok) { restHost = REST_HOSTS.indexOf(host); return res.json(); }
      err = new Error('HTTP ' + res.status);
    } catch (e) {
      err = e;
    }
  }
  throw err;
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
 * Daily Fear & Greed values [{t, v}]: the copy the pipeline published (so the browser sees
 * exactly what the record used) merged with the newest days straight from alternative.me.
 */
export async function fetchFearGreed(publishedUrl) {
  const m = new Map();
  const add = (rows) => { for (const x of rows) if (Number.isFinite(x.t) && Number.isFinite(x.v)) m.set(x.t, x); };
  await Promise.all([
    fetch(publishedUrl, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).then(add).catch(() => {}),
    fetch('https://api.alternative.me/fng/?limit=10').then((r) => r.json())
      .then((j) => add(j.data.map((d) => ({ t: Number(d.timestamp) * 1000, v: Number(d.value) })))).catch(() => {}),
  ]);
  return [...m.values()].sort((a, b) => a.t - b.t);
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
    const streams = [SYMBOL, BTC_SYMBOL, ETH_SYMBOL].map((s) => `${s.toLowerCase()}@kline_1m`).concat(`${SYMBOL.toLowerCase()}@aggTrade`).join('/');
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
