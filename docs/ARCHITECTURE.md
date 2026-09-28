# Architecture (v4)

This note describes how Bitcast and its sister project ADAptive work since the v4 changes of
September 2026, which followed an outside review. It says exactly what the page displays, what
the record stores and what each score measures, where forecasts come from and how to migrate.
The experiments behind the changes are in [EXPERIMENTS.md](EXPERIMENTS.md).

## Two repositories, one code

The two projects run the same code on different coins:

| | Bitcast | ADAptive |
|---|---|---|
| coin / lead / peer | BTCUSDT / ETHUSDT / SOLUSDT | ADAUSDT / BTCUSDT / ETHUSDT |
| price tick, digits shown | 0.01, 2 | 0.0001, 4 |

`site/core/config.js` is the only code file that differs. Every other file in `site/core/` and
`engine/` is byte-identical in both repositories, and `research/` is shared too. Names, repository
links and the direction model's tuning history live in `ASSET` in config.js. To change shared
code, change it in one repository, copy the shared files to the other, and run both test suites.
`cmp` on the shared files must come out clean. Each project keeps its own models, learned state,
record and scores: nothing learned on one coin is used by the other.

## The pipeline

```
Binance 1-minute candles (coin, lead, peer) + daily Fear & Greed
        │  candles.buildSeries: one gap-free minute grid, validity mask per source
        ▼
features.computeFeatures (55 features, schema f2): a row only where all inputs are real
        │
        ├─► six experts (models.expertPredictions): predicted standardised move
        ├─► direction model (models.directionScores): score for up vs. down
        ▼
engine.Engine (online layer, stepped every minute, forecast every 15 minutes)
        │  Hedge trust weights → ensemble move → 50/80/95% ranges (adaptive conformal)
        │  Platt calibration → P(up)
        │  forecast.shownForecast → the call and the one shown price
        ▼
record (data/): forecasts, outcomes, scores       browser: the same code, live
```

GitHub Actions runs `engine/run.mjs` every 15 minutes (started by cron-job.org). It replays
every minute since the last checkpoint with the published model, resolves forecasts that have
matured, learns online and commits `data/`. Once per UTC day it also retrains every model and
runs the evolution of the return experts. The browser runs the same engine from the same
checkpoint on the live Binance feed, so the page shows forecasts up to the current minute.

## What a forecast is (one definition, used everywhere)

`site/core/forecast.js` is the single place that turns the engine's numbers into what is shown,
stored and scored:

| Field | Meaning |
|---|---|
| `p` | P(up): calibrated probability that the price is higher at the horizon, as shown and scored |
| `pModel` (`pm` in the CSV) | the direction model's own P(up), before a "no reliable signal" horizon sets `p` to 50% |
| `direction` | `up` / `down`, or `neutral` when P(up) is within 2 points of 50% (`NEUTRAL_EDGE`): no call |
| `price` | the one predicted price shown, rounded as displayed: today's price (`SHOW_MOVE = false`) |
| `est` | ln(price / price now): the shown move, 0 while `SHOW_MOVE` is off |
| `implied` | the move implied by the model's P(up): (2p − 1) · 0.798 · σ, σ from the 80% range |
| `shrunk` (`imp` in the CSV) | `beta × implied`, the price candidate kept in the background |
| `beta` | the shrinkage factor in [0, 1], learned online (see below) |
| `ret` (`ens` in the CSV) | the experts' ensemble move; it centres the ranges and is not shown |
| `lo`, `hi` | the 50/80/95% ranges (log-moves), nested by construction |
| `strong` | "strong signal": the call's signal is at least the median of the same horizon's last 7 days of forecasts |

**The shown price is today's price.** In the September 2026 evaluation no formula for the size
of the move beat "no change" under squared error on the untouched year (EXPERIMENTS.md, rule
7), so `SHOW_MOVE` is off and the forecast is its direction.
- **v3's implied move** was shown unshrunk. It was about three times too large at 1 hour and
  pointed the wrong way at 24 hours.
- **The candidate still recorded** is `shrunk`: `beta × implied`, where `beta` comes from a
  least-squares fit of the actual move on the implied move over matured forecasts. Both are in
  volatility units, anchored at 0 (no change) and kept within [0, 1].
- **Switching it on** is a single flag, and would put `shrunk` on the page and in the scores.

