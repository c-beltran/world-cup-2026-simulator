// The match model: Poisson scorelines parameterized by the Elo/FIFA rating gap.
//
// This is the honest core. It is NOT a win-probability formula with a draw band —
// it samples real goals, so draws, goal difference and goals-for emerge naturally
// (needed for group tiebreakers) and every knockout game has a real scoreline + an
// extra-time/penalties flag (needed for narration).
//
// Mapping (rating gap -> goals):
//   1. We = 1 / (1 + 10^(-(Ra - Rb)/600))     FIFA's own win-expectancy curve (divisor 600)
//   2. supremacy = SUPREMACY_MAX * (2*We - 1)  bounded expected goal difference, in (-MAX, MAX)
//   3. lambdaA = TOTAL/2 + supremacy/2,  lambdaB = TOTAL/2 - supremacy/2   (sum = TOTAL)
//   4. goalsA ~ Poisson(lambdaA), goalsB ~ Poisson(lambdaB)
//
// Using divisor 600 (FIFA's value, not the PRD's generic 400) keeps the model
// consistent with the "real FIFA method" claim and stops favorites being overstated.
// Constants below are tuned to ~2.5-2.8 goals/game and a believable upset rate.

import { poisson } from './rng.js';

export const MODEL = {
  ELO_DIVISOR: 600, // FIFA's own logistic divisor
  TOTAL_GOALS: 2.62, // base; the MIN_LAMBDA floor lifts the realized mean to ~2.7
  SUPREMACY_MAX: 2.1, // cap on expected goal difference for the most lopsided games
  MIN_LAMBDA: 0.2, // floor so even big underdogs can score
  ET_FRACTION: 1 / 3, // extra time is 30 of 90 minutes
  PEN_TILT: 0.3, // how far a shootout leans to the better side (0 = coin flip)
  CINDERELLA_RANK: 24, // a "Cinderella" is a team ranked outside the top 24 reaching SF+
};

export function winExpectancy(ra, rb, divisor = MODEL.ELO_DIVISOR) {
  return 1 / (1 + Math.pow(10, -(ra - rb) / divisor));
}

// Expected goals (lambdas) for a match between ratings ra, rb.
export function expectedGoals(ra, rb, m = MODEL) {
  const we = winExpectancy(ra, rb, m.ELO_DIVISOR);
  const supremacy = m.SUPREMACY_MAX * (2 * we - 1);
  const la = Math.max(m.MIN_LAMBDA, m.TOTAL_GOALS / 2 + supremacy / 2);
  const lb = Math.max(m.MIN_LAMBDA, m.TOTAL_GOALS / 2 - supremacy / 2);
  return [la, lb];
}

// Group-stage match: 90 minutes, a draw is a real result. Returns goals only.
export function playGroupMatch(rng, a, b, m = MODEL) {
  const [la, lb] = expectedGoals(a.strength, b.strength, m);
  return [poisson(rng, la), poisson(rng, lb)];
}

// Knockout match: must produce a winner. 90' -> extra time -> penalties.
// Returns { ga, gb, winner, loser, decidedBy } where decidedBy is 'REG' | 'ET' | 'PENS'.
export function playKnockoutMatch(rng, a, b, m = MODEL) {
  const [la, lb] = expectedGoals(a.strength, b.strength, m);
  let ga = poisson(rng, la);
  let gb = poisson(rng, lb);
  let decidedBy = 'REG';

  if (ga === gb) {
    // Extra time: same rates scaled to 30 minutes.
    ga += poisson(rng, la * m.ET_FRACTION);
    gb += poisson(rng, lb * m.ET_FRACTION);
    decidedBy = 'ET';
  }
  if (ga === gb) {
    // Penalties: near coin flip, slightly tilted toward the stronger side.
    const we = winExpectancy(a.strength, b.strength, m.ELO_DIVISOR);
    const pA = 0.5 + (we - 0.5) * m.PEN_TILT;
    const aWins = rng() < pA;
    return { ga, gb, winner: aWins ? a : b, loser: aWins ? b : a, decidedBy: 'PENS' };
  }
  const aWins = ga > gb;
  return { ga, gb, winner: aWins ? a : b, loser: aWins ? b : a, decidedBy };
}
