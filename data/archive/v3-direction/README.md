# Third record: the direction model before the review

The live record from 26 to 27 September 2026 (ADAptive v3): every 15 minutes a price and a
probability that the price would be higher, for 1 hour, 3 hours and 24 hours, with the direction
from the direction model (settings chosen on Bitcoin). It is kept exactly as the pipeline committed it, together with its
one-year backtest (`backtest.json`, `backtest/`), which the September 2026 review recomputed
(`docs/EXPERIMENTS.md`, "Baseline").

Its scores use v3's definitions, which v4 replaced:
- the displayed price was not the scored one;
- a 50% forecast counted as "up";
- the online learners forgot about 15 times more slowly than configured.

The current record (v4) starts fresh in `data/`.
