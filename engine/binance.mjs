// Binance public market data (no API key). Tries several hosts because the main API is
// geo-restricted in some regions while data-api.binance.vision is not.

import { REST_HOSTS, MINUTE } from '../site/core/config.js';
import { parseKline } from '../site/core/candles.js';

let preferred = 0;
export let lastHost = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const host = REST_HOSTS[(preferred + attempt) % REST_HOSTS.length];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(host + path, { signal: ctl.signal, headers: { 'User-Agent': 'adaptive-predictor' } });
      clearTimeout(timer);
      if (res.ok) {
        preferred = REST_HOSTS.indexOf(host);
        lastHost = host;
        return await res.json();
      }
      lastErr = new Error(`${host} HTTP ${res.status}`);
      if (res.status === 429 || res.status === 418) await sleep(2000 * (attempt + 1));
      // 451/403 = region blocked -> the loop moves on to the next host
    } catch (e) {
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Fetch closed 1-minute klines for [startMs, endMs] (open times, inclusive).
 */
export async function fetchKlines(symbol, startMs, endMs, { concurrency = 6 } = {}) {
  const pages = [];
  for (let s = startMs; s <= endMs; s += 1000 * MINUTE) pages.push(s);
  const out = [];
  for (let i = 0; i < pages.length; i += concurrency) {
    const batch = await Promise.all(
      pages.slice(i, i + concurrency).map((s) => {
        const e = Math.min(s + 999 * MINUTE, endMs);
        return getJSON(`/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${s}&endTime=${e}&limit=1000`);
      }),
    );
    for (const rows of batch) for (const k of rows) out.push(parseKline(k));
  }
  const now = Date.now();
  return out.filter((k) => k.T < now); // closed candles only
}

/**
 * Daily crypto Fear & Greed index (alternative.me, free, no key) as [{t, v}], oldest first.
 * Falls back to the copy the pipeline published last time, so a flaky API never changes a
 * forecast: the browser reads the same published copy.
 */
export async function fetchFearGreed(days, fallback = []) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(`https://api.alternative.me/fng/?limit=${days}`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()).data.map((d) => ({ t: Number(d.timestamp) * 1000, v: Number(d.value) }));
    const m = new Map(fallback.map((x) => [x.t, x]));
    for (const x of rows) if (Number.isFinite(x.t) && Number.isFinite(x.v)) m.set(x.t, x);
    return [...m.values()].sort((a, b) => a.t - b.t);
  } catch (e) {
    console.log(`::warning::Fear & Greed unavailable (${e.message}); using the published copy`);
    return fallback;
  }
}
