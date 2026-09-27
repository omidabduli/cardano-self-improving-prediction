# Experiments (September 2026 review)

In September 2026 an outside review of Bitcast and ADAptive raised a list of problems:
- the page showed a different price from the one that was scored;
- the online learners forgot about 15 times more slowly than configured;
- the published backtests didn't test the daily evolution;
- nothing proved that forecasts were published before their outcome;
- the data-gap handling and confidence labels were weak.

All of them held up against the code. This document records how I tested the fixes and
the changes to the models: the setup, the rules I fixed before looking at any result, the
results, and what went to production. [ARCHITECTURE.md](ARCHITECTURE.md) describes the system
as it is now.

## Setup

**Data.** Binance 1-minute candles from the monthly and daily archives on data.binance.vision
(Bitcoin with Ethereum and Solana, ADA with Bitcoin and Ethereum), plus the daily Fear & Greed
index from alternative.me. Every period below also uses the 253 days before it for training.

**Periods.**

| Name | Days | Status |
|---|---|---|
| P0 | 24 Sep 2024 – 23 Sep 2025 | untouched: no setting of either project was chosen on it |
| P12 tuning | 24 Sep 2025 – 24 May 2026 | the v3 direction settings were chosen on Bitcoin's part of it |
| P12 later | 25 May – 24 Sep 2026 | looked at during the review, so no longer an independent test |

**Stage 1** (`research/stage1.mjs`). Walks forward one UTC day at a time. Each day it refits
every model on data whose outcomes had all been seen before that day, using the same functions
as production, and records every model's raw output at every issue minute (every 15 minutes).
It records:
- the six return experts (settings GEN0, refit daily, and with the daily evolution as in
  production);
- five direction models (`DIRECTION_CANDIDATES` in `engine/train.mjs`);
- the incumbent direction model and the experts fitted once on the first day of the period
  and never again ("frozen").

**Stage 2** (`research/stage2.mjs`). Replays the online layer (`site/core/engine.js`) over
those outputs in every variant, so every variant is scored on exactly the same forecasts with
the same code as production. The scores are:
- log loss and Brier score of P(up);
- accuracy of calls on non-overlapping forecasts, with coverage;
- the shown price's error against "no change";
- the 80% range's coverage, width and interval score.

Uncertainty comes from a week-block bootstrap: 2000 resamples of whole weeks, for each score
and for each paired difference between variants. Neighbouring forecasts share market
conditions, so plain binomial intervals would be too narrow. Even non-overlapping calls are
not independent, and I don't treat them as if they were.

## Rules fixed before looking at any Stage 2 result

1. **Where choices are made.** On Bitcoin's P12 tuning part only, by log loss of P(up) pooled
   over 1 hour and 3 hours (the mean of the two). Differences under 0.00005 nats per forecast
   count as ties and keep the default.
2. **The gate.** A change that goes to production must also not be worse on P0, for either
   coin, by more than 0.00005 nats pooled over the same horizons. After that P0 is no longer
   untouched for the final configuration, and the live record becomes the only clean test.
3. **Forgetting.** Hedge / calibration / shrinkage half-lives of 7/14/30, 14/30/60 (the
   default), 60/120/120 and 210/450/450 days, and v3's once-per-outcome decay.
4. **Calibration.** With or without a learned up/down intercept, and with a prior of 500, 2000
   (the default) or 8000 pseudo-observations.
5. **24 hours.** v3's 24-hour direction calls were right less than half the time. Two remedies
   compete. The signal gate (`ONLINE.gate`) is judged on the log loss pooled over all three
   horizons, and must improve it by at least 0.00005 on Bitcoin tuning and pass rule 2. The
   fixed choice "no signal at 24 hours" goes to production if v4's 24-hour log-loss gain is
   ≤ 0 on Bitcoin tuning and on P0 for both coins. If both qualify, the gate wins unless it is
   worse than the fixed choice at 24 hours by more than 0.00005.
6. **Direction model.** The incumbent (ridge + boosted trees on the sign of the move, 240
   days) against four challengers, the two halves of the incumbent alone, a stacked blend with
   weights fitted on the last 60 days of matured forecasts, and a sequential selection rule.
   - **The selection rule**, each day and per horizon, uses the candidate with the lowest log
     loss over the last 90 days of matured forecasts. It switches only for a gain of at least
     0.0003 nats and falls back to "no signal" when the choice trails a coin by that much. It
     uses the incumbent for the first 60 days.
   - **The selection rule** goes to production only if it improves pooled 1 h + 3 h log loss on
     Bitcoin tuning by at least 0.00005 and passes rule 2.
   - **A single challenger** replaces the incumbent only if it beats it on Bitcoin tuning by at
     least 0.0001 nats in that horizon, and on P0 for both coins.
7. **The shown price.** The shrunk implied move (v4) was chosen from first principles. Four
   alternatives are reported next to it: no change, v3's unshrunk implied move, the experts'
   ensemble, and the median implied by P(up). If v4's price is worse than "no change" on P0
   under squared error at 1 hour or 3 hours, the page shows "no change" instead.
8. **Strong signal.** v4's rule: at least the median of the same horizon's last 7 days of
   forecasts. v3's rule (the model's training-window median) is reported next to it. The
   choice doesn't depend on the result, because v3's rule compares with in-sample scores.
9. **Evolution.** Production keeps the daily evolution of the return experts unless it makes
   the 80% interval score worse on P0 and on P12 tuning for both coins. It doesn't touch
   P(up), so it can only affect the ranges and the ensemble move.
10. **Ranges.** The Hedge learning rate (0.05, 0.2 = the default, 0.8) and range shapes taken
    from past out-of-sample residuals (instead of past returns) are judged by the 80% interval
    score pooled over 1 hour and 3 hours on Bitcoin tuning. They need a gain of at least 0.05
    bp, and must not be worse on P0 for either coin by more than that.

## Baseline: the published v3 backtests, recomputed

`research/baseline.mjs` recomputes the v3 backtest (27 Sep 2025 – 26 Sep 2026) from its CSV
files alone, with day-block bootstrap intervals (`research/results/baseline-v3-*.json`). The
results match the review's figures.

`research/baseline.mjs` recomputes the v3 backtest (27 Sep 2025 – 26 Sep 2026) from its CSV
files alone, with day-block bootstrap intervals (`research/results/baseline-v3-*.json`). The
results match the review's figures. Accuracy counts non-overlapping calls; "confident" is v3's
training-median rule.

| Coin, horizon | Confident calls right | All calls right | Log-loss gain over a coin (×10⁻⁴) | Displayed price vs. no change, squared error | Slope of the actual move on the displayed one | 80% range held |
|---|---:|---:|---:|---:|---:|---:|
| BTC 1 h | 54.2% of 4525 [52.8, 55.6] | 52.3% of 8734 | 20.9 | -0.076% | 0.31 | 80.1% |
| BTC 3 h | 54.1% of 1520 [51.6, 56.7] | 53.9% of 2912 | 17.0 | -0.196% | -0.01 | 80.1% |
| BTC 24 h | 46.0% of 176 [39.0, 53.6] | 47.9% of 363 | -14.0 | -0.673% | -3.09 | 79.9% |
| ADA 1 h | 53.6% of 4354 [52.2, 54.9] | 51.5% of 8497 | 17.4 | -0.015% | 0.45 | 80.0% |
| ADA 3 h | 53.7% of 1507 [51.3, 56.1] | 51.6% of 2875 | 8.7 | -0.021% | 0.44 | 80.0% |
| ADA 24 h | 52.6% of 173 [45.5, 60.2] | 47.1% of 361 | -18.8 | -0.757% | -0.61 | 80.0% |

The slope column is the least-squares slope of the actual move on the move the v3 page
displayed. 1 would mean the displayed move had the right size on average, and 0 that it carried
no information. At 1 hour it was 0.3 to 0.45, about three times too large. At 24 hours it was
negative, so the displayed move pointed the wrong way.

## Results

All numbers below come from `research/results/stage2-{btc,ada}.json`. The full tables are at the
end.

### The direction edge at 1 and 3 hours is real

The direction model's settings were chosen on Bitcoin between September 2025 and May 2026.
The year before that had never been used for any choice. The adopted configuration ("final")
on that year, counting non-overlapping calls only, with 95% week-block intervals:

| Untouched year (P0) | 1 h, all calls | 1 h, strong signal | 3 h, all calls | 3 h, strong signal |
|---|---:|---:|---:|---:|
| Bitcoin | 54.4% [53.4, 55.3] of 7,647 | 55.6% [54.2, 57.0] of 4,408 | 54.2% [52.7, 55.8] of 2,484 | 56.4% [54.3, 58.6] of 1,475 |
| Cardano | 53.1% [52.0, 54.1] of 7,173 | 54.3% [52.8, 55.8] of 4,348 | 53.0% [51.1, 54.7] of 2,273 | 54.3% [51.9, 56.3] of 1,476 |

