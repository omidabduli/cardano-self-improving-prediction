#!/usr/bin/env node
// Audit the live record against its git history: for every forecast row in
// data/predictions/*.csv, find the commit that first added it and check, per horizon, that the
// commit came before the forecast's outcome was known (candle close + horizon). The commit times
// are GitHub Actions' (the bot commits every run); GitHub also logs every push.
//
// A row whose `origin` says live but that was committed after its 1-hour outcome is flagged:
// that would mean the live score counted something that wasn't published in advance.
//
//   node research/verify-record.mjs [repo dir]   -> summary on stdout (JSON)
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(process.argv[2] || '.');
const H = [60, 180, 1440];
const MIN = 60000;

const logText = execFileSync('git', ['log', '--reverse', '--format=@@@%H %ct', '-p', '--unified=0', '--', 'data/predictions'], { cwd: repo, maxBuffer: 1 << 30 }).toString();
const first = new Map(); // id -> {commit time (ms), row}
let header = null, commitMs = 0;
for (const line of logText.split('\n')) {
  if (line.startsWith('@@@')) { commitMs = Number(line.split(' ')[1]) * 1000; continue; }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  const row = line.slice(1);
  if (row.startsWith('id,')) { header = row.split(','); continue; }
  const id = row.split(',', 1)[0];
  if (!first.has(id)) first.set(id, { at: commitMs, row });
}
if (!header) { console.log(JSON.stringify({ error: 'no v4 record rows in the git history' })); process.exit(0); }
const col = Object.fromEntries(header.map((k, i) => [k, i]));

const out = { repo, rows: 0, live: 0, replay: 0, suspended: 0, perHorizon: {}, flagged: [] };
for (const h of H) out.perHorizon[h] = { committedBeforeOutcome: 0, committedAfterOutcome: 0, liveAfterOutcome: 0 };
for (const [id, { at, row }] of first) {
  const c = row.split(',');
  const t = Date.parse(c[col.time] + ':00Z');
  if (!Number.isFinite(t)) continue;
  out.rows++;
  const origin = c[col.origin];
  if (c[col.status] !== 'ok') { out.suspended++; continue; }
  if (origin === 'live') out.live++; else out.replay++;
  for (const h of H) {
    const due = t + MIN + h * MIN;
    const ph = out.perHorizon[h];
    if (at < due) ph.committedBeforeOutcome++;
    else { ph.committedAfterOutcome++; if (origin === 'live') { ph.liveAfterOutcome++; if (h === 60) out.flagged.push({ id, committed: new Date(at).toISOString(), due: new Date(due).toISOString() }); } }
  }
}
out.ok = out.flagged.length === 0;
console.log(JSON.stringify(out, null, 1));
