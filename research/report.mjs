#!/usr/bin/env node
// Turn Stage 2 results into the Markdown tables of docs/EXPERIMENTS.md.
//   node research/report.mjs research/results/stage2-btc.json research/results/stage2-ada.json > tables.md
import fs from 'node:fs';

const files = process.argv.slice(2);
const H = ['60', '180', '1440'];
const HN = { 60: '1 h', 180: '3 h', 1440: '24 h' };
const SPLITS = [['untouched', 'P0 untouched (24 Sep 2024 – 23 Sep 2025)'], ['tuning', 'P12 tuning (24 Sep 2025 – 24 May 2026)'], ['later', 'P12 later, inspected (25 May – 24 Sep 2026)']];
const out = [];
const p = (...a) => out.push(a.join(''));

const z = (t) => (/^-0\.?0*$/.test(t) ? t.slice(1) : t); // no "-0.0"
const f1 = (x, d = 1) => (x === null || x === undefined ? '–' : z(x.toFixed(d)));
const pc = (x, d = 1) => (x === null || x === undefined ? '–' : (x * 100).toFixed(d));
const e4 = (x) => (x === null || x === undefined ? '–' : z((x * 1e4).toFixed(1)));
const ci4 = (c) => (c && c[0] !== null ? ` [${z((c[0] * 1e4).toFixed(1))}, ${z((c[1] * 1e4).toFixed(1))}]` : '');
const cipc = (c) => (c && c[0] !== null ? ` [${(c[0] * 100).toFixed(1)}, ${(c[1] * 100).toFixed(1)}]` : '');
const dci4 = (d) => (d ? `${z((d[0] * 1e4).toFixed(1))} [${z((d[1] * 1e4).toFixed(1))}, ${z((d[2] * 1e4).toFixed(1))}]` : '–');
const dcipc = (d) => (d ? `${(d[0] * 100).toFixed(1)} [${(d[1] * 100).toFixed(1)}, ${(d[2] * 100).toFixed(1)}]` : '–');