Strong-signal calls are about half of all forecasts (50.0–50.8%). The log-loss gain of P(up)
over a coin flip on that year is also positive: 24.3 and 27.8 ×10⁻⁴ nats per forecast at 1 and
3 hours for Bitcoin, 9.5 and 7.1 for Cardano. Cardano's 3-hour interval includes zero.

In the inspected later months Cardano weakened at 3 hours (48.8% of all calls, 51.8% of
strong-signal calls), while its 1-hour calls and all of Bitcoin's held up.

### What adaptation adds

The adaptation ladder is on the untouched year, as the log-loss gain of P(up) over a coin
(×10⁻⁴ nats). Bitcoin 1 hour:

| System | Gain |
|---|---:|
| frozen models, no online learning | 19.4 |
| frozen models + online learning | 20.2 |
| daily refits, no online learning | 20.9 |
| daily refits + online learning (v4, preregistered settings) | 23.0 |
| the adopted configuration | 24.3 |

Each step helps a little on the untouched year. The clearest evidence for refitting comes from
the inspected later months of P12, 8–12 months after the frozen models were fitted: frozen
Bitcoin models fell to about 50% (log-loss gain −2.1 at 1 hour, −8.4 at 3 hours), while the
daily-refit ones stayed at about 54% (+25.2 and +21.8). The effect is not uniform: for Cardano
in the same months the frozen 1-hour model did slightly better than the refit one. A model
doesn't improve just by running longer, and daily refitting mostly keeps it from going stale.

Evolution (the daily tournament of the return experts) does not touch P(up). Rule 9 judges it
by the ranges. It changed the 80% range's interval score by at most 0.4 bp at 1 and 3 hours
(on scores of 140–650 bp): slightly worse for Bitcoin, slightly better for Cardano. At 24 hours
it changed it by up to 1.2 bp. It isn't worse everywhere, so production keeps it. In practice it
makes no measurable difference, which is worth knowing too: the daily tournament mostly keeps
the experts where they are.

### 24 hours: no reliable signal

v4's 24-hour P(up) was worse than a coin flip in every period for both coins: −32.9 (Bitcoin)
and −13.5 (Cardano) ×10⁻⁴ nats on the untouched year, −36.5 and −17.8 on the tuning part. The
calls were right 45.6–48.1% of the time. None of the challengers beat a coin either. The ridge
half of the incumbent was the least bad, so it is the model that keeps running in the
background.

The signal gate (rule 5) helped on Bitcoin but not on Cardano's untouched year (+2.4 ×10⁻⁴
pooled), so it didn't qualify. The fixed choice did: the page makes no call at 24 hours.

### Challengers for the direction model

At 1 hour no challenger beat the incumbent on both the tuning part and the untouched year.
At 3 hours two challengers did look better on Bitcoin's tuning part: the boosted classifier
(−1.4 ×10⁻⁴) and the 120-day window (−0.4). Both were clearly worse on the untouched year (+12.0
and +7.1 for Bitcoin, +1.5 and +6.2 for Cardano). That is overfitting to the tuning period, and
the preregistered gate caught it. The sequential selection rule was worse than the incumbent on
the tuning part (+5.7) and on the untouched year for both coins. The incumbent stays.

### Online settings

Faster forgetting hurt. With the corrected clock, the half-lives the code had always claimed (14
and 30 days) gave worse probabilities than v3's accidental long memory. The 210/450-day set was
better by 2.8 ×10⁻⁴ nats on the tuning part, and better on the untouched year for both coins
(−0.8 and −2.2). A calibration prior of 8000 pseudo-observations was better too. A learned
up/down intercept was worse (+6.0), as in v3's own testing. Other Hedge learning rates, and
ranges shaped from past residuals instead of past returns, changed the interval score by
0.3 bp or less, so the defaults stay.

Pooled over 1 and 3 hours, the adopted combination beats the preregistered v4 settings in all
three periods for both coins: by 0.8 (untouched), 3.6 (tuning) and 3.1 (later) ×10⁻⁴ nats for
Bitcoin, and by 2.7, 2.1 and 4.3 for Cardano.

### The price

Five candidates were compared against "no change": v3's unshrunk implied move, the experts'
ensemble, v4's shrunk implied move, and the median implied by P(up). Under squared error none
of them beat "no change" consistently. At 1 and 3 hours they are all within about ±0.1%,
positive in some periods and negative in others. On the untouched year, v4's shrunk move was at
+0.001% (Bitcoin 1 h), −0.050% (Bitcoin 3 h), −0.002% and −0.020% (Cardano), so rule 7 applies:
the page shows today's price as the price estimate. Under absolute error the implied moves do a
little better than "no change" at 1 and 3 hours (up to +0.5%), but the rule was set on squared
error before the results were known, and I kept it. At 24 hours every candidate was worse.

### Ranges

The 80% range held 79.6–80.1% of the time in every period, horizon and coin, before and after
the changes. Nesting the three ranges is a guarantee, not a measured improvement: the scored
80% range behaved the same with it.

### "Strong signal"

v4 compares each forecast with the last 7 days of forecasts. v3 compared it with the model's
own in-sample training scores. Both rules pick about half the calls, v3's a few points more
(50% against 53–56% on the untouched year). Their accuracy on the untouched year is within 0.5
points of each other. v4's rule is the one that doesn't depend on in-sample numbers.

## Decisions

`research/decide.mjs` applied the rules to the results mechanically:

| Rule | Decision |
|---|---|
| 3 forgetting | 210/450/450-day half-lives (passes the untouched-year gate for both coins) |
| 4 calibration | no intercept; prior 8000 |
| 5 24 hours | no reliable signal (the direction model runs in the background) |
| 6 direction model | incumbent at 1 and 3 hours; at 24 hours the ridge half beats the incumbent, but only in the background |
| 7 the price | today's price (the shrunk implied move is still recorded, to be tested live) |
| 8 strong signal | the 7-day rule |
| 9 evolution | keep the daily evolution (no measurable difference either way) |
| 10 ranges | unchanged |

The combination of these ("final") was then scored as one more variant (above). It is what runs
now.

## What demonstrably improved, and what didn't

**Software correctness (shown by tests, `test/core.test.mjs`).**
- **The shown price:** it is the scored price.
- **Forgetting:** memory halves after exactly one half-life, also across gaps.
- **Data gaps:** filled-in prices are never labels or outcomes, and a missing lead or peer
  candle suspends the forecast.
- **Fear & Greed:** it has one deterministic source.
- **Features:** the hour-of-week feature is fixed.
- **Ranges:** they are nested.
- **Calls:** a 50% forecast is no call.
- **Checkpoints:** they fail loudly.
- **Provenance:** every row records where it came from, and backfills can't enter the live score.

**Predictive gains (shown by the evaluation).**
- **24 hours:** switching the calls off removes a log-loss loss of 13–37 ×10⁻⁴ nats per
  forecast.
- **The settings:** they improve pooled 1 + 3 hour log loss by 1–4 ×10⁻⁴ nats. That is small,
  but consistent across periods and coins.
- **The price:** the shown price no longer loses to "no change" under squared error.

**Not improved.** Direction accuracy at 1 and 3 hours is the same as v3's. The v3 edge was real,
and no challenger added to it. There is still no price forecast better than "no change".

## Forward monitoring and rollback

The live record is now the only clean test. What I watch, from `data/status.json` and
`data/daily/`:

- **Direction:** at 1 and 3 hours, accuracy of non-overlapping calls and the log-loss gain over a
  coin, over the last 30 and 90 days.
- **Ranges:** 80% range coverage over the last 30 days. The pipeline warns when it drifts more
  than 5 points from 80%.
- **Operations:** replayed and suspended forecasts, data lag and model age. The pipeline warns
  on all of these.
- **Background candidates:** the 24-hour model's log-loss gain over a coin
  (`snaps[].shadow` in `daily/*.json`), and the shrunk implied move against "no change" (CSV
  column `imp`).

Rules:
- **A horizon's signal fails:** if after 90 live days the 1- or 3-hour log-loss gain is below
  zero and its 95% week-block interval is entirely below zero, that horizon goes to "no
  reliable signal" in the next version, like 24 hours now.
- **A background candidate comes back** only in a new version, after 90 live days in which it
  beats what the page shows with a week-block interval above zero, and after a check on history.
- **Every change is a new version:** the old record is archived unchanged and the new one starts
  with a fresh launch. Rolling back is the same thing: revert the code, archive, launch.
- **No promise:** nothing guarantees that the system gets better over time. It adapts, and the
  record shows whether that helps.

## Not done

- **Ablations of new inputs** (derivatives funding, open interest, basis, liquidity). They need
  point-in-time history that I don't have, and I won't reconstruct order-book data after the
  fact. No new inputs were added, so none needed an ablation. The pipeline could start recording
  them now; that is the first step if they are ever tried.
