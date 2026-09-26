// Shared configuration. Imported by both the browser app and the Node pipeline,
// so every number that affects a prediction lives in exactly one place. This is the only
// code file that differs between Bitcast (BTC) and its sister project ADAptive (ADA): every
// other file in site/core and engine is byte-identical in both repositories.

// Names and places for this coin (used in texts, the page and the pipeline).
export const ASSET = {
  brand: 'ADAptive',
  coin: 'ADA', // as written in sentences
  ticker: 'ADA',
  lead: 'Bitcoin',
  peer: 'Ethereum',
  repo: 'omidabduli/cardano-self-improving-prediction',
  sister: { brand: 'Bitcast', repo: 'omidabduli/bitcoin-self-improving-prediction' },
  userAgent: 'adaptive-predictor',
  // The direction model's settings were chosen on this coin's history up to this day (engine/
  // train.mjs DIRECTION); null = they were chosen on the sister project's coin.
  directionTunedUntil: null,
};

// The coin being forecast, and the two other large coins whose moves feed the "lead" and
// "peer" signal groups (feature ids rb*/re*, see features.js).
export const SYMBOL = 'ADAUSDT';
export const LEAD_SYMBOL = 'BTCUSDT';
export const PEER_SYMBOL = 'ETHUSDT';
export const TICK = 0.0001; // Binance ADAUSDT price tick
export const PRICE_DIGITS = 4; // decimals shown for a price

export const MINUTE = 60_000;
export const DAY_MIN = 1440;

// Forecast horizons in minutes (1 hour, 3 hours, 24 hours).
export const HORIZONS = [60, 180, 1440];
export const MAX_H = 1440;

// A new official forecast is issued every CADENCE minutes, at :00, :15, :30 and :45 UTC.
// It is made from the candle that closes at that moment (open time t, issued at t + 1 min).
export const CADENCE = 15;
export const isIssue = (t) => (Math.round(t / MINUTE) + 1) % CADENCE === 0;

// Central prediction intervals and the residual quantile levels that build them.
export const BANDS = [0.5, 0.8, 0.95];
export const Q_LEVELS = [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975];
// index of [lo, hi] quantile inside Q_LEVELS for each band
export const BAND_Q = [[2, 4], [1, 5], [0, 6]];

// Standardised targets are clipped at this many "vol units" when learning.
export const Z_CLIP = 4;

// Online learning parameters. Half-lives are wall-clock time: each learner remembers when it
// last learned (per horizon) and forgets by the time that has passed since, however many or
// few outcomes arrived in between. (Up to v3 the decay was applied once per outcome, i.e. every
// 15 minutes, while the half-lives were written in minutes: 14 "days" really lasted ~210 days.)
// The values below were chosen in the September 2026 evaluation (docs/EXPERIMENTS.md): faster
// forgetting made the probabilities worse, so v4 keeps v3's long memory, now stated honestly.
export const ONLINE = {
  // Hedge (exponential weights) over the experts. Forecasts come every CADENCE minutes, so
  // consecutive h-minute outcomes overlap and each carries ~CADENCE/h of an independent one:
  // eta is scaled by CADENCE/h.
  hedgeEta: 0.2,
  hedgeRefH: CADENCE,
  hedgeHalfLifeMin: 210 * DAY_MIN,
  lossCap: 16,
  // Adaptive conformal inference: step size per horizon for the log band multiplier.
  aciGamma: { 60: 0.02, 180: 0.01, 1440: 0.005 },
  aciMin: -1.2,
  aciMax: 1.5,
  // Online logistic (Platt) calibration of P(up).
  plattHalfLifeMin: 450 * DAY_MIN,
  plattPrior: 8000, // pseudo-observations anchoring the calibration
  plattAMax: 12,
  // The shrunk implied move (forecast.js): least squares of the actual move on the move
  // implied by P(up), prior = no change. Computed and recorded, but not shown (SHOW_MOVE).
  estHalfLifeMin: 450 * DAY_MIN,
  estPrior: 3,
  // Signal gate (per horizon): the direction model's own P(up) keeps being scored in the
  // background; it is shown only while its recent log loss beats a coin flip. Off: "no clear
  // direction" until it beats the coin by gateDelta nats per forecast; on: until it trails by
  // as much. Needs gateMinN (decayed) forecasts of evidence before it may switch. Not used in
  // production (it didn't pass the evaluation); its counters still measure every horizon.
  gate: false,
  gateHalfLifeMin: 45 * DAY_MIN,
  gateDelta: 3e-4,
  gateMinN: 500,
};

// Horizons shown as "no reliable signal": their direction model runs only in the background
// (its P(up) is scored by the gate counters, so it can be re-tested), and the page shows 50%.
// At 24 hours the direction model lost to a coin flip in every period tested.
export const SHADOW_HORIZONS = [1440];

// Show a price move at all? No price formula beat "no change" in the untouched year
// (docs/EXPERIMENTS.md, rule 7), so the shown price is today's price and the forecast is its
// direction. The shrunk implied move is still recorded (CSV column imp) to be re-tested.
export const SHOW_MOVE = false;

// P(up) closer to 50% than this is no call at all ("no clear direction"): it is shown as 50%
// and never counted as right or wrong.
export const NEUTRAL_EDGE = 0.005;

// "Strong signal": a call whose signal is at least the median of the last STRONG_WINDOW
// forecasts of the same horizon (7 days), i.e. about the stronger half of recent calls. It is
// judged only against earlier forecasts, never against outcomes, so it can't peek.
export const STRONG_WINDOW = 7 * DAY_MIN / CADENCE;
export const STRONG_MIN = DAY_MIN / CADENCE; // at least a day of history before any call is "strong"

// A forecast counts as published live when it was generated within this long after its candle
// closed; otherwise it is a replay (backfilled later) and is kept out of the live score.
export const LIVE_MAX_LAG_MIN = 30;

// Hosts tried in order. data-api.binance.vision is Binance's public market-data-only
// endpoint (works where the main API is geo-restricted).
export const REST_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api4.binance.com',
];
export const WS_HOSTS = [
  'wss://data-stream.binance.vision',
  'wss://stream.binance.com:9443',
];