**Horizons without a call.** `SHADOW_HORIZONS` (24 hours) always show 50% and "no reliable
signal": the 24-hour direction model lost to a coin flip in every period tested. The model
still runs. Its `pModel` is recorded, and the signal-gate counters score it against a coin (the
`shadow` block of each snapshot in `daily/*.json`), so the record can show if it starts to work.
It is the ridge half of the direction model (`DIRECTION_LIVE` in `engine/train.mjs`). At 1 and
3 hours the model is the incumbent pair.

What is displayed is what is stored and what is scored: the engine keeps the shown move of every
pending forecast and scores exactly that when the outcome arrives (`metrics.addResolution`).

## Scores (metrics version 4)

`site/core/metrics.js` keeps sums that can be added across days:

- **Probability:** Brier score and log loss of P(up) over every forecast with a price move. A
  50% forecast scores exactly like a coin flip.
- **Calls:** accuracy of up/down calls, where "no clear direction" is no call and is never counted
  right or wrong. Significance uses only non-overlapping calls (issued hourly for 1 hour, every
  3 hours for 3 hours, daily at 00:00 UTC for 24 hours). Coverage (the share of forecasts that
  were calls, and the share that were strong-signal calls) is always reported next to accuracy.
- **Shown price:** mean absolute and squared error of its log-move against "no change", and the
  share of outcomes above it.
- **Ranges:** coverage, mean width and the interval score (width plus 2/α times the miss outside
  the range, Gneiting & Raftery 2007) of the 50/80/95% ranges.
- **Legacy:** v3's "R²" (standardised, clipped squared error of the ensemble) is kept as
  `legacyR2`, under its own name.
- **Unavailable outcomes** (no real candle at the horizon) are counted apart and never scored.

v3's aggregates used other definitions. They are archived with the v3 record and are never
merged with v4's. The pipeline refuses to add v4 sums to a file of another metrics version.

## The online layer

Every learner forgets by wall-clock time. It stores, per horizon, the issue time of the last
forecast it learned from, and multiplies its memory by 2^(−Δt / half-life) before adding the new
outcome. Up to v3 the decay was applied once per outcome, i.e. every 15 minutes, while the
half-lives were written in minutes. A "14-day" half-life therefore really lasted about 210 days,
and after 14 days of quarter-hour updates 95.5% of an old loss was still there. A test now checks
that exactly 50% is left after one half-life, including across gaps with no forecasts.

| Learner | What it learns | Half-life |
|---|---|---|
| Hedge | trust weight of each expert, from its recent squared error | 210 days |
| Adaptive conformal | each range's width multiplier, from hits and misses | (a step size per horizon) |
| Platt | the slope from direction score to P(up); no up/down bias; prior 8000 | 450 days |
| Shrinkage | `beta` for the recorded price candidate | 450 days |
| Signal gate counters | each horizon's model P(up) against a coin | 45 days |

The long memories were chosen in the evaluation: once the clock was fixed, the short
half-lives that the code had always claimed made the probabilities worse.

Other rules:

- **Duplicates and ties.** A repeated or out-of-order outcome is ignored. A tie (no price move)
  skips the calibration update, but its time still counts toward the next decay.
- **Nested ranges.** The three range multipliers adapt independently, so the ranges are nested
  after the fact: the 50% range always sits inside the 80% range, and the 80% inside the 95%.
- **Strong signal.** Each forecast is judged against the previous 7 days of forecasts of the same
  horizon, never against outcomes, and only after a full day of them. v3 compared against the
  model's own training-window scores, which are in-sample.

## Data validity

`buildSeries` fills a missing minute with a flat candle at the previous close, so the minute grid
has no gaps. It records which sources were filled in `S.bad` (1 coin, 2 lead, 4 peer).

- **Feature rows.** A feature row is computed only if all three sources have a real candle in
  that minute and at most 5 of the last 60 minutes were filled. Otherwise the row stays empty: no
  model trains on it and no forecast is made from it. The record row is written with status
  `suspended`.
- **Labels.** A carried-forward price is never a label. A training target whose horizon lands on
  a filled minute is empty. A forecast maturing on one is resolved as unavailable: nothing learns
  from it and it is not scored.
- **Fear & Greed.** The pipeline merges each download into its recorded copy with one rule
  (`candles.mergeFearGreed`): the first value recorded for a day is kept for good. A later,
  different value is kept in `rev` for the record but never used.
  - **Freshly published values** get `seen`, the time the pipeline first had them, and count only
    from then on.
  - **Backfilled values** (older ones, or every value at a fresh start) count from 15 minutes
    after their stamp. That is an assumption, since alternative.me doesn't publish its release
    times. All historical training data uses the same assumption.
  - **The browser** reads only the recorded copy, so its features are exactly the record's.