- **Trading usefulness.** Deliberately not simulated. Direction accuracy is not profitability,
  and nothing here connects to an account.
- **Forward shadow challengers at 1 and 3 hours.** No challenger came close, so none runs in the
  background. The 24-hour model and the price candidate do.
- **Model activation timing.** The backtests switch to each day's model at 00:00 UTC.
  Production switches at the first run after midnight, normally 00:01–00:16, and replays the
  minutes in between with the previous model. The difference is at most a few minutes a day.
- **An incremental candle cache for GitHub Actions.** Each run fetches what it needs from
  Binance, which stays within the limits (about 10k candles per symbol, 380k on retraining days).

## Reproduce

```bash
node research/baseline.mjs data > research/results/baseline-v3-btc.json   # (on the v3 record)
node research/prefetch.mjs 2024-01-10 2026-09-25                              # archive files, once
node research/stage1.mjs --from 2024-09-24 --to 2025-09-23 --part 1/2 --out .cache/research/P0-1.bin
node research/stage1.mjs --from 2024-09-24 --to 2025-09-23 --part 2/2 --out .cache/research/P0-2.bin
node research/stage1.mjs --from 2025-09-24 --to 2026-09-24 --part 1/2 --out .cache/research/P12-1.bin
node research/stage1.mjs --from 2025-09-24 --to 2026-09-24 --part 2/2 --out .cache/research/P12-2.bin
node research/stage1.mjs --from 2024-09-24 --to 2025-09-23 --evolve --out .cache/research/P0-evo.bin
node research/stage1.mjs --from 2025-09-24 --to 2026-09-24 --evolve --out .cache/research/P12-evo.bin
node research/stage2.mjs --final production     # -> research/results/stage2-<coin>.json
node research/decide.mjs research/results/stage2-btc.json research/results/stage2-ada.json
node research/report.mjs research/results/stage2-btc.json research/results/stage2-ada.json
```

Run everything in each repository for its own coin (config.js decides which). Each Stage 1 part
takes about an hour on one core, and the evolution runs 1–2 hours. Stage 2 takes about 5 minutes.
Versions: Node 26; code as committed with these results (the result files record the commit
they ran on); data from data.binance.vision and alternative.me, fetched 26 September 2026.

## Full tables

Generated by `research/report.mjs`.

### BTC


**Probability of "up": log-loss gain over a coin flip** (×10⁻⁴ nats per forecast, higher is better; 95% week-block interval where computed). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -5.5 | -13.5 | -108.6 |
| baseline momentum/reversal 30 d | 1.9 | -6.3 | -78.7 |
| frozen, no learning | 19.4 [13.9, 24.8] | 24.8 [16.7, 32.5] | -4.3 [-27.6, 17.3] |
| frozen + online | 20.2 [11.4, 28.8] | 28.5 [8.3, 47.8] | -29.8 [-73.3, 13.3] |
| refit, no learning | 20.9 [15.6, 26.0] | 22.6 [13.7, 31.5] | -14.4 [-37.7, 6.5] |
| refit daily + online learning (v4) | 23.0 [13.8, 31.9] | 27.6 [7.8, 47.7] | -32.9 [-65.3, -5.8] |
| v4 + daily evolution of the experts | 23.0 | 27.6 | -32.9 |
| v4 + sequential direction-model selection | 19.8 [9.5, 30.0] | 25.9 [5.9, 47.0] | -39.5 [-64.4, -18.3] |
| v4 + signal gate | 23.0 [13.8, 31.9] | 27.3 [7.5, 47.5] | -14.7 [-29.8, -3.4] |
| v4 with 24 h set to "no signal" | 23.0 | 27.6 | 0.0 |
| **final: the adopted combination** | 24.3 [16.1, 32.1] | 27.8 [14.4, 42.0] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 24.5 | 27.6 | -13.6 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -7.7 | -26.1 | -163.0 |
| baseline momentum/reversal 30 d | 3.9 | -0.3 | -41.7 |
| frozen, no learning | 12.1 [6.9, 17.1] | 14.8 [7.3, 23.0] | 10.1 [-16.2, 35.9] |
| frozen + online | 10.1 [2.0, 17.8] | 8.8 [-3.3, 21.8] | -7.3 [-86.4, 69.2] |
| refit, no learning | 15.6 [10.9, 20.3] | 13.9 [6.6, 21.3] | 1.3 [-29.0, 32.1] |
| refit daily + online learning (v4) | 15.5 [7.3, 24.1] | 7.2 [-4.4, 19.8] | -36.5 [-101.8, 29.7] |
| v4 + daily evolution of the experts | 15.5 | 7.2 | -36.5 |
| v4 + sequential direction-model selection | 13.0 [4.0, 21.5] | -1.6 [-16.3, 13.0] | -38.0 [-105.2, 27.4] |
| v4 + signal gate | 15.5 [7.3, 24.1] | 3.8 [-8.0, 16.2] | -20.1 [-59.0, 13.0] |
| v4 with 24 h set to "no signal" | 15.5 | 7.2 | 0.0 |
| **final: the adopted combination** | 16.6 [9.8, 23.4] | 13.2 [3.7, 23.3] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 16.4 | 11.8 | -17.8 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -3.3 | -7.8 | -152.7 |
| baseline momentum/reversal 30 d | 10.4 | 13.9 | 13.4 |
| frozen, no learning | -1.7 [-18.8, 10.5] | -1.8 [-26.3, 19.3] | -14.8 [-57.9, 26.2] |
| frozen + online | -2.1 [-11.0, 5.1] | -8.4 [-33.0, 14.6] | -48.6 [-133.6, 35.1] |
| refit, no learning | 20.9 [9.0, 31.4] | 18.8 [-3.9, 37.8] | 2.6 [-59.8, 51.3] |
| refit daily + online learning (v4) | 23.8 [3.9, 41.3] | 17.1 [-27.5, 54.5] | -32.6 [-167.7, 92.3] |
| v4 + daily evolution of the experts | 23.8 | 17.1 | -32.6 |
| v4 + sequential direction-model selection | 24.6 [3.1, 43.9] | 23.1 [-15.8, 58.3] | -85.9 [-206.1, 21.0] |
| v4 + signal gate | 23.8 [3.9, 41.3] | 17.1 [-27.5, 54.5] | -30.3 [-73.3, 3.3] |
| v4 with 24 h set to "no signal" | 23.8 | 17.1 | 0.0 |
| **final: the adopted combination** | 25.2 [6.6, 41.6] | 21.8 [-14.2, 51.8] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 25.5 | 22.0 | -11.6 |

