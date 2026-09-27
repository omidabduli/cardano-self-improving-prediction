#!/usr/bin/env node
// Apply the rules fixed in docs/EXPERIMENTS.md ("Rules fixed before looking at any Stage 2
// result") to the Stage 2 results of both coins, mechanically, and print the decisions.
//   node research/decide.mjs research/results/stage2-btc.json research/results/stage2-ada.json
import fs from 'node:fs';

const [btcFile, adaFile] = process.argv.slice(2);
const btc = JSON.parse(fs.readFileSync(btcFile, 'utf8'));
const ada = JSON.parse(fs.readFileSync(adaFile, 'utf8'));
const TIE = 5e-5;
const LN2 = Math.LN2;

const ll = (R, name, split, h) => { const s = R.variants[name] && R.variants[name][split] && R.variants[name][split][h]; return s ? s.logloss : null; };
const pooled = (R, name, split, hs = ['60', '180']) => { const v = hs.map((h) => ll(R, name, split, h)); return v.every((x) => x !== null) ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const f = (x) => (x === null ? '–' : (x * 1e4).toFixed(2));
const out = [];
const say = (...a) => out.push(a.join(''));

// rule 2: not worse on P0 for either coin
function passesP0(name, base, hs = ['60', '180']) {
  const rows = [];
  let ok = true;
  for (const [coin, R] of [['BTC', btc], ['ADA', ada]]) {
    const a = pooled(R, name, 'untouched', hs), b = pooled(R, base, 'untouched', hs);
    if (a === null || b === null) { rows.push(`${coin} P0 n/a`); ok = false; continue; }
    rows.push(`${coin} P0 ${f(a - b)}e-4`);
    if (a - b > TIE) ok = false;
  }
  return { ok, detail: rows.join(', ') };
}

function pick(title, names, def, hs = ['60', '180']) {
  const scores = names.map((n) => [n, pooled(btc, n, 'tuning', hs)]).filter(([, v]) => v !== null);
  const d = scores.find(([n]) => n === def);
  let best = scores.reduce((a, b) => (b[1] < a[1] ? b : a));
  say(`\n## ${title}\nBitcoin tuning, log loss pooled over ${hs.map((h) => h / 60 + ' h').join(' + ')} (×10⁻⁴ nats, relative to ${def}):`);
  for (const [n, v] of scores) say(`  ${n}: ${f(v - d[1])}`);
  if (d[1] - best[1] < TIE) { say(`→ keep ${def} (no candidate better by ${TIE})`); return def; }
  const g = passesP0(best[0], def, hs);
  say(`best: ${best[0]} (${f(best[1] - d[1])}); P0 gate: ${g.detail} → ${g.ok ? 'passes' : 'fails'}`);
  const choice = g.ok ? best[0] : def;
  say(`→ ${choice}`);
  return choice;
}

const decisions = {};
decisions.forgetting = pick('Forgetting (rule 3)', ['half-lives 7/14/30 d', 'v4', 'half-lives 60/120/120 d', 'half-lives 210/450/450 d', 'v3 forgetting (per outcome)'], 'v4');
decisions.intercept = pick('Calibration intercept (rule 4)', ['v4', 'calibration with intercept'], 'v4') !== 'v4';
decisions.plattPrior = pick('Calibration prior (rule 4)', ['calibration prior 500', 'v4', 'calibration prior 8000'], 'v4');

// rule 10: the ranges (Hedge learning rate, residual shapes), by the 80% interval score pooled
// over 1 h and 3 h on Bitcoin tuning; P0 gate the same way
function pickRanges(title, names, def) {
  const sc = (R, n, sp) => { const v = ['60', '180'].map((h) => R.variants[n] && R.variants[n][sp] && R.variants[n][sp][h] && R.variants[n][sp][h].iscore_bp[1]); return v.every((x) => Number.isFinite(x)) ? (v[0] + v[1]) / 2 : null; };
  const d = sc(btc, def, 'tuning');
  say(`\n## ${title}\nBitcoin tuning, 80% interval score pooled over 1 h + 3 h (bp, relative to ${def}; lower is better):`);
  let best = [def, d];
  for (const n of names) { const v = sc(btc, n, 'tuning'); say(`  ${n}: ${v === null ? '–' : (v - d).toFixed(3)}`); if (v !== null && v < best[1]) best = [n, v]; }
  if (d - best[1] < 0.05) { say(`→ keep ${def} (nothing better by 0.05 bp)`); return def; }
  const p0 = [btc, ada].map((R) => { const a = sc(R, best[0], 'untouched'), b = sc(R, def, 'untouched'); return a !== null && b !== null ? a - b : null; });
  const ok = p0.every((x) => x !== null && x <= 0.05);
  say(`best: ${best[0]}; P0: BTC ${p0[0]?.toFixed(3)}, ADA ${p0[1]?.toFixed(3)} → ${ok ? best[0] : def}`);
  return ok ? best[0] : def;
}
decisions.ranges = pickRanges('Ranges (rule 10)', ['hedge eta 0.05', 'hedge eta 0.8', 'ranges from past residuals'], 'v4');

// rule 5: 24 hours
{
  say('\n## 24 hours (rule 5)');
  const all = ['60', '180', '1440'];
  const gT = pooled(btc, 'v4 + signal gate', 'tuning', all), vT = pooled(btc, 'v4', 'tuning', all);
  const gateBetter = gT !== null && vT - gT >= TIE;
  const gP0 = passesP0('v4 + signal gate', 'v4', all);
  const gateOk = gateBetter && gP0.ok;
  say(`signal gate: Bitcoin tuning, pooled over all horizons ${f(gT - vT)}e-4 (needs <= -${TIE * 1e4}e-4); P0 gate: ${gP0.detail} → ${gateOk ? 'qualifies' : 'does not qualify'}`);
  const gain = (R, sp) => { const s = R.variants.v4[sp] && R.variants.v4[sp]['1440']; return s ? s.llGain : null; };
  const g = [gain(btc, 'tuning'), gain(btc, 'untouched'), gain(ada, 'untouched')];
  const fixedOk = g.every((x) => x !== null && x <= 0);
  say(`no signal at 24 h: v4's 24 h log-loss gain over a coin: BTC tuning ${f(g[0])}e-4, BTC P0 ${f(g[1])}e-4, ADA P0 ${f(g[2])}e-4 (all must be <= 0) → ${fixedOk ? 'qualifies' : 'does not qualify'}`);
  let choice = 'keep 24 h calls';
  if (gateOk && fixedOk) {
    const d = ll(btc, 'v4 + signal gate', 'tuning', '1440') - LN2;
    choice = d > TIE ? 'no signal at 24 h' : 'signal gate';
    say(`both qualify; gate vs. fixed at 24 h on Bitcoin tuning: ${f(d)}e-4`);
  } else if (gateOk) choice = 'signal gate';
  else if (fixedOk) choice = 'no signal at 24 h';
  say(`→ ${choice}`);
  decisions.h24 = choice;
}

// rule 6: direction model
{
  say('\n## Direction model (rule 6)');
  const pT = pooled(btc, 'selection policy', 'tuning'), vT = pooled(btc, 'v4', 'tuning');
  const pP0 = passesP0('selection policy', 'v4');
  const polOk = pT !== null && vT - pT >= TIE && pP0.ok;
  say(`selection rule: Bitcoin tuning ${f(pT - vT)}e-4 (needs <= -${TIE * 1e4}e-4); P0 gate: ${pP0.detail} → ${polOk ? 'adopt' : 'no'}`);
  decisions.policy = polOk;
  decisions.challengers = {};
  for (const h of ['60', '180', '1440']) {
    const inc = ll(btc, 'v4', 'tuning', h);
    const wins = [];
    for (const n of Object.keys(btc.variants).filter((k) => k.startsWith('dir '))) {
      const t = ll(btc, n, 'tuning', h);
      const p0 = [btc, ada].map((R) => { const a = ll(R, n, 'untouched', h), b = ll(R, 'v4', 'untouched', h); return a !== null && b !== null ? a - b : null; });
      const ok = t !== null && inc - t >= 1e-4 && p0.every((x) => x !== null && x < 0);
      say(`  ${h / 60} h ${n.slice(4)}: tuning ${f(t - inc)}e-4, P0 BTC ${f(p0[0])}e-4, ADA ${f(p0[1])}e-4${ok ? '  ← qualifies' : ''}`);
      if (ok) wins.push([n.slice(4), t]);
    }
    if (wins.length) decisions.challengers[h] = wins.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
  }
  say(`→ ${polOk ? 'sequential selection' : Object.keys(decisions.challengers).length ? 'replace per horizon: ' + JSON.stringify(decisions.challengers) : 'keep the incumbent'}`);
}

// rule 7: the shown price
{
  say('\n## The shown price (rule 7)');
  let ok = true;
  for (const [coin, R] of [['BTC', btc], ['ADA', ada]]) for (const h of ['60', '180']) {
    const e = R.estimators.untouched && R.estimators.untouched[h] && R.estimators.untouched[h]['implied, shrunk (v4)'];
    say(`  ${coin} P0 ${h / 60} h: MSE skill ${e ? e.mseSkill_pct.toFixed(4) : '–'}%`);
    if (!e || e.mseSkill_pct < 0) ok = false;
  }
  say(`→ ${ok ? 'keep the shrunk implied move' : 'show "no change"'}`);
  decisions.shownPrice = ok ? 'shrunk' : 'no change';
}

// rule 9: evolution
{
  say('\n## Evolution (rule 9)');
  let worseEverywhere = true, any = false;
  for (const [coin, R] of [['BTC', btc], ['ADA', ada]]) for (const sp of ['untouched', 'tuning']) {
    const e = R.variants['v4 + evolution'] && R.variants['v4 + evolution'][sp], v = R.variants.v4[sp];
    if (!e) { say(`  ${coin} ${sp}: no evolution run`); worseEverywhere = false; continue; }
    any = true;
    const d = ['60', '180', '1440'].map((h) => e[h].iscore_bp[1] - v[h].iscore_bp[1]);
    say(`  ${coin} ${sp}: 80% interval score, evolution minus fixed (bp): ${d.map((x) => x.toFixed(2)).join(' / ')}`);
    if (!(d.reduce((a, b) => a + b, 0) > 0)) worseEverywhere = false;
  }
  decisions.evolution = !(any && worseEverywhere);
  say(`→ ${decisions.evolution ? 'keep the daily evolution' : 'stop the daily evolution'}`);
}

say('\n## Decisions\n' + JSON.stringify(decisions, null, 1));
console.log(out.join('\n'));
