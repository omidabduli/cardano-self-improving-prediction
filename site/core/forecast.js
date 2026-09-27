// What a forecast says, in one place: the page shows these numbers, the record stores them and
// the scores judge them, so what people see is exactly what gets checked.
//
//   P(up)     calibrated probability that the price is higher at the horizon (engine.js)
//   direction 'up' / 'down', or 'neutral' when P(up) is within NEUTRAL_EDGE of 50%: no call
//   price     the one predicted price shown, rounded as displayed. Since the September 2026
//             evaluation this is today's price (SHOW_MOVE = false): no formula for the size of the
//             move beat "no change" on the untouched year. The candidate that is still recorded
//             (`shrunk`) is the move implied by P(up) and the size of typical moves, shrunk toward
//             "no change" by a factor the engine learns from outcomes (0 = the implied move has
//             told us nothing about where the price goes, 1 = it is right on average)
//
// The implied move assumes the size of a move doesn't depend on its direction: then
// E[move] = (2p - 1) * E|move|, and for a normal-shaped move E|move| = 0.798 sigma, where the
// calibrated 80% range spans 2 x 1.2816 sigma. Up to v3 the page showed this unshrunk; it was
// about three times too large at 1 hour and pointed the wrong way at 24 hours (research/).

import { NEUTRAL_EDGE, PRICE_DIGITS, SHOW_MOVE } from './config.js';

export const directionOf = (p) => (p - 0.5 >= NEUTRAL_EDGE ? 'up' : 0.5 - p >= NEUTRAL_EDGE ? 'down' : 'neutral');

export const impliedMove = (p, lo80, hi80) => (2 * p - 1) * 0.7979 * (hi80 - lo80) / (2 * 1.2816);

// The shown price for a predicted log-move from price c, rounded as displayed.
export const shownPrice = (c, move) => Number((c * Math.exp(move)).toFixed(PRICE_DIGITS));

/**
 * The forecast as shown and scored.
 * @param {number} c      price when the forecast was made
 * @param {number} p      P(up)
 * @param {number} lo80   80% range, low end (log-move)
 * @param {number} hi80   80% range, high end (log-move)
 * @param {number} beta   shrinkage factor in [0, 1] (engine's shrinkage learner)
 * @param {boolean} [showMove] show the shrunk move (default SHOW_MOVE) or today's price
 * @returns {{direction: string, implied: number, shrunk: number, price: number, move: number}}
 *          move = ln(price / c), the shown move; shrunk = the recorded candidate
 */
export function shownForecast(c, p, lo80, hi80, beta, showMove = SHOW_MOVE) {
  const direction = directionOf(p);
  const implied = impliedMove(p, lo80, hi80);
  const shrunk = direction === 'neutral' ? 0 : beta * implied;
  const price = shownPrice(c, showMove ? shrunk : 0);
  return { direction, implied, shrunk, price, move: Math.log(price / c) };
}
