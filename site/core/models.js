// Model inference. Each expert maps a feature row to a predicted standardised return
// (z units) for every horizon. Training lives in /engine (Node only); this file only
// needs to evaluate what the pipeline published in data/model.json.

import { HORIZONS } from './config.js';

export const EXPERTS = [
  { id: 'rw', name: 'The Skeptic', role: 'Random walk: always says "no change". The baseline every other expert must beat.', icon: 'skeptic' },
  { id: 'swing', name: 'Trend Reader', role: 'Momentum and reversal from 15 minutes to 3 days, and where the price sits in its recent range.', icon: 'swing' },
  { id: 'btc', name: 'Market Watcher', role: 'Bets that ADA catches up with moves Bitcoin and Ethereum just made.', icon: 'btc' },
  { id: 'crowd', name: 'Crowd Reader', role: 'Buying and selling pressure, trading activity and the crypto Fear & Greed index.', icon: 'micro' },
  { id: 'linear', name: 'Linear Brain', role: 'Regularised regression on the signal groups evolution picked (at launch: price, Bitcoin, Ethereum). Evolved daily.', icon: 'linear' },
  { id: 'forest', name: 'Boosted Forest', role: 'Gradient-boosted decision trees that look for non-linear patterns in the same signals. Evolved daily.', icon: 'forest' },
];
export const EXPERT_IDS = EXPERTS.map((e) => e.id);

export function ridgePredict(m, X, off) {
  let s = m.b;
  const { idx, mean, std, w } = m;
  for (let j = 0; j < idx.length; j++) {
    let v = (X[off + idx[j]] - mean[j]) / std[j];
    if (v > 5) v = 5; else if (v < -5) v = -5;
    s += w[j] * v;
  }
  return s;
}

export function gbdtPredict(m, X, off) {
  let s = m.base;
  const trees = m.trees;
  for (let k = 0; k < trees.length; k++) {
    const tr = trees[k];
    let node = 0;
    while (tr.f[node] >= 0) node = X[off + tr.f[node]] <= tr.t[node] ? tr.l[node] : tr.r[node];
    s += tr.v[node];
  }
  return s;
}

function predictOne(expert, h, X, off) {
  const p = expert.h ? expert.h[h] : null;
  switch (expert.kind) {
    case 'zero': return 0;
    case 'ridge': return ridgePredict(p, X, off);
    case 'gbdt': return gbdtPredict(p, X, off);
    default: throw new Error('unknown expert kind ' + expert.kind);
  }
}

/**
 * Evaluate all experts of a published model on feature row i.
 * @returns {Object<number, number[]>|null} per horizon: array of expert predictions (model.experts order)
 */
export function expertPredictions(model, X, D, i) {
  const off = i * D;
  for (let j = 0; j < D; j++) if (!Number.isFinite(X[off + j])) return null;
  const out = {};
  for (const h of HORIZONS) {
    const arr = new Array(model.experts.length);
    for (let e = 0; e < model.experts.length; e++) {
      let v = predictOne(model.experts[e], h, X, off);
      if (!Number.isFinite(v)) v = 0;
      arr[e] = Math.max(-3, Math.min(3, v));
    }
    out[h] = arr;
  }
  return out;
}

/**
 * Direction score of the published direction model on feature row i, per horizon, or null.
 * The model is trained on the sign of the move only (up or down), so a few huge swings can't
 * dominate it the way they dominate a model of the move's size. It is the average of a ridge
 * and a boosted-tree model, each scaled by its spread on its training window, so the score is
 * in "typical signal" units; |score| >= thr marks a confident call (thr = the median |score|
 * on the training window).
 * @returns {Object<number, {d: number, strong: boolean}>|null}
 */
export function directionScores(model, X, D, i) {
  const dm = model.direction;
  if (!dm) return null;
  const off = i * D;
  for (let j = 0; j < D; j++) if (!Number.isFinite(X[off + j])) return null;
  const out = {};
  for (const h of HORIZONS) {
    const m = dm.h[h];
    let d = 0.5 * (ridgePredict(m.ridge, X, off) / m.sa + gbdtPredict(m.gbdt, X, off) / m.sb);
    if (!Number.isFinite(d)) d = 0;
    d = Math.max(-5, Math.min(5, d));
    out[h] = { d, strong: Math.abs(d) >= m.thr };
  }
  return out;
}

