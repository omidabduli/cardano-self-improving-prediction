# ADAptive: a self-correcting Cardano price forecast, checked in public

[![Learn & publish](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml/badge.svg)](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml)

**Live: https://omidabduli.github.io/cardano-self-improving-prediction/**

Every 15 minutes ADAptive estimates the price of Cardano (ADA/USDT) **1 hour, 3 hours and 24 hours ahead**: a price, an 80% range and a probability that it will be higher. Each forecast is written down before the outcome is known, then scored in public. The system learns from every result and re-tunes itself every day.

There is no server and no external timer. Your browser runs the model on the live Binance stream and computes every forecast and every score up to the current minute. GitHub Actions is the notary: a few times a day, whenever GitHub's scheduler gets to it, it replays every minute since its last run with **the same code**, commits the forecasts and results to this repository, and once a day it evolves and retrains the models. Because each forecast is a fixed function of the published model and public market data, the browser and the record agree to the last digit.

## The honest part

Nobody can reliably call the direction of a liquid market hours ahead, and ADAptive does not pretend to. Before this version launched, the whole system was tested walk-forward on 300 days of data (every day refit on earlier data only):

- **Direction:** every combination of signals tried (trend, Bitcoin, Ethereum, order flow, activity, time of day, futures funding, Fear & Greed) called the 1 h / 3 h / 24 h direction between 48% and 54% of the time: noise around a coin flip. Once the models are regularised enough to stop overfitting, they correctly say "about 50%".
- **Price estimate:** with no reliable direction, the best estimate is close to the current price. The chosen setup is about as accurate as "no change" (typical miss 0.54% at 1 h, 0.93% at 3 h, 2.9% at 24 h), and not worse, which several earlier variants were.
- **Range:** this is what can be forecast honestly. How far ADA is likely to move is predictable, and the 50/80/95% ranges held 50/80/95% of the time.

The page shows exactly this, with the live record next to it. If a real edge appears, the ensemble and the daily evolution are built to find it, and the record will show it. **This is a public experiment, not financial advice.**

## How it learns

| Loop | When | What changes |
|---|---|---|
| **Hedge ensemble** | every result | Each expert's trust weight = exp(−η · its discounted recent error). Experts that forecast well gain influence. |
| **Adaptive conformal inference** | every result | Each range widens after a miss and narrows after a hit until it covers exactly 50 / 80 / 95% of outcomes. |
| **Online logistic calibration** | every result | Maps the ensemble's signal to an honest P(up), so "55%" really means 55%. It learns a slope only, with no up/down bias, so calls never simply follow the recent trend. |
| **Evolution** | daily, 00:00 UTC | Champion vs. challenger tournament over regularisation, training window, signal groups and tree settings, scored walk-forward on the last 10 unseen days. A challenger (or the launch settings) replaces the champion only if its day-by-day lead is consistent (t ≥ 3, which roughly accounts for trying ~10 challengers). Then every expert is retrained on fresh data. |

Consecutive 24-hour outcomes overlap almost completely, so a training window holds far fewer independent daily results than hourly ones. Regularisation therefore scales with the horizon: ridge penalty × h/60, and for the trees a learning rate × √(60/h) and a larger minimum leaf. Targets are standardised by recent volatility (an equal blend of 1 h, 6 h, 24 h and 3-day realised variance), and the ranges are centred on the experts' view, never on the recent drift.

### The experts

| Expert | Model | Signals |
|---|---|---|
| The Skeptic | always predicts "no change" (the baseline) | none |
| Trend Reader | ridge regression | momentum/reversal from 15 min to 3 days, position in the recent range, distance from VWAP |
| Market Watcher | ridge regression | Bitcoin and Ethereum moves and how far ADA lags behind them |
| Crowd Reader | ridge regression | taker buy/sell pressure, trading activity, the daily Fear & Greed index |
| Linear Brain | ridge regression, evolved daily | the signal groups evolution picked (at launch: price, Bitcoin, Ethereum, range) |
| Boosted Forest | gradient-boosted trees, evolved daily | the same, for non-linear patterns |

Everything, including the gradient-boosting library, is written from scratch in dependency-free JavaScript (`site/core/`), so the exact same code runs in Node (GitHub Actions) and in the browser.

## Integrity of the record

- A forecast issued at time *t* uses a model trained only on data from before *t*, plus candles and sentiment values that were public at *t*.
- Models, online-learning checkpoints and every forecast are committed to git with timestamps (`data/`).
- Anyone can reproduce the record: replay a checkpoint with `site/core/engine.js` on Binance's public 1-minute candles and the published Fear & Greed values.
- The first record (5, 15 and 60-minute forecasts, 22–25 September 2026) is kept unchanged in `data/archive/v1-minutes/`.

## Data files (`data/`)

| File | Content | Updated |
|---|---|---|
| `predictions/YYYY-MM-DD.csv` | one row per forecast (every 15 min): close, and per horizon: predicted log-return (bp), P(up), 80% range (bp) | every run |
| `state.json` | online-learning checkpoint (ensemble weights, range multipliers, calibration, pending forecasts) | every run |
| `model.json` | all six experts' parameters, including every tree of the forest | daily |
| `evolution.json` | every generation's tournament results and winning configs | daily |
| `daily/YYYY-MM.json` | per-day scores and 6-hourly snapshots of the ensemble | every run |
| `fng.json` | the last 30 days of the Fear & Greed index as the record used it | every run |
| `status.json` | last run, totals, file index | every run |
| `backtest.json` | the 30-day launch backtest (simulated, clearly separated from the live record) | once |

Time stamps are UTC candle open times. A forecast at `time` is issued when that minute's candle closes (so the `14:29` row is the 14:30 forecast). The *h*-minute forecast is checked against the close of the candle *h* minutes later.

## Run it yourself

Requires Node.js ≥ 22. No dependencies.

```bash
npm test                              # unit tests (causality, model parity, online learners)
node engine/run.mjs --bootstrap       # fetch ~107 days, train, simulate 30 days (~3 min)
node engine/run.mjs                   # a normal run: replays everything since the last one
node engine/serve.mjs                 # preview on http://localhost:8787
```

To run your own copy: fork the repository, set **Settings → Pages → Source: GitHub Actions**, and enable the workflow.

## Project layout

```
site/            static site served by GitHub Pages
  core/          shared engine: features, models, online learner, scoring (browser + Node)
  assets/        UI: live feed, SVG chart, app
engine/          Node-only: data fetching, training, gradient boosting, evolution, pipeline
data/            the public record (committed by the workflow)
test/            unit tests
.github/workflows/pipeline.yml   the learn & publish job (GitHub's own schedule)
```

## Credits and disclaimer

Market data: Binance public market-data API (`data-api.binance.vision`), no key required. Sentiment: the Crypto Fear & Greed Index by [alternative.me](https://alternative.me/crypto/fear-and-greed-index/). ADAptive is not affiliated with Cardano, IOG, the Cardano Foundation, EMURGO, Binance or alternative.me. Nothing here is financial advice.

MIT licensed.