**Direction right, non-overlapping calls** (%, 95% interval; "strong" = the stronger half by the rule in use, share of forecasts in brackets). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 51.9 (6766) | – | 51.5 (2528) | – | 46.6 (343) | – |
| refit, no learning | 54.9 [53.7, 56.0] (7090) | 55.6 [54.2, 57.0] (50%) | 54.6 [52.9, 56.2] (2330) | 56.4 [54.3, 58.6] (51%) | 47.1 [41.7, 53.0] (278) | 50.3 [43.1, 58.1] (47%) |
| refit daily + online learning (v4) | 54.4 [53.4, 55.3] (7743) | 55.6 [54.2, 57.0] (50%) | 54.2 [52.6, 55.8] (2498) | 56.4 [54.3, 58.6] (50%) | 48.1 [42.1, 54.2] (239) | 51.7 [42.9, 60.8] (40%) |
| v4 + sequential direction-model selection | 54.2 [53.1, 55.1] (7738) | 55.0 [53.6, 56.5] (50%) | 53.4 [51.9, 55.0] (2537) | 55.9 [53.6, 58.3] (50%) | 42.4 [33.6, 50.4] (125) | 40.5 [28.4, 52.1] (22%) |
| v4 + signal gate | 54.4 [53.4, 55.3] (7743) | 55.6 [54.2, 57.0] (50%) | 53.7 [52.1, 55.3] (2221) | 56.6 [54.2, 58.9] (43%) | 46.7 [16.7, 62.5] (15) | 60.0 [0.0, 100.0] (1%) |
| **final: the adopted combination** | 54.4 [53.4, 55.3] (7647) | 55.6 [54.2, 57.0] (50%) | 54.2 [52.7, 55.8] (2484) | 56.4 [54.3, 58.6] (51%) | – (0) | – |
| v3 "confident" rule | 54.4 (7743) | 55.7 (55%) | 54.2 (2498) | 56.2 (53%) | 48.1 (239) | 50.0 (39%) |
| v3 online layer (for reference) | 54.3 (7764) | 55.7 (55%) | 54.3 (2492) | 56.0 (54%) | 48.7 (158) | 48.0 (34%) |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 52.0 (5552) | – | 49.9 (1525) | – | 50.7 (223) | – |
| refit, no learning | 52.0 [51.0, 53.0] (4630) | 52.7 [51.4, 53.9] (49%) | 53.8 [51.8, 55.9] (1562) | 53.4 [50.8, 56.1] (49%) | 45.1 [37.5, 52.9] (175) | 42.2 [33.3, 51.8] (48%) |
| refit daily + online learning (v4) | 52.1 [51.1, 53.0] (4986) | 52.7 [51.4, 53.9] (49%) | 53.6 [51.8, 55.5] (1664) | 53.4 [50.8, 56.1] (49%) | 45.6 [39.1, 52.2] (171) | 42.7 [34.5, 51.6] (42%) |
| v4 + sequential direction-model selection | 51.9 [50.9, 52.8] (4997) | 52.5 [51.2, 53.8] (50%) | 52.6 [50.7, 54.5] (1645) | 52.4 [49.4, 55.2] (50%) | 42.2 [30.8, 54.1] (83) | 43.5 [32.4, 56.5] (19%) |
| v4 + signal gate | 52.1 [51.1, 53.0] (4986) | 52.7 [51.4, 53.9] (49%) | 53.4 [51.3, 55.3] (1446) | 53.5 [50.5, 56.4] (42%) | 42.3 [21.1, 66.7] (26) | 35.7 [0.0, 76.9] (6%) |
| **final: the adopted combination** | 52.2 [51.3, 53.1] (4916) | 52.7 [51.4, 53.9] (49%) | 53.5 [51.5, 55.6] (1643) | 53.4 [50.8, 56.1] (49%) | – (0) | – |
| v3 "confident" rule | 52.1 (4986) | 53.1 (51%) | 53.6 (1664) | 52.9 (52%) | 45.6 (171) | 43.9 (40%) |
| v3 online layer (for reference) | 52.4 (5032) | 53.1 (51%) | 53.4 (1669) | 52.9 (52%) | 40.9 (137) | 42.3 (40%) |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 53.1 (2815) | – | 53.2 (984) | – | 50.4 (119) | – |
| refit, no learning | 54.5 [52.8, 56.2] (2344) | 55.4 [53.2, 57.7] (50%) | 53.6 [48.5, 58.6] (781) | 55.1 [48.6, 61.8] (51%) | 47.0 [37.6, 56.4] (100) | 50.0 [37.5, 61.7] (54%) |
| refit daily + online learning (v4) | 54.3 [52.7, 55.8] (2582) | 55.4 [53.2, 57.7] (50%) | 53.6 [48.9, 57.8] (872) | 55.1 [48.6, 61.8] (51%) | 48.2 [37.0, 58.1] (83) | 49.1 [34.0, 63.3] (43%) |
| v4 + sequential direction-model selection | 53.9 [52.0, 55.8] (2618) | 55.7 [53.4, 58.3] (50%) | 53.9 [49.2, 58.3] (869) | 57.0 [51.3, 62.5] (52%) | 39.5 [22.6, 54.5] (38) | 37.5 [14.8, 57.9] (20%) |
| v4 + signal gate | 54.3 [52.7, 55.8] (2582) | 55.4 [53.2, 57.7] (50%) | 53.6 [48.9, 57.8] (872) | 55.1 [48.6, 61.8] (51%) | 45.5 [33.3, 55.6] (22) | 36.4 [9.1, 100.0] (9%) |
| **final: the adopted combination** | 54.1 [52.6, 55.7] (2557) | 55.4 [53.2, 57.7] (50%) | 53.9 [49.1, 58.6] (855) | 55.1 [48.6, 61.8] (51%) | – (0) | – |
| v3 "confident" rule | 54.3 (2582) | 55.4 (53%) | 53.6 (872) | 54.5 (52%) | 48.2 (83) | 43.4 (43%) |
| v3 online layer (for reference) | 54.2 (2571) | 55.4 (53%) | 53.5 (861) | 54.5 (52%) | 49.0 (100) | 45.3 (52%) |

**Direction-model challengers: change in log loss against the incumbent** (×10⁻⁴ nats, negative = better, 95% paired week-block interval). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 3.5 [-2.3, 9.3] | 7.1 [-2.6, 16.8] | 12.6 [-9.3, 35.0] |
| pairRW | -0.1 [-5.2, 4.9] | 4.5 [-2.0, 11.1] | 7.5 [-16.2, 30.8] |
| logit240 | 4.5 [1.4, 7.8] | -0.4 [-9.7, 9.0] | -6.2 [-18.9, 7.1] |
| gbc240 | 3.4 [-0.3, 7.2] | 12.0 [1.8, 21.7] | 3.0 [-16.1, 20.8] |
| ridge only | 4.5 [1.4, 7.7] | -0.4 [-9.7, 9.1] | -6.2 [-18.9, 7.1] |
| trees only | 1.8 [-1.2, 5.1] | 10.4 [3.3, 17.4] | 1.0 [-17.8, 18.2] |
| stacked blend | 1.9 [-0.1, 3.8] | 1.9 [-5.3, 8.9] | -17.4 [-67.4, 29.4] |
| selection policy | 3.2 [-0.6, 6.7] | 1.7 [-4.3, 7.9] | 6.5 [-26.8, 38.6] |
| v4 + signal gate | 0.0 [0.0, 0.0] | 0.3 [-2.0, 2.2] | -18.2 [-48.8, 8.9] |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 1.4 [-4.5, 7.8] | -0.4 [-10.9, 9.3] | 0.4 [-38.7, 40.8] |
| pairRW | 0.3 [-4.8, 5.7] | 1.4 [-6.0, 8.8] | 9.1 [-20.5, 36.6] |
| logit240 | 3.3 [-0.9, 7.8] | 0.9 [-5.6, 7.3] | -3.2 [-34.2, 29.8] |
| gbc240 | 2.7 [-2.5, 7.5] | -1.4 [-10.8, 8.0] | -0.1 [-33.4, 33.0] |
| ridge only | 3.3 [-1.0, 7.8] | 1.0 [-5.6, 7.3] | -3.2 [-34.2, 29.8] |
| trees only | 0.2 [-5.3, 5.3] | 1.1 [-7.0, 9.1] | -1.9 [-37.1, 32.2] |
| stacked blend | 0.2 [-5.8, 6.3] | 3.2 [-7.7, 14.1] | 8.6 [-44.1, 63.7] |
| selection policy | 2.5 [-2.4, 6.9] | 8.8 [2.9, 15.4] | 1.5 [-33.7, 36.8] |
| v4 + signal gate | 0.0 [0.0, 0.0] | 3.4 [0.3, 7.0] | -16.4 [-69.2, 35.6] |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 1.3 [-7.6, 10.0] | -6.0 [-26.6, 14.5] | -6.2 [-94.2, 74.7] |
| pairRW | -2.1 [-8.3, 3.7] | -5.6 [-18.4, 8.2] | -3.2 [-85.6, 69.8] |
| logit240 | 5.0 [-2.5, 13.1] | -1.0 [-16.7, 15.7] | 13.0 [-47.7, 74.4] |
| gbc240 | 5.8 [-0.9, 12.6] | 5.1 [-11.1, 20.3] | -21.4 [-108.1, 58.6] |
| ridge only | 5.0 [-2.5, 13.1] | -1.0 [-16.7, 15.7] | 13.0 [-47.7, 74.4] |
| trees only | 1.4 [-5.4, 7.8] | 7.6 [-8.4, 22.9] | -23.9 [-108.8, 55.5] |
| stacked blend | 4.0 [0.4, 7.4] | 7.4 [-9.8, 23.6] | 15.2 [-65.4, 117.5] |
| selection policy | -0.9 [-7.5, 5.2] | -6.0 [-19.9, 8.5] | 53.3 [-10.3, 114.4] |
| v4 + signal gate | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | -2.3 [-129.8, 101.5] |

