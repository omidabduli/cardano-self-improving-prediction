# ADAptive

[![Learn & publish](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml/badge.svg)](https://github.com/omidabduli/cardano-self-improving-prediction/actions/workflows/pipeline.yml)

**Live: https://omidabduli.github.io/cardano-self-improving-prediction/**

Every 15 minutes this project writes down where it thinks the Cardano (ADA) price will be in 1 hour, 3 hours and 24 hours. Then it waits, checks, and keeps the score in public.

## Why I built this

I love prediction. Nassim Taleb changed how I look at the world. He taught me that most of what happens is more random than we like to admit, and that we are very good at fooling ourselves after the fact. Ray Dalio says you have to be a hyperrealist. I agree with both, and I think prediction is where the two meet.

To predict something you have to be realistic. You have to look at how things actually work, not how you wish they worked. Even then you will be wrong a lot. But every time you check a prediction against what really happened, you learn a bit more about reality. That makes the next prediction a little closer, and it makes you a more realistic person. I think being realistic is directly connected to being happy: you understand the world better, you expect the right things, and you keep wanting to understand more.

The other part is flexibility. If you can't change your mind, you get crushed. So I didn't want a model that I train once and admire. I wanted one that is forced to face every result and adjust itself, every day, in public.

And honestly, there is a joy in it that is hard to describe. When you build a model of the future and the future comes out close to it, it feels like you understood something real. That feeling is the reason for this whole project.

## What it does

Every 15 minutes (at :00, :15, :30 and :45 UTC) it publishes three forecasts: ADA in 1 hour, 3 hours and 24 hours. Each one has a price, an 80% range and a probability that the price will be higher. Every forecast is committed to this repository before the outcome is known, and checked when its time comes.

There is no server. When you open the page, your browser runs the published model on the live Binance feed and computes every forecast and every score up to the current minute. A GitHub Actions job is the notary: every 15 minutes it replays the same minutes with the same code and commits the official record. GitHub's own timer only fires a few times a day, so a free [cron-job.org](https://cron-job.org) job starts it at minute 1, 16, 31 and 46 of every hour. I checked that the browser and the record give the same numbers, to the last digit.

## What I found (the realistic part)

Before launching this version I tested it on 300 days of history, walking forward day by day and only ever training on the past. This is what came out:

- **Direction is a coin flip.** Every combination of signals I tried (ADA's own trend, Bitcoin, Ethereum, order flow, trading activity, time of day, futures funding, the Fear & Greed index) called the 1 h, 3 h and 24 h direction right between 48% and 54% of the time. That is noise. Once the models are held back enough to stop overfitting, they say what they should say: about 50%.
- **The price estimate is about as good as "no change".** Typical misses are 0.54% at 1 hour, 0.93% at 3 hours and 2.9% at 24 hours. Some of my earlier versions were worse than simply saying "the price stays where it is", and I fixed that.
- **The range is the part that works.** How far ADA is likely to move *is* predictable. The 50%, 80% and 95% ranges held 50%, 80% and 95% of the time.

I could have hidden this and shown a nice accuracy number. I think that would go against the whole point. The page shows the real score, and it counts only forecasts that don't overlap, so a single lucky move isn't counted a hundred times. That is a Taleb lesson too: don't let luck look like skill.

If a real pattern shows up, the system is built to find it, and the record will show it. Until then, it is honest about what it doesn't know. This is an experiment, not financial advice.

## How it keeps adjusting

Six "experts" look at the market in different ways:

| Expert | What it looks at |
|---|---|
| The Skeptic | Nothing. It always says "no change". Everyone else has to beat it. |
| Trend Reader | ADA's momentum and reversals from 15 minutes to 3 days, and where the price sits in its recent range |
| Market Watcher | Moves in Bitcoin and Ethereum, and how far ADA lags behind them |
| Crowd Reader | Buying and selling pressure, trading activity and the daily Fear & Greed index |
| Linear Brain | A regularised regression on the signals that evolution picked |
| Boosted Forest | Gradient-boosted trees on the same signals, for non-linear patterns |

After every result, four things happen:

1. Experts that were closer to reality get more trust, and the others get less (a Hedge ensemble).
2. A range that missed gets wider, and one that held gets narrower, until each holds as often as it promises (adaptive conformal inference).
3. The stated probabilities are recalibrated, so "55%" really means 55%. It only learns how strong the signal is, never an up or down bias, so it can't just follow the recent trend.
4. Once a day at 00:00 UTC, mutated settings challenge the current ones on the last ten days they haven't seen. A challenger only wins if its lead is clear and consistent. In testing, my first rule changed settings on 38 of 50 days and did worse than never changing at all. Being flexible doesn't mean reacting to every bit of noise.

A few details that mattered more than I expected:

- 24-hour outcomes that are 15 minutes apart are almost the same outcome. So the longer the horizon, the harder the models are held back (ridge penalty × h/60, and slower, bigger-leaved trees).
- Volatility is estimated from an equal mix of the last 1 hour, 6 hours, 24 hours and 3 days. That gave the sharpest ranges that still held.
- The ranges are centred on what the experts think, never on the drift of the last few weeks. The old version followed that drift, and it made the 24-hour estimate worse than "no change".

Everything is written from scratch in plain JavaScript with no dependencies, including the gradient boosting. The same files in `site/core/` run in the browser and in GitHub Actions.

## The record

Everything lives in `data/` and is committed by the bot:

| File | What's in it |
|---|---|
| `predictions/YYYY-MM-DD.csv` | one row per forecast: the price, and for each horizon the predicted move (bp), P(up) and the 80% range (bp) |
| `state.json` | the learning checkpoint: trust weights, range sizes, calibration, forecasts still waiting |
| `model.json` | all six experts, including every tree of the forest |
| `evolution.json` | every daily tournament and the settings that won |
| `daily/YYYY-MM.json` | scores per day and snapshots of the ensemble |
| `fng.json` | the last 30 days of the Fear & Greed index, exactly as the record used it |
| `status.json` | the last run, totals and a file index |
| `backtest.json` | the 30-day simulation from launch, kept apart from the live record |

A forecast made at time *t* only uses models trained before *t* and data that was public at *t*. Times are UTC candle open times, so the `14:29` row is the forecast issued when that candle closed, at 14:30. Anyone can replay a checkpoint with `site/core/engine.js` and get the same numbers.

The first version predicted 5, 15 and 60 minutes ahead (22 to 25 September 2026). In backtests it had a small edge at 5 minutes and almost none at 60. Live, over three days, even the 5-minute edge was hard to tell apart from a coin flip. I kept that record untouched in `data/archive/v1-minutes/`.

## Run it yourself

You need Node.js 22 or newer. No packages to install.

```bash
npm test                              # unit tests: no look-ahead, model parity, the online learners
node engine/run.mjs --bootstrap       # fetch ~107 days, train, simulate 30 days (about 3 minutes)
node engine/run.mjs                   # a normal run: replays everything since the last one
node engine/serve.mjs                 # preview on http://localhost:8787
```

To run your own copy, fork the repo, set **Settings → Pages → Source** to **GitHub Actions**, and enable the workflow.

```
site/            the static site on GitHub Pages
  core/          the shared engine: signals, models, online learning, scoring
  assets/        the page: live feed, chart, app
engine/          Node only: data fetching, training, boosting, evolution, the pipeline
data/            the public record
test/            unit tests
```

## Credits

Market data comes from Binance's public API (`data-api.binance.vision`) and the Crypto Fear & Greed Index from [alternative.me](https://alternative.me/crypto/fear-and-greed-index/). This project isn't affiliated with Cardano, IOG, the Cardano Foundation, EMURGO, Binance or alternative.me.

MIT licensed. Made by Omid Abduli.