for (const file of files) {
  const R = JSON.parse(fs.readFileSync(file, 'utf8'));
  const V = R.variants, P = R.paired;
  const get = (name, sp, h) => V[name] && V[name][sp] && V[name][sp][h];
  p(`\n### ${R.coin}\n`);

  // 1. adaptation ladder: log-loss gain over a coin, per horizon and period
  p(`\n**Probability of "up": log-loss gain over a coin flip** (×10⁻⁴ nats per forecast, higher is better; 95% week-block interval where computed). ${R.coin}.\n`);
  const ladder = ['baseline coin', 'baseline up-share 30 d', 'baseline momentum/reversal 30 d', 'frozen, no learning', 'frozen + online', 'refit, no learning', 'v4', 'v4 + evolution', 'selection policy', 'v4 + signal gate', 'v4, 24 h no signal', 'final', 'v3 online layer'];
  const names = { 'v4': 'refit daily + online learning (v4)', 'v4 + evolution': 'v4 + daily evolution of the experts', 'v3 online layer': 'v3 online layer (for reference)', 'selection policy': 'v4 + sequential direction-model selection', 'v4, 24 h no signal': 'v4 with 24 h set to "no signal"', 'final': '**final: the adopted combination**' };
  for (const [sp, title] of SPLITS) {
    if (!ladder.some((n) => get(n, sp, '60'))) continue;
    p(`\n*${title}*\n`);
    p('| System | ', H.map((h) => HN[h]).join(' | '), ' |');
    p('|---|', H.map(() => '---:').join('|'), '|');
    for (const n of ladder) {
      if (!V[n] || !V[n][sp]) continue;
      p(`| ${names[n] || n} | `, H.map((h) => { const s = get(n, sp, h); return s ? `${e4(s.llGain)}${ci4(s.ci && s.ci.llGain)}` : '–'; }).join(' | '), ' |');
    }
  }

  // 2. direction accuracy with coverage
  p(`\n**Direction right, non-overlapping calls** (%, 95% interval; "strong" = the stronger half by the rule in use, share of forecasts in brackets). ${R.coin}.\n`);
  for (const [sp, title] of SPLITS) {
    if (!get('v4', sp, '60')) continue;
    p(`\n*${title}*\n`);
    p('| System | ', H.map((h) => `${HN[h]} all calls | ${HN[h]} strong`).join(' | '), ' |');
    p('|---|', H.map(() => '---:|---:').join('|'), '|');
    for (const n of ['baseline momentum/reversal 30 d', 'refit, no learning', 'v4', 'selection policy', 'v4 + signal gate', 'final', 'v3 "confident" rule', 'v3 online layer']) {
      if (!V[n] || !V[n][sp]) continue;
      p(`| ${names[n] || n} | `, H.map((h) => { const s = get(n, sp, h); if (!s) return '– | –'; return `${pc(s.accI)}${cipc(s.ci && s.ci.accI)} (${s.ni}) | ${s.sni ? `${pc(s.strongAccI)}${cipc(s.ci && s.ci.strongAccI)} (${pc(s.strongShare, 0)}%)` : '–'}`; }).join(' | '), ' |');
    }
  }

  // 3. direction candidates vs the incumbent
  p(`\n**Direction-model challengers: change in log loss against the incumbent** (×10⁻⁴ nats, negative = better, 95% paired week-block interval). ${R.coin}.\n`);
  const cands = Object.keys(V).filter((n) => n.startsWith('dir ')).concat(['selection policy', 'v4 + signal gate']);
  for (const [sp, title] of SPLITS) {
    if (!cands.some((n) => P[n] && P[n][sp])) continue;
    p(`\n*${title}*\n`);
    p('| Challenger | ', H.map((h) => HN[h]).join(' | '), ' |');
    p('|---|', H.map(() => '---:').join('|'), '|');
    for (const n of cands) if (P[n] && P[n][sp]) p(`| ${n.replace('dir ', '')} | `, H.map((h) => dci4(P[n][sp][h] && P[n][sp][h].dLogLoss)).join(' | '), ' |');
  }

  // 4. online-layer settings
  p(`\n**Online layer settings: change in log loss against v4** (×10⁻⁴ nats, negative = better). ${R.coin}.\n`);
  const settings = ['half-lives 7/14/30 d', 'half-lives 60/120/120 d', 'half-lives 210/450/450 d', 'v3 forgetting (per outcome)', 'calibration with intercept', 'calibration prior 500', 'calibration prior 8000'];
  for (const [sp, title] of SPLITS) {
    if (!settings.some((n) => P[n] && P[n][sp])) continue;
    p(`\n*${title}*\n`);
    p('| Setting | ', H.map((h) => HN[h]).join(' | '), ' |');
    p('|---|', H.map(() => '---:').join('|'), '|');
    for (const n of settings) if (P[n] && P[n][sp]) p(`| ${n} | `, H.map((h) => dci4(P[n][sp][h] && P[n][sp][h].dLogLoss)).join(' | '), ' |');
  }

  // 5. the shown price
  p(`\n**The shown price: error against "no change"** (skill in %, positive = better than no change; MAE / MSE). ${R.coin}.\n`);
  for (const [sp, title] of SPLITS) {
    const E = R.estimators[sp];
    if (!E) continue;
    p(`\n*${title}*\n`);
    const ks = Object.keys(E['60']);
    p('| Estimate | ', H.map((h) => `${HN[h]} MAE | ${HN[h]} MSE`).join(' | '), ' |');
    p('|---|', H.map(() => '---:|---:').join('|'), '|');
    for (const k of ks) p(`| ${k} | `, H.map((h) => (E[h] ? `${f1(E[h][k].maeSkill_pct, 3)} | ${f1(E[h][k].mseSkill_pct, 3)}` : '– | –')).join(' | '), ' |');
  }

  // 6. ranges
  p(`\n**The 80% range: coverage, width and interval score** (width and score in bp; lower score is better). ${R.coin}.\n`);
  for (const [sp, title] of SPLITS) {
    if (!get('v4', sp, '60')) continue;
    p(`\n*${title}*\n`);
    p('| System | ', H.map((h) => `${HN[h]} cover | width | score`).join(' | '), ' |');
    p('|---|', H.map(() => '---:|---:|---:').join('|'), '|');
    for (const n of ['v3 online layer', 'v4', 'v4 + evolution', 'hedge eta 0.05', 'hedge eta 0.8', 'ranges from past residuals', 'final', 'frozen + online', 'refit, no learning']) {
      if (!V[n] || !V[n][sp]) continue;
      p(`| ${names[n] || n} | `, H.map((h) => { const s = get(n, sp, h); return s ? `${pc(s.cov[1])} | ${f1(s.width_bp[1], 0)} | ${f1(s.iscore_bp[1], 1)}` : '– | – | –'; }).join(' | '), ' |');
    }
  }

  // 7. policy choices
  if (R.policy) {
    p(`\n**What the sequential selection chose** (${R.coin}; from = first day of each choice).\n`);
    for (const [per, ch] of Object.entries(R.policy)) for (const h of H) if (ch[h]) p(`- ${per} ${HN[h]}: ${ch[h].map((c) => `${c.from} ${c.choice}`).join(' → ')}`);
  }
}
console.log(out.join('\n'));