**Online layer settings: change in log loss against v4** (×10⁻⁴ nats, negative = better). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 2.0 [1.3, 2.7] | 1.7 [-1.2, 4.7] | 7.1 [1.2, 13.5] |
| half-lives 60/120/120 d | -1.3 [-2.1, -0.5] | -0.3 [-5.8, 5.3] | -16.8 [-35.6, -1.5] |
| half-lives 210/450/450 d | -1.5 [-2.5, -0.5] | -0.1 [-7.0, 7.1] | -19.4 [-41.0, -0.8] |
| v3 forgetting (per outcome) | -1.5 [-2.5, -0.5] | -0.1 [-7.0, 7.1] | -19.4 [-41.0, -0.8] |
| calibration with intercept | 0.2 [-6.1, 5.9] | 3.0 [-10.2, 15.4] | 32.0 [-12.8, 76.1] |
| calibration prior 500 | 0.3 [-0.2, 0.8] | 0.5 [-0.4, 1.5] | 6.0 [1.6, 11.7] |
| calibration prior 8000 | -0.8 [-1.9, 0.2] | -0.9 [-5.5, 3.7] | -20.3 [-41.3, -4.2] |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 1.1 [0.3, 1.9] | 4.0 [2.6, 5.4] | 9.3 [0.0, 18.7] |
| half-lives 60/120/120 d | -0.7 [-1.8, 0.3] | -3.9 [-5.3, -2.4] | -16.6 [-47.9, 15.1] |
| half-lives 210/450/450 d | -0.9 [-2.3, 0.5] | -4.6 [-6.3, -2.8] | -18.7 [-58.1, 21.1] |
| v3 forgetting (per outcome) | -0.9 [-2.3, 0.5] | -4.6 [-6.3, -2.8] | -18.7 [-58.1, 21.1] |
| calibration with intercept | 3.4 [1.7, 5.1] | 8.6 [1.7, 15.2] | 33.5 [-24.3, 85.5] |
| calibration prior 500 | 0.6 [0.0, 1.2] | 0.9 [-0.6, 2.7] | 12.4 [2.4, 26.0] |
| calibration prior 8000 | -0.8 [-2.4, 0.7] | -4.8 [-6.9, -2.5] | -24.9 [-60.5, 11.0] |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 1.2 [-1.4, 3.5] | 2.0 [-3.3, 6.6] | -4.9 [-18.4, 9.4] |
| half-lives 60/120/120 d | -1.4 [-3.3, 0.6] | -4.0 [-9.4, 1.4] | -10.4 [-58.7, 37.8] |
| half-lives 210/450/450 d | -1.7 [-3.9, 0.4] | -4.9 [-12.0, 2.0] | -20.9 [-83.5, 40.7] |
| v3 forgetting (per outcome) | -1.7 [-3.9, 0.4] | -4.9 [-12.0, 2.0] | -20.9 [-83.5, 40.7] |
| calibration with intercept | 1.7 [-4.0, 7.0] | 2.5 [-12.5, 16.9] | 39.8 [-53.7, 122.1] |
| calibration prior 500 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.1 [-0.1, 0.2] |
| calibration prior 8000 | -1.0 [-2.6, 0.7] | -3.2 [-7.7, 1.4] | -9.6 [-58.0, 39.5] |

**The shown price: error against "no change"** (skill in %, positive = better than no change; MAE / MSE). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.320 | 0.027 | 0.456 | 0.078 | -0.446 | -0.911 |
| ensemble | 0.031 | 0.022 | 0.016 | 0.011 | -0.022 | -0.059 |
| implied, shrunk (v4) | 0.126 | 0.001 | 0.111 | -0.050 | -0.036 | -0.088 |
| median from P(up) | 0.345 | -0.196 | 0.490 | -0.248 | -0.835 | -1.634 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.181 | -0.117 | 0.143 | -0.165 | -0.238 | -0.149 |
| ensemble | -0.001 | -0.017 | 0.002 | -0.016 | -0.020 | -0.026 |
| implied, shrunk (v4) | 0.041 | -0.027 | 0.002 | -0.013 | -0.203 | -0.203 |
| median from P(up) | 0.185 | -0.322 | 0.117 | -0.394 | -0.554 | -0.475 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.281 | -0.066 | 0.166 | -0.377 | -0.382 | -2.124 |
| ensemble | 0.030 | -0.005 | -0.004 | -0.045 | -0.018 | -0.101 |
| implied, shrunk (v4) | 0.065 | -0.028 | 0.076 | -0.002 | -0.077 | -0.159 |
| median from P(up) | 0.262 | -0.329 | 0.028 | -0.897 | -0.909 | -3.711 |

**The 80% range: coverage, width and interval score** (width and score in bp; lower score is better). BTC.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 97 | 156.8 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.8 |
| refit daily + online learning (v4) | 80.0 | 97 | 156.8 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.8 |
| v4 + daily evolution of the experts | 80.0 | 97 | 156.9 | 80.0 | 174 | 281.3 | 80.0 | 635 | 890.1 |
| hedge eta 0.05 | 80.0 | 97 | 156.8 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.8 |
| hedge eta 0.8 | 80.0 | 97 | 156.8 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.8 |
| ranges from past residuals | 80.0 | 97 | 156.9 | 80.0 | 175 | 281.7 | 79.9 | 631 | 888.8 |
| **final: the adopted combination** | 80.0 | 97 | 156.8 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.8 |
| frozen + online | 80.0 | 97 | 156.9 | 80.0 | 174 | 281.2 | 80.0 | 635 | 889.4 |
| refit, no learning | 80.0 | 93 | 156.3 | 79.8 | 167 | 277.5 | 79.5 | 557 | 829.2 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 100 | 165.8 | 79.9 | 180 | 303.0 | 79.7 | 668 | 952.1 |
| refit daily + online learning (v4) | 80.0 | 100 | 165.8 | 79.9 | 180 | 303.0 | 79.7 | 668 | 952.1 |
| v4 + daily evolution of the experts | 80.0 | 100 | 165.8 | 79.9 | 181 | 303.1 | 79.7 | 668 | 952.5 |
| hedge eta 0.05 | 80.0 | 100 | 165.8 | 79.9 | 180 | 303.0 | 79.7 | 668 | 952.1 |
| hedge eta 0.8 | 80.0 | 100 | 165.7 | 79.9 | 181 | 303.0 | 79.7 | 668 | 952.3 |
| ranges from past residuals | 80.0 | 100 | 165.8 | 79.9 | 182 | 303.6 | 79.7 | 671 | 957.0 |
| **final: the adopted combination** | 80.0 | 100 | 165.8 | 79.9 | 180 | 303.0 | 79.7 | 668 | 952.1 |
| frozen + online | 80.0 | 100 | 165.8 | 79.9 | 181 | 303.1 | 79.7 | 669 | 952.7 |
| refit, no learning | 79.9 | 97 | 164.8 | 79.8 | 175 | 298.6 | 79.4 | 618 | 900.6 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 87 | 140.2 | 80.1 | 155 | 253.0 | 80.1 | 586 | 845.4 |
| refit daily + online learning (v4) | 80.0 | 87 | 140.2 | 80.1 | 155 | 252.9 | 80.1 | 586 | 845.4 |
| v4 + daily evolution of the experts | 80.0 | 87 | 140.2 | 80.1 | 155 | 253.0 | 80.0 | 587 | 845.6 |
| hedge eta 0.05 | 80.0 | 87 | 140.2 | 80.1 | 155 | 252.9 | 80.1 | 586 | 845.4 |
| hedge eta 0.8 | 80.0 | 87 | 140.2 | 80.1 | 155 | 252.9 | 80.1 | 586 | 845.4 |
| ranges from past residuals | 80.0 | 87 | 140.2 | 80.1 | 154 | 252.8 | 80.0 | 591 | 855.4 |
| **final: the adopted combination** | 80.0 | 87 | 140.2 | 80.1 | 155 | 253.0 | 80.1 | 586 | 845.4 |
| frozen + online | 80.0 | 87 | 140.2 | 80.1 | 155 | 253.1 | 80.1 | 585 | 845.0 |
| refit, no learning | 80.2 | 84 | 139.6 | 80.1 | 151 | 249.7 | 78.7 | 482 | 777.1 |

**What the sequential selection chose** (BTC; from = first day of each choice).

- P0 1 h: 2024-09-24 pair240 → 2024-12-11 pairRW → 2025-03-16 gbdt240 → 2025-04-22 pair120 → 2025-06-12 pair240 → 2025-07-20 gbdt240 → 2025-09-22 pair240
- P0 3 h: 2024-09-24 pair240 → 2024-11-23 stack → 2024-12-17 ridge240 → 2025-01-19 pair120 → 2025-02-04 pair240 → 2025-06-07 logit240
- P0 24 h: 2024-09-24 pair240 → 2024-11-23 stack → 2024-12-15 neutral → 2025-01-04 stack → 2025-01-05 neutral → 2025-01-09 stack → 2025-01-10 neutral → 2025-01-20 stack → 2025-02-06 neutral → 2025-03-22 stack → 2025-03-23 neutral → 2025-04-11 stack → 2025-04-23 neutral → 2025-04-25 stack → 2025-06-07 ridge240 → 2025-06-17 neutral → 2025-06-23 logit240 → 2025-07-11 neutral → 2025-08-17 pairRW → 2025-08-19 neutral
- P12 1 h: 2025-09-24 pair240 → 2025-11-23 gbdt240 → 2026-01-23 pairRW → 2026-02-22 pair240 → 2026-03-03 ridge240 → 2026-03-20 pairRW → 2026-09-17 pair120
- P12 3 h: 2025-09-24 pair240 → 2025-11-23 pair120 → 2026-01-17 logit240 → 2026-03-22 gbdt240 → 2026-05-14 gbc240 → 2026-05-30 logit240 → 2026-08-30 pair120
- P12 24 h: 2025-09-24 pair240 → 2025-11-23 neutral → 2026-03-30 gbdt240 → 2026-04-26 pair120 → 2026-05-05 gbdt240 → 2026-05-10 gbc240 → 2026-05-19 neutral → 2026-05-28 ridge240 → 2026-06-03 neutral → 2026-06-12 gbc240 → 2026-06-25 logit240 → 2026-07-03 neutral → 2026-08-03 logit240 → 2026-08-08 gbc240 → 2026-08-12 gbdt240 → 2026-08-13 neutral → 2026-08-17 logit240 → 2026-08-20 neutral

