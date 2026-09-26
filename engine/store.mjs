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

export function writeJSON(rel, obj, pretty = false) {
  const p = path.join(DATA, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, pretty ? 1 : 0) + '\n');
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const isoMinute = (ms) => new Date(ms).toISOString().slice(0, 16);

// per horizon h (minutes): predicted log-return (bp), P(up), 80% band low/high (bp), confident call (1/0)
export const CSV_HEADER = ['time', 'close', ...HORIZONS.flatMap((h) => [`ret${h}`, `p${h}`, `lo${h}`, `hi${h}`, `conf${h}`])].join(',');

// Append rows (already formatted, one per minute, sorted) to per-day CSV files, skipping
// minutes that are already recorded so re-runs are idempotent.
export function appendPredictionRows(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = r.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, list] of byDay) {
    const p = path.join(DATA, 'predictions', `${day}.csv`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let last = '';
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8').trimEnd();
      last = txt.slice(txt.lastIndexOf('\n') + 1).slice(0, 16);
    } else {
      fs.writeFileSync(p, CSV_HEADER + '\n');
    }
    const fresh = list.filter((r) => r.slice(0, 16) > last);
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
