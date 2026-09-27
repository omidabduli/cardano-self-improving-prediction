// Shared helpers for the research scripts: read Stage 1 output files.
import fs from 'node:fs';

// Returns {header, cols, rows: Float64Array[] (one per issue minute), days: Float64Array[]}.
export function readStage1(file) {
  const buf = fs.readFileSync(file);
  const hl = buf.readUInt32LE(0);
  const header = JSON.parse(buf.subarray(4, 4 + hl).toString());
  const off = 4 + hl;
  const body = new Float64Array(buf.buffer.slice(buf.byteOffset + off, buf.byteOffset + buf.length));
  const nc = header.cols.length, nd = header.dayCols.length;
  const rows = [], days = [];
  for (let j = 0; j < header.n; j++) rows.push(body.subarray(j * nc, (j + 1) * nc));
  for (let j = 0; j < header.nDays; j++) days.push(body.subarray(header.n * nc + j * nd, header.n * nc + (j + 1) * nd));
  return { header, cols: header.cols, dayCols: header.dayCols, rows, days };
}

// Merge several part files of one period (rows sorted by time, duplicates dropped).
export function readParts(files) {
  const parts = files.map(readStage1);
  const cols = parts[0].cols, dayCols = parts[0].dayCols;
  const seen = new Set();
  const rows = [], days = [];
  for (const p of parts) {
    for (const r of p.rows) if (!seen.has(r[0])) { seen.add(r[0]); rows.push(r); }
    days.push(...p.days);
  }
  rows.sort((a, b) => a[0] - b[0]);
  days.sort((a, b) => a[0] - b[0]);
  return { header: parts[0].header, cols, dayCols, rows, days, col: Object.fromEntries(cols.map((c, k) => [c, k])), dayCol: Object.fromEntries(dayCols.map((c, k) => [c, k])) };
}