### ADA


**Probability of "up": log-loss gain over a coin flip** (×10⁻⁴ nats per forecast, higher is better; 95% week-block interval where computed). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -5.7 | -17.8 | -153.0 |
| baseline momentum/reversal 30 d | 1.4 | -9.2 | -54.4 |
| frozen, no learning | 10.6 [4.1, 16.7] | 6.4 [-3.0, 15.5] | 6.1 [-15.3, 26.2] |
| frozen + online | 8.6 [0.7, 16.5] | 2.9 [-7.6, 13.9] | -2.6 [-69.4, 59.4] |
| refit, no learning | 10.1 [3.3, 16.3] | 8.7 [-0.8, 17.1] | -6.6 [-28.7, 16.3] |
| refit daily + online learning (v4) | 7.7 [-0.6, 15.3] | 3.4 [-7.0, 13.8] | -13.5 [-67.0, 39.3] |
| v4 + daily evolution of the experts | 7.7 | 3.4 | -13.5 |
| v4 + sequential direction-model selection | 5.1 [-3.4, 13.3] | -0.3 [-12.3, 12.1] | -30.6 [-76.0, 14.9] |
| v4 + signal gate | 7.3 [-1.1, 14.8] | 0.4 [-9.1, 10.3] | -17.3 [-61.5, 27.8] |
| v4 with 24 h set to "no signal" | 7.7 | 3.4 | 0.0 |
| **final: the adopted combination** | 9.5 [2.0, 16.3] | 7.1 [-1.6, 15.1] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 9.0 | 6.6 | -13.3 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -4.0 | -18.6 | -80.2 |
| baseline momentum/reversal 30 d | 4.5 | -10.4 | 31.9 |
| frozen, no learning | 8.2 [1.1, 15.5] | 9.5 [0.6, 18.3] | 4.4 [-16.7, 25.8] |
| frozen + online | 4.8 [-2.1, 11.9] | 2.0 [-9.5, 13.3] | -9.4 [-52.7, 36.0] |
| refit, no learning | 15.8 [8.9, 22.4] | 13.4 [2.9, 23.0] | -0.9 [-29.9, 28.0] |
| refit daily + online learning (v4) | 15.8 [5.6, 26.1] | 9.7 [-7.4, 27.0] | -17.8 [-78.8, 40.5] |
| v4 + daily evolution of the experts | 15.8 | 9.7 | -17.8 |
| v4 + sequential direction-model selection | 15.4 [3.7, 26.5] | 6.5 [-12.8, 26.1] | 1.7 [-69.6, 72.5] |
| v4 + signal gate | 14.9 [4.6, 25.2] | 8.2 [-7.5, 24.4] | -23.5 [-66.2, 16.7] |
| v4 with 24 h set to "no signal" | 15.8 | 9.7 | 0.0 |
| **final: the adopted combination** | 17.0 [8.4, 25.4] | 12.7 [-1.6, 26.3] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 16.8 | 11.4 | -7.6 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| baseline coin | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.0] |
| baseline up-share 30 d | -3.0 | -6.4 | -113.7 |
| baseline momentum/reversal 30 d | 17.2 | -1.5 | -185.6 |
| frozen, no learning | 9.8 [-8.9, 27.0] | -13.6 [-44.4, 11.6] | -37.5 [-96.9, 13.0] |
| frozen + online | 7.6 [-10.9, 25.5] | -8.6 [-25.6, 6.2] | -69.0 [-124.5, -14.9] |
| refit, no learning | 14.2 [3.7, 23.5] | 3.9 [-16.1, 21.5] | -28.6 [-85.8, 21.4] |
| refit daily + online learning (v4) | 14.1 [-1.7, 28.9] | -5.2 [-39.6, 24.2] | -78.1 [-183.0, 10.2] |
| v4 + daily evolution of the experts | 14.1 | -5.2 | -78.1 |
| v4 + sequential direction-model selection | 7.9 [-11.3, 24.3] | -8.2 [-51.1, 29.8] | -66.9 [-221.4, 40.3] |
| v4 + signal gate | 14.1 [-1.7, 28.9] | -10.0 [-43.1, 18.0] | -26.0 [-77.4, 0.0] |
| v4 with 24 h set to "no signal" | 14.1 | -5.2 | 0.0 |
| **final: the adopted combination** | 15.8 [0.8, 29.3] | 1.7 [-25.4, 25.3] | 0.0 [0.0, 0.0] |
| v3 online layer (for reference) | 15.7 | 1.1 | -43.1 |

**Direction right, non-overlapping calls** (%, 95% interval; "strong" = the stronger half by the rule in use, share of forecasts in brackets). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 51.3 (8014) | – | 50.1 (2481) | – | 51.9 (339) | – |
| refit, no learning | 53.1 [52.1, 54.2] (7064) | 54.3 [52.8, 55.8] (50%) | 53.1 [51.2, 54.8] (2321) | 54.3 [51.9, 56.3] (51%) | 44.5 [38.0, 50.7] (281) | 41.1 [33.3, 49.4] (49%) |
| refit daily + online learning (v4) | 53.0 [52.0, 54.1] (7070) | 54.3 [52.8, 55.8] (50%) | 52.8 [50.9, 54.5] (2228) | 54.3 [52.0, 56.3] (49%) | 47.3 [40.4, 54.1] (260) | 41.5 [32.7, 50.6] (44%) |
| v4 + sequential direction-model selection | 52.9 [51.7, 54.0] (6799) | 53.5 [51.9, 55.2] (48%) | 52.7 [50.6, 54.6] (2097) | 54.0 [51.4, 56.4] (43%) | 44.8 [35.6, 53.1] (134) | 38.3 [27.4, 49.3] (22%) |
| v4 + signal gate | 52.8 [51.8, 53.9] (6883) | 54.2 [52.7, 55.6] (48%) | 52.7 [50.5, 54.8] (1511) | 54.3 [51.5, 56.9] (31%) | 43.5 [35.1, 51.7] (92) | 40.8 [27.7, 54.1] (13%) |
| **final: the adopted combination** | 53.1 [52.0, 54.1] (7173) | 54.3 [52.8, 55.8] (50%) | 53.0 [51.1, 54.7] (2273) | 54.3 [51.9, 56.3] (51%) | – (0) | – |
| v3 "confident" rule | 53.0 (7070) | 54.3 (56%) | 52.8 (2228) | 53.8 (52%) | 47.3 (260) | 42.4 (40%) |
| v3 online layer (for reference) | 53.1 (7165) | 54.3 (56%) | 53.0 (2168) | 53.7 (52%) | 43.7 (238) | 42.4 (40%) |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 51.7 (4991) | – | 50.0 (1331) | – | 47.7 (218) | – |
| refit, no learning | 52.8 [51.5, 54.0] (4476) | 53.7 [52.2, 55.1] (49%) | 54.5 [51.8, 57.3] (1490) | 56.2 [52.9, 59.2] (51%) | 53.8 [46.8, 60.3] (182) | 55.8 [45.4, 65.5] (47%) |
| refit daily + online learning (v4) | 52.4 [51.2, 53.6] (4763) | 53.7 [52.2, 55.1] (49%) | 53.7 [50.8, 56.6] (1504) | 55.9 [52.4, 59.0] (49%) | 45.9 [38.3, 52.9] (159) | 51.5 [39.8, 61.9] (41%) |
| v4 + sequential direction-model selection | 52.6 [51.4, 53.8] (4841) | 53.2 [51.7, 54.7] (49%) | 54.6 [51.4, 57.9] (1241) | 56.9 [53.3, 60.3] (38%) | 56.3 [48.0, 64.9] (103) | 62.9 [50.0, 75.0] (26%) |
| v4 + signal gate | 52.3 [51.1, 53.6] (4268) | 53.8 [52.1, 55.2] (43%) | 54.1 [50.6, 57.5] (1060) | 56.9 [52.7, 60.6] (33%) | 47.7 [34.3, 60.9] (44) | 56.7 [35.0, 75.0] (12%) |
| **final: the adopted combination** | 52.7 [51.5, 53.9] (4680) | 53.7 [52.2, 55.1] (49%) | 53.9 [51.3, 56.6] (1585) | 56.2 [52.9, 59.2] (51%) | – (0) | – |
| v3 "confident" rule | 52.4 (4763) | 53.6 (52%) | 53.7 (1504) | 55.1 (52%) | 45.9 (159) | 49.5 (42%) |
| v3 online layer (for reference) | 52.6 (4716) | 53.6 (52%) | 53.9 (1606) | 55.4 (54%) | 48.5 (130) | 51.1 (39%) |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h all calls | 1 h strong | 3 h all calls | 3 h strong | 24 h all calls | 24 h strong |
|---|---:|---:|---:|---:|---:|---:|
| baseline momentum/reversal 30 d | 52.7 (2658) | – | 49.5 (886) | – | 47.4 (116) | – |
| refit, no learning | 51.6 [49.9, 53.5] (2241) | 53.2 [51.0, 55.3] (49%) | 48.7 [43.7, 53.3] (750) | 51.8 [45.5, 57.5] (50%) | 46.2 [33.3, 60.2] (91) | 48.5 [35.2, 63.6] (54%) |
| refit daily + online learning (v4) | 51.0 [49.1, 53.0] (2406) | 53.2 [51.0, 55.3] (49%) | 48.9 [44.2, 53.0] (751) | 51.8 [45.5, 57.5] (50%) | 43.5 [29.0, 57.1] (85) | 45.3 [28.6, 62.0] (43%) |
| v4 + sequential direction-model selection | 51.4 [49.1, 53.6] (2440) | 53.1 [50.4, 55.8] (50%) | 50.1 [45.1, 54.7] (688) | 50.5 [43.9, 56.9] (42%) | 50.0 [35.4, 61.8] (42) | 43.5 [22.2, 65.6] (19%) |
| v4 + signal gate | 51.0 [49.1, 53.0] (2406) | 53.2 [51.0, 55.3] (49%) | 48.6 [41.7, 54.5] (521) | 50.0 [41.5, 57.5] (35%) | 20.0 [0.0, 25.0] (5) | 0.0 [0.0, 0.0] (2%) |
| **final: the adopted combination** | 51.0 [49.1, 53.0] (2394) | 53.2 [51.0, 55.3] (49%) | 48.8 [44.0, 53.2] (800) | 51.8 [45.5, 57.5] (50%) | – (0) | – |
| v3 "confident" rule | 51.0 (2406) | 52.8 (51%) | 48.9 (751) | 51.8 (51%) | 43.5 (85) | 46.9 (40%) |
| v3 online layer (for reference) | 50.9 (2418) | 52.8 (51%) | 48.6 (805) | 51.8 (51%) | 44.0 (84) | 47.5 (48%) |

