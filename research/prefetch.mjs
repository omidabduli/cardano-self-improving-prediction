#!/usr/bin/env node
// Download (once) every archive file the research runs need, before starting parallel jobs.
//   node research/prefetch.mjs 2024-01-10 2026-09-25
import { SYMBOL, LEAD_SYMBOL, PEER_SYMBOL } from '../site/core/config.js';
import { klines } from '../engine/backtest.mjs';
const [from, to] = process.argv.slice(2).map((d) => Date.parse(d + 'T00:00:00Z'));
for (const s of [SYMBOL, LEAD_SYMBOL, PEER_SYMBOL]) {
  const k = await klines(s, from, to + 86400000 - 60000);
  console.log(s, k.length, 'candles');
}
