// Small file helpers for the data/ directory (the public, committed record).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HORIZONS } from '../site/core/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');

export function readJSON(rel, fallback = null) {
  const p = path.join(DATA, rel);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Written to a temporary file first and renamed: a crash never leaves half a file behind.
export function writeJSON(rel, obj, pretty = false) {
  const p = path.join(DATA, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, pretty ? 1 : 0) + '\n');
  fs.renameSync(p + '.tmp', p);
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isoMinute = (ms) => new Date(ms).toISOString().slice(0, 16);

// Record schema v4: one row per issue minute (docs/ARCHITECTURE.md explains every column).
//   id, time (candle open, UTC; the forecast is made when it closes), close,
//   generated_utc (when the pipeline computed the row), origin (live = within LIVE_MAX_LAG_MIN of
//   the close, replay = backfilled later; only live rows count in the live score), status (ok /
//   suspended = no forecast, inputs not real), inputs (validity bits: 1 coin, 2 lead, 4 peer had no
//   candle, 8 too many gaps in the last hour), model, code (git commit), schema,
//   then per horizon h (minutes): price (the shown price), est (its move, bp), p (P(up)),
//   dir (up / down / neutral), strong (1/0); not shown, kept to be re-tested: pm (the direction
//   model's own P(up), before a "no reliable signal" horizon sets p to 50%), imp (the shrunk
//   implied move, bp), ens (the experts' ensemble move, bp); lo / hi (the 80% range, bp)
export const RECORD_SCHEMA = 4;
export const PER_HORIZON = ['price', 'est', 'p', 'dir', 'strong', 'pm', 'imp', 'ens', 'lo', 'hi'];
export const CSV_HEADER = ['id', 'time', 'close', 'generated_utc', 'origin', 'status', 'inputs', 'model', 'code', 'schema',
  ...HORIZONS.flatMap((h) => PER_HORIZON.map((c) => `${c}${h}`))].join(',');
export const CSV_TIME_COL = 1;

const rowTime = (r) => r.split(',', CSV_TIME_COL + 1)[CSV_TIME_COL] || '';

// Append rows (already formatted, one per minute, sorted) to per-day CSV files, skipping
// minutes that are already recorded so re-runs are idempotent. Rows are never rewritten.
export function appendPredictionRows(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = rowTime(r).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, list] of byDay) {
    const p = path.join(DATA, 'predictions', `${day}.csv`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let last = '';
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8').trimEnd();
      const nl = txt.indexOf('\n');
      if ((nl < 0 ? txt : txt.slice(0, nl)) !== CSV_HEADER) throw new Error(`${p} has another schema; refusing to mix records`);
      if (nl >= 0) last = rowTime(txt.slice(txt.lastIndexOf('\n') + 1));
    } else {
      fs.writeFileSync(p, CSV_HEADER + '\n');
    }
    const fresh = list.filter((r) => rowTime(r) > last);
    if (fresh.length) fs.appendFileSync(p, fresh.join('\n') + '\n');
  }
}

export function listPredictionDays() {
  const dir = path.join(DATA, 'predictions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => f.slice(0, 10)).sort();
}

export function listMonths() {
  const dir = path.join(DATA, 'daily');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, 7)).sort();
}
