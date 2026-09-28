# ADAptive

**Live: https://omidabduli.github.io/cardano-self-improving-prediction/**

A small learning project. Every 15 minutes it guesses whether the Cardano (ADA) price will be higher in 1, 3 and 24 hours. Later it checks each guess against the real price and keeps the score in public.

It has a twin for Bitcoin, [Bitcast](https://github.com/omidabduli/bitcoin-self-improving-prediction). The code is the same and only the coin is different.

## Why I built this

I love prediction, and I wanted to learn how it really works. Nassim Taleb and Ray Dalio taught me to be realistic and not to mistake luck for skill. Checking a prediction against what actually happened is a good way to practise that.

## What I found

Mostly that it is hard. On a year of data I never used for tuning (September 2024 to September 2025), the model called the 1-hour direction right 53.1% of the time. That is a little better than a coin flip. The 3-hour calls were close to a coin flip in recent months, and the 24-hour ones were worse than one. I still show both, and the live record will say if they're worth anything. Calls where the model was less than 52% sure were coin flips, so since 28 September it makes no call below that. No formula for the size of the move beat simply using today's price.

So please don't trade on it. At these numbers, fees would eat the difference.

## How it works

There is no server. Your browser runs the model on live Binance prices. A GitHub Actions job does the same every 15 minutes and commits the official record to `data/`. After each result the model adjusts a little, and every night it retrains.

Everything is plain JavaScript with no dependencies. The details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and every test I ran is in [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md).

## Run it yourself

You need Node.js 22 or newer.

```bash
npm test                          # unit tests
node engine/run.mjs --bootstrap   # fetch data, train, warm up (about 5 minutes)
node engine/serve.mjs             # preview on http://localhost:8787
```

## Credits

Prices come from Binance's public API and the Fear & Greed index from [alternative.me](https://alternative.me/crypto/fear-and-greed-index/). This project is not affiliated with Cardano, Binance or alternative.me. It is not financial advice.

MIT licensed. Made by Omid Abduli.
