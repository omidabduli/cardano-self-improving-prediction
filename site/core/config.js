// Shared configuration. Imported by both the browser app and the Node pipeline,
// so every number that affects a prediction lives in exactly one place.

export const SYMBOL = 'ADAUSDT';
export const BTC_SYMBOL = 'BTCUSDT';
export const TICK = 0.0001; // Binance ADAUSDT price tick

export const MINUTE = 60_000;
export const DAY_MIN = 1440;

// Forecast horizons in minutes.
export const HORIZONS = [5, 15, 60];
export const MAX_H = 60;

// Central prediction intervals and the residual quantile levels that build them.
export const BANDS = [0.5, 0.8, 0.95];
export const Q_LEVELS = [0.025, 0.1, 0.25, 0.5, 0.75, 0.9, 0.975];
// index of [lo, hi] quantile inside Q_LEVELS for each band
export const BAND_Q = [[2, 4], [1, 5], [0, 6]];

// Standardised targets are clipped at this many "vol units" when learning.
export const Z_CLIP = 4;

// Online learning parameters.
export const ONLINE = {
  // Hedge (exponential weights) over the experts. Consecutive h-minute outcomes overlap, so
  // each resolution carries ~5/h of the evidence of a 5-minute one: eta is scaled by 5/h.
  hedgeEta: 0.05,
  hedgeRefH: 5,
  hedgeHalfLifeMin: 7 * DAY_MIN,
  lossCap: 16,
  // Adaptive conformal inference: step size per horizon for the log band multiplier.
  aciGamma: { 5: 0.01, 15: 0.01, 60: 0.005 },
  aciMin: -1.2,
  aciMax: 1.5,
  // Online logistic (Platt) calibration of P(up).
  plattHalfLifeMin: 5 * DAY_MIN,
  plattPrior: 400, // pseudo-observations anchoring the calibration at start
  plattAMax: 12,
  plattBMax: 0.06, // cap on learned up/down bias: recent drift is not a signal
};

// A call counts as "confident" when P(up) is at least this far from 50%.
export const STRONG_EDGE = 0.03;

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