**Direction-model challengers: change in log loss against the incumbent** (×10⁻⁴ nats, negative = better, 95% paired week-block interval). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 1.2 [-3.0, 5.3] | 6.2 [-1.5, 13.7] | 16.9 [-21.0, 52.3] |
| pairRW | 0.0 [-3.4, 3.4] | 2.5 [-5.2, 9.6] | 15.2 [-13.2, 41.4] |
| logit240 | -0.7 [-3.1, 1.9] | 0.5 [-4.8, 5.9] | -1.1 [-24.8, 27.0] |
| gbc240 | 2.8 [0.0, 5.5] | 1.5 [-5.1, 8.1] | 14.8 [-14.2, 44.8] |
| ridge only | -0.6 [-2.9, 1.9] | 0.5 [-4.8, 5.9] | -1.0 [-24.6, 26.9] |
| trees only | 2.5 [0.1, 4.6] | 0.0 [-6.2, 6.2] | 10.5 [-13.7, 33.0] |
| stacked blend | 1.5 [-2.0, 5.2] | 0.1 [-8.6, 8.8] | 25.1 [-32.2, 81.1] |
| selection policy | 2.6 [-0.4, 5.6] | 3.7 [-1.5, 9.2] | 17.0 [-7.5, 44.3] |
| v4 + signal gate | 0.4 [-0.3, 1.5] | 3.1 [-1.4, 7.3] | 3.7 [-26.3, 35.0] |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 1.1 [-4.6, 6.4] | -5.4 [-15.4, 4.3] | 2.5 [-38.8, 42.8] |
| pairRW | 1.2 [-2.6, 5.5] | -6.7 [-16.3, 2.1] | 15.8 [-13.9, 46.2] |
| logit240 | 3.2 [-1.9, 8.0] | -0.8 [-7.6, 5.2] | -23.6 [-67.7, 16.9] |
| gbc240 | 1.5 [-4.4, 7.3] | 1.1 [-8.0, 10.2] | 30.0 [-8.3, 70.5] |
| ridge only | 5.0 [0.4, 9.3] | 0.2 [-5.7, 5.8] | -23.6 [-67.5, 16.7] |
| trees only | 0.6 [-4.0, 5.2] | 4.8 [-2.5, 12.3] | 27.4 [-11.2, 68.7] |
| stacked blend | 3.7 [0.2, 7.6] | 5.1 [-0.7, 10.7] | -8.8 [-75.9, 56.9] |
| selection policy | 0.4 [-4.2, 4.7] | 3.2 [-3.6, 9.8] | -19.5 [-67.5, 30.1] |
| v4 + signal gate | 0.8 [-0.8, 3.0] | 1.5 [-4.4, 7.2] | 5.8 [-32.2, 47.0] |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Challenger | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| pair120 | 3.6 [-5.5, 12.8] | 2.7 [-11.8, 17.7] | -15.8 [-88.8, 50.4] |
| pairRW | 0.5 [-6.1, 6.6] | 3.4 [-6.1, 13.0] | -8.8 [-71.4, 51.2] |
| logit240 | 4.6 [-5.7, 14.8] | 0.8 [-15.4, 19.7] | 30.5 [-43.6, 122.9] |
| gbc240 | 2.4 [-4.3, 8.3] | -2.2 [-21.9, 14.9] | -40.4 [-124.1, 24.5] |
| ridge only | 2.9 [-5.1, 10.5] | 1.0 [-12.8, 16.3] | 30.1 [-42.6, 121.4] |
| trees only | 2.5 [-4.2, 8.3] | -6.3 [-25.7, 10.8] | -36.7 [-125.2, 29.4] |
| stacked blend | 3.2 [-1.2, 7.3] | -3.2 [-23.2, 18.6] | -17.1 [-147.2, 113.6] |
| selection policy | 6.2 [-0.9, 14.3] | 3.0 [-14.9, 21.5] | -11.2 [-119.6, 106.5] |
| v4 + signal gate | 0.0 [0.0, 0.0] | 4.8 [-1.9, 11.9] | -52.1 [-129.3, 19.9] |

**Online layer settings: change in log loss against v4** (×10⁻⁴ nats, negative = better). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 1.4 [0.0, 2.6] | 2.9 [0.7, 5.0] | -2.1 [-10.1, 5.0] |
| half-lives 60/120/120 d | -1.1 [-2.2, 0.1] | -2.7 [-5.2, 0.0] | -1.0 [-26.5, 23.7] |
| half-lives 210/450/450 d | -1.3 [-2.7, 0.2] | -3.1 [-6.2, 0.2] | -0.2 [-31.4, 29.7] |
| v3 forgetting (per outcome) | -1.3 [-2.7, 0.2] | -3.1 [-6.2, 0.2] | -0.2 [-31.4, 29.7] |
| calibration with intercept | 1.0 [-3.7, 5.1] | 4.6 [-6.1, 14.5] | 42.1 [5.0, 76.5] |
| calibration prior 500 | 0.1 [-0.6, 0.8] | 0.5 [-0.6, 1.9] | 5.4 [-1.1, 12.8] |
| calibration prior 8000 | -1.2 [-2.1, -0.2] | -2.4 [-4.8, 0.0] | -5.0 [-33.8, 23.5] |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 1.2 [-0.1, 2.5] | 1.0 [-1.7, 3.7] | 8.4 [-1.7, 18.3] |
| half-lives 60/120/120 d | -0.9 [-2.0, 0.2] | -1.3 [-4.6, 2.4] | -10.3 [-39.6, 19.0] |
| half-lives 210/450/450 d | -1.0 [-2.4, 0.4] | -1.6 [-5.8, 2.8] | -10.2 [-45.8, 25.5] |
| v3 forgetting (per outcome) | -1.0 [-2.4, 0.4] | -1.6 [-5.8, 2.8] | -10.2 [-45.8, 25.5] |
| calibration with intercept | -0.3 [-7.2, 5.9] | -1.4 [-19.1, 15.1] | -5.6 [-67.9, 53.0] |
| calibration prior 500 | 0.6 [0.1, 1.2] | 0.9 [-0.7, 2.7] | 10.1 [-5.0, 28.6] |
| calibration prior 8000 | -1.2 [-2.6, 0.2] | -2.2 [-7.1, 2.2] | -18.1 [-50.1, 14.0] |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Setting | 1 h | 3 h | 24 h |
|---|---:|---:|---:|
| half-lives 7/14/30 d | 1.0 [-0.4, 2.3] | 2.9 [-0.1, 6.3] | 5.5 [-1.6, 13.2] |
| half-lives 60/120/120 d | -1.3 [-3.0, 0.6] | -5.4 [-11.8, 0.6] | -23.4 [-67.3, 20.5] |
| half-lives 210/450/450 d | -1.6 [-3.6, 0.7] | -6.3 [-13.5, 0.8] | -35.0 [-85.7, 14.3] |
| v3 forgetting (per outcome) | -1.6 [-3.6, 0.7] | -6.3 [-13.5, 0.8] | -35.0 [-85.8, 14.3] |
| calibration with intercept | 0.4 [-10.0, 10.9] | -0.1 [-36.3, 33.4] | -17.9 [-137.7, 92.3] |
| calibration prior 500 | 0.0 [0.0, 0.0] | 0.0 [0.0, 0.1] | 0.8 [-0.9, 2.4] |
| calibration prior 8000 | -1.0 [-2.4, 0.5] | -4.9 [-10.9, 0.9] | -23.9 [-66.8, 18.6] |

