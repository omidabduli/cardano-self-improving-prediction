// Binance public market data (no API key). Tries several hosts because the main API is
// geo-restricted in some regions while data-api.binance.vision is not.

import { REST_HOSTS, MINUTE, ASSET } from '../site/core/config.js';
import { parseKline, mergeFearGreed } from '../site/core/candles.js';

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
      const res = await fetch(host + path, { signal: ctl.signal, headers: { 'User-Agent': ASSET.userAgent } });
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
 * Daily crypto Fear & Greed index (alternative.me, free, no key) as [{t, v, seen?, rev?}], oldest
 * first: the recorded copy (data/fng.json) with the new days merged in (candles.mergeFearGreed:
 * a recorded value is never replaced). If the API fails, the recorded copy is used as is, so a
 * flaky API never changes a forecast; the browser reads the same published copy.
 */
export async function fetchFearGreed(days, recorded = [], now = Date.now(), { backfill = false } = {}) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(`https://api.alternative.me/fng/?limit=${days}`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()).data.map((d) => ({ t: Number(d.timestamp) * 1000, v: Number(d.value) }));
    return mergeFearGreed(recorded, rows, now, { backfill });
  } catch (e) {
    console.log(`::warning::Fear & Greed unavailable (${e.message}); using the published copy`);
    return recorded;
  }
}
