// FIFA-Elo rating update — replays the REAL played results onto the frozen base
// ratings (1 April 2026 FIFA points) using FIFA's own "SUM" points-exchange formula,
// so the live ratings are earned ON THE PITCH by a documented, citable rule — not
// form or vibes. Pairs with the model's 600 divisor (lib/model.js).
//
//   P_after = P_before + I · (W − We)
//     We = 1 / (1 + 10^(−(Ra − Rb)/600))            win-expectancy (winExpectancy, model.js)
//     W  = 1 win / 0.5 draw / 0 loss;  shootout: 0.75 winner, 0.25 loser   (FIFA rule)
//     I  = importance coefficient (see IMPORTANCE below)
//
// Source: FIFA / Coca-Cola Men's World Ranking procedure ("SUM"). The per-round
// importance coefficients below follow FIFA's published values for World Cup final
// matches — VERIFY against FIFA's procedure doc before shipping live numbers.
//
// Zero-sum per match (ΔA + ΔB = 0): a win transfers exactly what the loss costs, so
// the field's total rating is conserved and "updated power" stays grounded.

import { winExpectancy } from './model.js';

// FIFA importance for World Cup *final competition* matches. (TODO: confirm exact split.)
export const IMPORTANCE = {
  group: 50, R32: 50, R16: 50, QF: 50, // group stage through quarter-finals
  SF: 60, final: 60, '3rd_place': 60, // semi-finals onward
};
export const importanceFor = (round) => IMPORTANCE[round] ?? 50;

// Result value W for [home, away] given the outcome. Penalty shootouts use FIFA's
// 0.75/0.25 split (the 90'/ET score was level); everything else is win/draw/loss.
function valuesFor(m) {
  if (m.decidedBy === 'PENS') return m.winner === m.home ? [0.75, 0.25] : [0.25, 0.75];
  if (m.homeGoals > m.awayGoals) return [1, 0];
  if (m.homeGoals < m.awayGoals) return [0, 1];
  return [0.5, 0.5];
}

// base: { [teamName]: ratingPoints }  (the frozen 1-April strengths)
// played: array of FINISHED matches, in CHRONOLOGICAL order, each
//   { home, away, homeGoals, awayGoals, winner, decidedBy:'REG'|'ET'|'PENS', round }
// Returns { ratings: {name: updatedPoints}, log: {name: {from,to,played,delta}} }.
export function updateRatings(base, played, opts = {}) {
  const importance = opts.importance || importanceFor;
  const r = new Map(Object.entries(base));
  const log = {};
  const touch = (name) => (log[name] ||= { from: base[name], played: 0, delta: 0 });

  for (const m of played) {
    const ra = r.get(m.home), rb = r.get(m.away);
    if (ra == null || rb == null) continue; // unmapped team — caller validates names first
    const weHome = winExpectancy(ra, rb);          // weAway = 1 − weHome (symmetry)
    const [wH, wA] = valuesFor(m);
    const I = typeof importance === 'function' ? importance(m.round) : importance;
    const dH = I * (wH - weHome);
    const dA = I * (wA - (1 - weHome));
    r.set(m.home, ra + dH);
    r.set(m.away, rb + dA);
    touch(m.home).played++; log[m.home].delta += dH;
    touch(m.away).played++; log[m.away].delta += dA;
  }

  const ratings = Object.fromEntries(r);
  for (const k of Object.keys(log)) log[k].to = ratings[k];
  return { ratings, log };
}
