// Model inference. Each expert maps a feature row to a predicted standardised return
// (z units) for every horizon. Training lives in /engine (Node only); this file only
// needs to evaluate what the pipeline published in data/model.json.

import { HORIZONS } from './config.js';

export const EXPERTS = [
  { id: 'rw', name: 'The Skeptic', role: 'Random walk: always says "no change". The baseline every other expert must beat.', icon: 'skeptic' },
  { id: 'micro', name: 'Order-Flow Reader', role: 'Reads the last minutes of buying/selling pressure and bid-ask bounce.', icon: 'micro' },
  { id: 'btc', name: 'Bitcoin Watcher', role: 'Bets that ADA catches up with moves Bitcoin just made.', icon: 'btc' },
  { id: 'swing', name: 'Trend Surfer', role: 'Momentum and reversal over 5 minutes to 4 hours.', icon: 'swing' },
  { id: 'linear', name: 'Linear Brain', role: 'Regularised regression on all 36 signals. Its settings are evolved daily.', icon: 'linear' },
  { id: 'forest', name: 'Boosted Forest', role: 'Gradient-boosted decision trees that find non-linear patterns. Evolved daily.', icon: 'forest' },
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
