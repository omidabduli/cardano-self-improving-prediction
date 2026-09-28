#!/usr/bin/env node
// Replays the production system (config.js, engine/train.mjs DIRECTION_LIVE) over the Stage 1
// model outputs and writes every 1-hour and 3-hour forecast with its outcome, so simple "when not
// to call" rules can be checked on the untouched year (P0) after being found on P12. See
// docs/EXPERIMENTS.md, "Call rules (September 2026)".
//
//   node --max-old-space-size=8192 research/rules.mjs [--dir .cache/research] > forecasts.csv
//   columns: period, t (issue candle open, ms), h (minutes), p (P(up) shown), y (log move)
import fs from 'node:fs';
import path from 'node:path';
import { readParts } from './lib.mjs';
import { Engine, freshState } from '../site/core/engine.js';
import { HORIZONS, MINUTE, ONLINE, SHADOW_HORIZONS, SHOW_MOVE } from '../site/core/config.js';
import { EXPERTS } from '../site/core/models.js';
import { DIRECTION_LIVE } from '../engine/train.mjs';

const args = process.argv.slice(2);
const DIR = path.resolve(args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.cache/research');
const DAY = 86400000;
const ids = EXPERTS.map((e) => e.id);
const OPT = { online: { ...ONLINE }, shadow: [...SHADOW_HORIZONS], showMove: SHOW_MOVE, gate: ONLINE.gate };
const SRC = Object.fromEntries(HORIZONS.map((h) => [h, DIRECTION_LIVE.perHorizon?.[h]?.kind === 'ridge' ? 'ridge240' : 'pair240']));
const PERIODS = [['P0', ['P0-1.bin', 'P0-2.bin']], ['P12', ['P12-1.bin', 'P12-2.bin']]];

const out = ['period,t,h,p,y'];
for (const [name, files] of PERIODS) {
  const per = readParts(files.map((f) => path.join(DIR, f)));
  const c = per.col, dc = per.dayCol;
  const dayByT = new Map(per.days.map((d) => [d[0], d]));
  const rows = per.rows;
  const eng = new Engine({ experts: ids.map((id) => ({ id })), resid: null }, freshState(ids, rows[0][0] - MINUTE, OPT.online), OPT);
  let day = null, dayRec = null;
  for (const r of rows) {
    const t = r[0], d = Math.floor(t / DAY) * DAY;
    if (d !== day) {
      day = d; dayRec = dayByT.get(d) || null;
      if (dayRec) eng.model = { experts: ids.map((id) => ({ id })), resid: Object.fromEntries(HORIZONS.map((h) => [h, [0, 1, 2, 3, 4, 5, 6].map((q) => dayRec[dc[`resid_${h}_${q}`]])])) };
    }
    let mus = null, dir = null;
    if (r[4] === 1 && dayRec && eng.model.resid) {
      mus = {}; dir = {};
      for (const h of HORIZONS) {
        const a = ids.map((id) => r[c[`mu_${id}_${h}`]]);
        const v = SRC[h] === 'ridge240' ? r[c[`pair240_a_${h}`]] : 0.5 * (r[c[`pair240_a_${h}`]] + r[c[`pair240_b_${h}`]]);
        if (!a.every(Number.isFinite) || !Number.isFinite(v)) { mus = dir = null; break; }
        mus[h] = a; dir[h] = { d: Math.max(-5, Math.min(5, v)), thr: dayRec[dc[`thr_pair240_${h}`]] };
      }
    }
    const { resolved } = eng.step(t, r[1], r[2], mus, dir, { real: r[3] === 1 });
    for (const x of resolved) if (!x.unavailable && x.h !== 1440) out.push(`${name},${x.t},${x.h},${x.p.toFixed(6)},${x.y.toPrecision(6)}`);
  }
  console.error(name, 'done');
}
fs.writeSync(1, out.join('\n') + '\n');
