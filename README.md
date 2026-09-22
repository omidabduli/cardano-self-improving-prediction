# ADAptive: a self-improving Cardano price predictor

[![Learn & publish](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml/badge.svg)](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml)

**Live: https://omidabduli.github.io/cardano-self-improving-prediction/**

ADAptive forecasts the price of Cardano (ADA/USDT) **5, 15 and 60 minutes ahead**, every minute. Each forecast is written down before the outcome is known, then scored in public. The system learns from every result and evolves its own settings every day.

There is no server. GitHub Actions runs the model every 15 minutes and commits the results to this repository. GitHub Pages serves the site, and your browser runs **the same model code** on the live Binance stream, so the page is never more than a second behind the market.

## What you see on the page

- **Forecast cards**: probability of up/down, the median target and an 80% range for each horizon, with a live "winning/losing" check on the forecast that is about to resolve.
- **Live chart**: the price, a forward fan for the next hour (50/80/95% bands) and, behind the price, the band that was predicted *earlier* for each moment. The price should stay inside that band about 80% of the time.
- **Scoreboard and live verification**: direction accuracy, band coverage and "confident call" accuracy. A z-score measures skill against a coin flip using non-overlapping forecasts only.
- **The council**: six experts, their current votes and how much the ensemble trusts each one right now.
- **Daily evolution, learning curve and calibration**: how the system has changed over time.

## How it learns

| Loop | When | What changes |
|---|---|---|
| **Hedge ensemble** | every minute | Each expert's trust weight = exp(−η · its discounted recent error). Experts that forecast well gain influence. |
| **Adaptive conformal inference** | every minute | Each prediction band widens after a miss and narrows after a hit until it covers exactly 50 / 80 / 95% of outcomes. |
| **Online logistic calibration** | every minute | Maps the ensemble's signal to an honest P(up), so "55%" really means 55%. |
| **Evolution** | daily, 00:00 UTC | Champion vs. challenger tournament over regularisation, training window, feature groups and tree settings, scored walk-forward on the last 5 unseen days. Winners replace champions and every expert is retrained on fresh data. |

### The experts

| Expert | Model | Signals |
|---|---|---|
| The Skeptic | always predicts "no change" (the baseline) | none |
| Order-Flow Reader | ridge regression | candle position, VWAP distance, taker buy/sell imbalance, last 1–3 min returns |
| Bitcoin Watcher | ridge regression | BTC moves and how far ADA lags behind them |
| Trend Surfer | ridge regression | momentum/reversal over 5 min to 4 h, range position |
| Linear Brain | ridge regression, evolved daily | all 36 signals (the evolved subset) |
| Boosted Forest | gradient-boosted trees, evolved daily | all 36 signals (the evolved subset) |

Everything, including the gradient-boosting library, is written from scratch in dependency-free JavaScript (`site/core/`), so the exact same code runs in Node (GitHub Actions) and in the browser.

## The honest part

Short-term crypto prices are close to a random walk. In the launch backtest (14 days, walk-forward) the 5-minute direction accuracy was **52.1%** (z ≈ 2.9 on non-overlapping forecasts, 53.8% on confident calls). The 15- and 60-minute accuracies could not be told apart from a coin flip. The uncertainty bands, on the other hand, were almost exactly calibrated (49.9 / 80.0 / 95.0% coverage). Part of the short-horizon edge comes from market microstructure (bid-ask bounce) that could not be traded profitably after fees.

"Getting better every day" means the system keeps re-weighting, re-calibrating and re-evolving itself on fresh data. It does **not** mean accuracy will climb forever: markets change, and the live scoreboard shows whatever actually happens. **This is a public experiment, not financial advice.**

## Integrity of the record

- A forecast for minute *t* uses a model that was trained only on data from before *t*, plus candles up to *t*.
- Models, online-learning checkpoints and every forecast are committed to git with timestamps (`data/`).
- Anyone can reproduce the record: replay a checkpoint with `site/core/engine.js` on Binance's public 1-minute candles.

## Data files (`data/`)

| File | Content | Updated |
|---|---|---|
| `predictions/YYYY-MM-DD.csv` | one row per minute: close, and per horizon: predicted log-return (bp), P(up), 80% band (bp) | every run |
| `state.json` | online-learning checkpoint (ensemble weights, band multipliers, calibration, pending forecasts) | every run |
| `model.json` | all six experts' parameters, including every tree of the forest | daily |
| `evolution.json` | every generation's tournament results and winning configs | daily |
| `daily/YYYY-MM.json` | per-day scores and 6-hourly snapshots of the ensemble | every run |
| `status.json` | last run, totals, file index | every run |
| `backtest.json` | the launch backtest (simulated, clearly separated from the live record) | once |

Time stamps are UTC candle open times. A forecast at `time` is made when that minute's candle closes. The *h*-minute forecast is checked against the close of the candle *h* minutes later.

## Run it yourself

Requires Node.js ≥ 22. No dependencies.

```bash
npm test                              # unit tests (causality, model parity, online learners)
node engine/run.mjs --bootstrap       # fetch 68 days, evolve, train, warm up (~2-5 min)
node engine/run.mjs                   # a normal 15-minute step
node engine/serve.mjs                 # preview on http://localhost:8787
```

To run your own copy: fork the repository, set **Settings → Pages → Source: GitHub Actions**, and enable the workflow.

## Project layout

```
site/            static site served by GitHub Pages
  core/          shared engine: features, models, online learner, scoring (browser + Node)
  assets/        UI: live feed, canvas chart, SVG charts, app
engine/          Node-only: data fetching, training, gradient boosting, evolution, pipeline
data/            the public record (committed by the workflow)
test/            unit tests
.github/workflows/pipeline.yml   the 15-minute learn & publish job
```

## Credits and disclaimer

Market data: Binance public market-data API (`data-api.binance.vision`), no key required. ADAptive is not affiliated with Cardano, IOG, the Cardano Foundation, EMURGO or Binance. Nothing here is financial advice.

MIT licensed.