**The shown price: error against "no change"** (skill in %, positive = better than no change; MAE / MSE). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.126 | -0.206 | 0.088 | -0.123 | -0.124 | -0.576 |
| ensemble | -0.007 | -0.009 | -0.010 | 0.001 | -0.046 | -0.087 |
| implied, shrunk (v4) | 0.010 | -0.002 | -0.011 | -0.020 | -0.049 | -0.105 |
| median from P(up) | 0.126 | -0.429 | 0.061 | -0.299 | -0.481 | -1.298 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.173 | 0.090 | 0.149 | 0.178 | 0.003 | -0.028 |
| ensemble | -0.002 | -0.013 | 0.003 | 0.018 | -0.001 | -0.068 |
| implied, shrunk (v4) | 0.037 | -0.012 | 0.019 | 0.099 | 0.038 | 0.042 |
| median from P(up) | 0.183 | 0.025 | 0.122 | 0.103 | -0.256 | -0.552 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| Estimate | 1 h MAE | 1 h MSE | 3 h MAE | 3 h MSE | 24 h MAE | 24 h MSE |
|---|---:|---:|---:|---:|---:|---:|
| no change | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| implied (v3) | 0.065 | -0.100 | -0.129 | -0.523 | -0.817 | -2.357 |
| ensemble | 0.016 | 0.026 | -0.018 | 0.019 | -0.047 | -0.054 |
| implied, shrunk (v4) | 0.021 | -0.058 | -0.017 | -0.039 | -0.183 | -0.467 |
| median from P(up) | 0.016 | -0.337 | -0.259 | -0.933 | -1.478 | -3.933 |

**The 80% range: coverage, width and interval score** (width and score in bp; lower score is better). ADA.


*P0 untouched (24 Sep 2024 – 23 Sep 2025)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2207.6 |
| refit daily + online learning (v4) | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2207.6 |
| v4 + daily evolution of the experts | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.7 | 79.8 | 1504 | 2207.5 |
| hedge eta 0.05 | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2207.6 |
| hedge eta 0.8 | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2207.6 |
| ranges from past residuals | 80.0 | 237 | 365.6 | 80.0 | 421 | 648.4 | 79.8 | 1504 | 2210.2 |
| **final: the adopted combination** | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2207.6 |
| frozen + online | 80.0 | 236 | 365.4 | 80.0 | 420 | 647.8 | 79.8 | 1504 | 2206.8 |
| refit, no learning | 80.1 | 230 | 363.1 | 79.9 | 404 | 639.1 | 79.2 | 1278 | 2026.6 |

*P12 tuning (24 Sep 2025 – 24 May 2026)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 177 | 284.0 | 80.0 | 322 | 521.8 | 80.1 | 1187 | 1697.0 |
| refit daily + online learning (v4) | 80.0 | 177 | 284.0 | 80.0 | 322 | 521.8 | 80.1 | 1187 | 1697.0 |
| v4 + daily evolution of the experts | 80.0 | 177 | 284.0 | 80.0 | 322 | 521.7 | 80.1 | 1186 | 1695.8 |
| hedge eta 0.05 | 80.0 | 177 | 284.0 | 80.0 | 322 | 521.8 | 80.1 | 1187 | 1697.0 |
| hedge eta 0.8 | 80.0 | 178 | 284.0 | 80.0 | 322 | 521.8 | 80.1 | 1187 | 1697.1 |
| ranges from past residuals | 80.0 | 177 | 284.5 | 80.0 | 323 | 522.8 | 80.1 | 1186 | 1705.3 |
| **final: the adopted combination** | 80.0 | 177 | 284.0 | 80.0 | 322 | 521.8 | 80.1 | 1187 | 1697.0 |
| frozen + online | 80.0 | 177 | 284.0 | 80.0 | 321 | 521.2 | 80.1 | 1188 | 1698.1 |
| refit, no learning | 80.1 | 177 | 285.1 | 79.7 | 315 | 514.3 | 79.1 | 1041 | 1570.5 |

*P12 later, inspected (25 May – 24 Sep 2026)*

| System | 1 h cover | width | score | 3 h cover | width | score | 24 h cover | width | score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| v3 online layer (for reference) | 80.0 | 187 | 287.4 | 80.0 | 328 | 508.1 | 79.6 | 1307 | 1768.0 |
| refit daily + online learning (v4) | 80.0 | 187 | 287.5 | 80.0 | 328 | 508.2 | 79.6 | 1308 | 1768.4 |
| v4 + daily evolution of the experts | 80.0 | 187 | 287.5 | 80.0 | 328 | 508.2 | 79.6 | 1306 | 1767.3 |
| hedge eta 0.05 | 80.0 | 187 | 287.5 | 80.0 | 328 | 508.2 | 79.6 | 1308 | 1768.4 |
| hedge eta 0.8 | 80.0 | 187 | 287.5 | 80.0 | 328 | 508.1 | 79.6 | 1308 | 1768.4 |
| ranges from past residuals | 80.0 | 188 | 287.7 | 80.0 | 327 | 507.7 | 79.7 | 1307 | 1776.0 |
| **final: the adopted combination** | 80.0 | 187 | 287.4 | 80.0 | 328 | 508.1 | 79.6 | 1307 | 1768.0 |
| frozen + online | 80.0 | 187 | 287.6 | 80.0 | 327 | 508.3 | 79.6 | 1305 | 1767.0 |
| refit, no learning | 80.0 | 182 | 285.7 | 79.8 | 315 | 499.9 | 76.6 | 1023 | 1574.3 |

**What the sequential selection chose** (ADA; from = first day of each choice).

- P0 1 h: 2024-09-24 pair240 → 2024-11-23 pairRW → 2024-12-25 ridge240 → 2025-05-29 pair240 → 2025-08-04 gbc240 → 2025-08-15 neutral → 2025-08-31 gbc240
- P0 3 h: 2024-09-24 pair240 → 2024-11-23 neutral → 2024-12-05 pairRW → 2024-12-13 ridge240 → 2025-03-07 pair240 → 2025-05-07 logit240 → 2025-05-22 pairRW → 2025-07-19 neutral → 2025-08-07 gbdt240
- P0 24 h: 2024-09-24 pair240 → 2024-11-23 neutral → 2025-01-29 logit240 → 2025-02-04 neutral → 2025-02-05 logit240 → 2025-03-01 neutral → 2025-04-10 logit240 → 2025-04-14 neutral → 2025-04-17 logit240 → 2025-05-07 pair240 → 2025-05-11 gbdt240 → 2025-05-29 pair240 → 2025-06-08 gbdt240 → 2025-06-10 pair240 → 2025-07-11 neutral → 2025-07-13 pair240 → 2025-07-17 neutral → 2025-09-08 logit240 → 2025-09-10 neutral → 2025-09-12 logit240 → 2025-09-13 neutral
- P12 1 h: 2025-09-24 pair240 → 2025-11-23 pair120 → 2026-02-25 gbc240 → 2026-03-30 logit240 → 2026-05-05 pair240 → 2026-06-17 logit240 → 2026-08-21 pairRW → 2026-09-23 pair240
- P12 3 h: 2025-09-24 pair240 → 2025-11-23 pairRW → 2026-01-28 gbc240 → 2026-02-15 neutral → 2026-04-09 pairRW → 2026-06-03 logit240 → 2026-08-23 gbdt240 → 2026-08-24 neutral → 2026-09-14 pair240 → 2026-09-20 gbdt240
- P12 24 h: 2025-09-24 pair240 → 2025-11-23 neutral → 2026-02-24 stack → 2026-03-02 neutral → 2026-03-08 stack → 2026-03-18 neutral → 2026-04-03 logit240 → 2026-07-02 stack → 2026-07-09 neutral → 2026-07-17 stack → 2026-07-26 neutral
