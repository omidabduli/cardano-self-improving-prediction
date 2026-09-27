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

Every 15 minutes (at :00, :15, :30 and :45 UTC) it says how likely ADA is to be higher in 1 hour and in 3 hours, and gives its best estimate of the price. At 24 hours it makes no call, for reasons below. Every forecast goes into a public record in this repository. Each row says when it was computed, and whether that was on time or filled in later after a missed run. Only the on-time ones count in the score.

There is no server. When you open the page, your browser runs the published model on the live Binance feed and computes every forecast up to the current minute. A GitHub Actions job is the notary: every 15 minutes it replays the same minutes with the same code and commits the official record. GitHub's own timer only fires a few times a day, so a free [cron-job.org](https://cron-job.org) job starts it at minute 1, 16, 31 and 46 of every hour. The browser and the record use the same code, so they give the same numbers.

## What I found (the realistic part)

Before launching the second version I tested it on 300 days of history, walking forward day by day and only ever training on the past:

- **Direction was a coin flip.** Every combination of signals I tried (ADA's own trend, Bitcoin, Ethereum, order flow, trading activity, time of day, futures funding, the Fear & Greed index) called the 1 h, 3 h and 24 h direction right between 48% and 54% of the time. That is noise.
- **The price estimate was about as good as "no change".**
- **The range was the part that worked.** How far ADA is likely to move *is* predictable. The 50%, 80% and 95% ranges held 50%, 80% and 95% of the time.

Then, working on the Bitcoin version, I found one idea that changed the direction result: **train a model only on whether the price went up or down, not on by how much.** I chose its settings on Bitcoin and used them here without changing anything.

In September 2026 I asked someone to review both projects, and the review was right on every point:
- The page showed a different price from the one that was scored.
- The system forgot fifteen times more slowly than I had written down.
- Nothing proved that a forecast had been published before its outcome was known.

I fixed all of it (more on that below). Then I tested the direction model on a year neither project had ever used for anything, 24 September 2024 to 23 September 2025:

| Cardano, the untouched year | 1 hour | 3 hours | 24 hours |
|---|---|---|---|
| Strong-signal calls right | **54.3%** of 4,348 | **54.3%** of 1,476 | no call |
| All calls right | 53.1% of 7,173 | 53.0% of 2,273 | no call |
| 95% range, all calls | 52.0 to 54.1% | 51.1 to 54.7% | |

A strong-signal call is one whose signal is at least the median of the last 7 days of forecasts, so about half of them. Only calls that don't overlap are counted, one per hour or one per 3 hours. The ranges come from resampling whole weeks, because neighbouring hours share the same market. On Bitcoin's untouched year the same system did a bit better: 55.6% at 1 hour and 56.4% at 3 hours on strong-signal calls.

Patterns fade, and Cardano shows it. From May to September 2026 the 3-hour calls were no better than a coin (48.8% of all calls), while the 1-hour ones held up a little (53.2% on strong-signal calls).

Two things didn't survive the test at all:
- **24 hours.** The 24-hour direction model was right less than half the time in every period, on both coins. So the page makes no call at 24 hours. The model keeps running in the background, and the record will show if that changes.
- **The price.** No formula for the size of the move beat simply today's price, not even the careful ones. So the price estimate on the page is today's price, and what the model adds is the direction.

The "past-year test" on the page replays the whole system, with these settings and the daily evolution, over the twelve months before the live record began (27 September 2025 to 26 September 2026): 53.9% on strong-signal calls at 1 hour and 54.3% at 3 hours (52.2% and 52.0% of all calls). Those months were looked at during the review, so treat it as a check that the system runs as described, not as an untouched test.

I could have hidden all this and shown a nice accuracy number. I think that would go against the whole point. The page shows the real score, and it counts only forecasts that don't overlap, so a single lucky move isn't counted a hundred times. That is a Taleb lesson too: don't let luck look like skill. This is an experiment, not financial advice.

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

Next to them sits the **direction model**: a ridge regression and gradient-boosted trees trained only on whether the price went up or down, on all 55 signals and the last 240 days. It decides the call and its probability. The experts set the 50%, 80% and 95% ranges, which the page doesn't show but the record keeps and scores. I found the direction idea on Bitcoin, in the sister project [Bitcast](https://github.com/omidabduli/bitcoin-self-improving-prediction), and use its settings here unchanged.

After every result, a few things happen:

1. Experts that were closer to reality get more trust, and the others get less (a Hedge ensemble).
2. A range that missed gets wider, and one that held gets narrower, until each holds as often as it promises (adaptive conformal inference).
3. The stated probabilities are recalibrated, so "55%" really means 55%. It only learns how strong the signal is, never an up or down bias, so it can't just follow the recent trend.
4. Once a day at 00:00 UTC every model is retrained, and mutated settings challenge the current ones on the last ten days they haven't seen. A challenger only wins if its lead is clear and consistent. In testing, my first rule changed settings on 38 of 50 days and did worse than never changing at all. Being flexible doesn't mean reacting to every bit of noise.

All of this forgets by time. Up to v3 the memory was supposed to halve in 14 and 30 days, but because of a bug it really took about 210 and 450 days. When I fixed the clock and tried the short memory I had meant, the forecasts got worse. So the system keeps the long memory, now written down honestly.

Two things run in the background without being shown, so they can be tested on the live record: the 24-hour direction model, and a shrunk version of the price move implied by the call.

A few details that mattered more than I expected:

- 24-hour outcomes that are 15 minutes apart are almost the same outcome. So the longer the horizon, the harder the models are held back.
- Volatility is estimated from an equal mix of the last 1 hour, 6 hours, 24 hours and 3 days. That gave the sharpest ranges that still held.
- A missing candle is never treated as a real price. A forecast is only made when all three coins have real data, and an outcome that lands on a gap isn't scored.

Everything is written from scratch in plain JavaScript with no dependencies, including the gradient boosting. The same files in `site/core/` run in the browser and in GitHub Actions, and every shared file is identical in this project and in Bitcast.

## What the September 2026 review changed

The review is summarised in [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md), together with every test I ran because of it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes how the system works now. In short:

- What the page shows is exactly what the record stores and what gets scored.
- Every record row says when it was computed, from which model and which code, and whether it was on time. `research/verify-record.mjs` checks that against the git history.
- Missing data can't turn into fake outcomes, and a broken checkpoint stops the pipeline instead of quietly writing zeros.
- I wrote down the rules for every decision before I looked at any result. The year before the tuning period was only used as a final check.

## The record

Everything lives in `data/` and is committed by the bot:

| File | What's in it |
|---|---|
| `predictions/YYYY-MM-DD.csv` | one row per forecast: when and how it was made, and for each horizon the shown price, P(up), the call, strong signal, and the background values (the model's own P(up), the shrunk move, the experts' move, the 80% range) |
| `state.json` | the learning checkpoint: trust weights, range sizes, calibration, forecasts still waiting |
| `model.json` | every model, including every tree |
| `evolution.json` | every daily tournament and the settings that won |
| `daily/YYYY-MM.json` | scores per day (on-time forecasts and filled-in ones apart) and snapshots of what the system has learned |
| `fng.json` | the Fear & Greed values exactly as the record used them, with when each was first seen |
| `status.json` | the last run, its health, totals and a file index |
| `backtest.json`, `backtest/YYYY-MM.csv` | the one-year walk-forward backtest: scores per day and every forecast with its outcome |
| `warmup.json` | the 30-day warm-up simulation from launch |
| `archive/` | earlier records, unchanged |

A forecast made at time *t* only uses models trained before *t* and data that was public at *t*. Times are UTC candle open times, so the `14:29` row is the forecast issued when that candle closed, at 14:30.

The first version predicted 5, 15 and 60 minutes ahead (22 to 25 September 2026). In backtests it had a small edge at 5 minutes and almost none at 60. Live, over three days, even the 5-minute edge was hard to tell apart from a coin flip. I kept that record untouched in `data/archive/v1-minutes/`. The second version (25 to 26 September 2026) showed a price estimate and an 80% range but took its direction from the ensemble, which was a coin flip. Its record is in `data/archive/v2-ranges/`. The third (26 to 27 September 2026) had the direction model before the review; its record is in `data/archive/v3-direction/`.

## Run it yourself

You need Node.js 22 or newer. No packages to install.

```bash
npm test                              # unit tests: no look-ahead, the fixes from the review, the online learners
node engine/run.mjs --bootstrap       # fetch ~290 days, train, simulate 30 days (about 5 minutes)
node engine/backtest.mjs --evolve     # the one-year backtest (downloads Binance archive files, ~1.5 hours)
node engine/run.mjs                   # a normal run: replays everything since the last one
node engine/serve.mjs                 # preview on http://localhost:8787
node research/verify-record.mjs       # check the record against the git history
```

The evaluation behind the settings is in `research/` and takes a few hours. The commands are in [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md).

To run your own copy, fork the repo, set **Settings → Pages → Source** to **GitHub Actions**, and enable the workflow.

```
site/            the static site on GitHub Pages
  core/          the shared engine: signals, models, online learning, scoring
  assets/        the page: live feed, chart, app
engine/          Node only: data fetching, training, boosting, evolution, the pipeline
research/        the evaluation: baseline, walk-forward stages, decisions, record check
docs/            how it works, and the experiments
data/            the public record
test/            unit tests
```

## Credits

Market data comes from Binance's public API (`data-api.binance.vision`) and the Crypto Fear & Greed Index from [alternative.me](https://alternative.me/crypto/fear-and-greed-index/). This project isn't affiliated with Cardano, IOG, the Cardano Foundation, EMURGO, Binance or alternative.me.

MIT licensed. Made by Omid Abduli.