## Provenance: where every forecast comes from

Every row of `data/predictions/YYYY-MM-DD.csv` (record schema 4) says:

| Column | Meaning |
|---|---|
| `id` | ticker and time, e.g. `BTC-2026-09-27T00:14` |
| `time` | open time of the candle the forecast is made from (UTC); it is made when that candle closes |
| `close` | the price then |
| `generated_utc` | when the pipeline computed the row |
| `origin` | `live`: computed within 30 minutes of the candle's close (`LIVE_MAX_LAG_MIN`); `replay`: backfilled later, after an outage |
| `status` | `ok`, or `suspended`: no forecast because the inputs weren't real |
| `inputs` | validity bits of that minute: 1 coin, 2 lead, 4 peer had no candle, 8 too many gaps in the last hour |
| `model` | id of the published model that made it |
| `code` | the git commit the pipeline ran |
| `schema` | record, feature and state versions, e.g. `r4-f2-s2` |
| per horizon | `price`, `est` (bp), `p`, `dir`, `strong`; in the background `pm` (model P(up)), `imp` (shrunk move, bp), `ens` (experts' move, bp); `lo`/`hi` (80% range, bp) |

Only `live` forecasts enter the live score (`daily/*.json` → `days`). Replayed ones are recorded
and scored apart (`replay`), and the page says how many there are. 30 minutes is shorter than the
shortest horizon, so a live forecast was always computed before any of its outcomes existed.

`generated_utc` is what the pipeline says about itself. The evidence of publication is the git
history: each record row first appears in a commit made by GitHub Actions, and GitHub logs every
push. `research/verify-record.mjs` walks that history and reports, per horizon, how many rows
were committed before their outcome was known.

The browser's own forecasts (origin `preview`) are never written anywhere and never enter a score.

## Versions and failing loudly

| What | Where | Current |
|---|---|---|
| record schema (CSV columns) | `engine/store.mjs RECORD_SCHEMA` | 4 |
| feature schema | `features.js FEATURE_SCHEMA` (also in `model.json`) | f2 |
| engine state | `engine.js STATE_VERSION` (also in `state.json`) | 2 |
| metrics | `metrics.js METRICS_VERSION` (also in `daily/*.json`) | 4 |

These rules replace v3's habit of quietly writing zeros:
- **Engine and pipeline.** The engine refuses a checkpoint of another version, or a model of
  another feature schema. The pipeline refuses to append rows to a CSV with another header.
- **Browser.** The page shows a message instead of computing with a mismatched model.
- **Checkpoints.** A non-finite number in the engine's state stops the checkpoint from being
  written at all.
- **Writes.** JSON files are written to a temporary file and renamed, so a crash never leaves a
  half-written file.
- **Status.** `status.json` has a `health` block: data lag, model age, a failed retraining, and
  replayed and suspended forecasts. The page warns when the nightly retraining failed or is
  overdue.

## Migration from v3 to v4

v4 changes the features (schema f2), the engine state, the record's columns and the metrics.
Nothing from v3 can be continued, so v4 starts a new record. The release carries it:

1. In a copy of the repository, `node engine/run.mjs --bootstrap` makes a fresh record (models, a
   30-day warm-up, the checkpoint, `liveSince`). `node engine/backtest.mjs --evolve` then adds the
   one-year backtest ending where that record begins.
2. That fresh record goes into `data/launch/`, with a file `ARCHIVE_AS` naming the archive folder
   (`v3-direction`) and a `data/archive/v3-direction/README.md` saying what the old record was.
   The release adds only these new files, and the bot never changes them, so it can be merged
   whenever it has been reviewed.
3. After the merge, the first pipeline run (`switchToLaunch` in `engine/run.mjs`):
   - moves the current record, unchanged, into `data/archive/v3-direction/`;
   - puts the launch in its place;
   - replays every minute since the launch. Those forecasts are replays and stay out of the live
     score.

A later schema change follows the same steps. The engine and the pipeline refuse to mix versions,
so a forgotten step fails visibly instead of quietly corrupting the record.

## Shared-code check

```bash
for f in site/core/*.js engine/*.mjs research/*.mjs site/assets/*.js; do
  [ "$f" = site/core/config.js ] || cmp -s "$f" "../Cardano Self improving prediction/$f" || echo "differs: $f"
done
```
