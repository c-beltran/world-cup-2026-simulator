// 2022 World Cup BACKTEST — the exact same engine, frozen, applied to Qatar 2022 with
// ONLY pre-tournament inputs (6 Oct 2022 FIFA ratings, real groups/bracket). Measures
// how well-calibrated the forecast was.
//
//   node backtest2022.js [sims]     (default 50000)   env: SIMS, SEED
//
// Produces, into pipeline/out/backtest-2022.json:
//   - pre-tournament outright probabilities per team (reach R16/QF/SF/Final/Title)
//   - the REAL rounds each team reached (from a clamp-all sim → ground truth)
//   - per-match W/D/L predictions for the 48 group games (ratings Elo-updated as the
//     group stage unfolds), with actual outcomes
//   - a calibration dataset of (predicted probability, did-it-happen) pairs
//   - sanity: clamping all 64 results must reproduce champion Argentina
//
// The model is UNCHANGED from 2026 (same MODEL constants, divisor 600). No tuning to fit.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, simSeed } from './lib/rng.js';
import { prepareBracket, simulateTournament, pairKey } from './lib/tournament.js';
import { MODEL, expectedGoals } from './lib/model.js';
import { updateRatings } from './lib/elo.js';
import { reliability, brier, logloss } from './lib/calibration.js';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const read = (p) => JSON.parse(readFileSync(join(ROOT, 'data', '2022', p), 'utf8'));

const teamsDoc = read('teams.json');
const groupsDoc = read('groups.json');
const bracketDoc = read('bracket.json');
const of = read('results-openfootball.json');
const bracket = prepareBracket(bracketDoc);

const SIMS = Number(process.argv[2] || process.env.SIMS || 50000);
const MASTER_SEED = Number(process.env.SEED || 20221120);

// ---- normalize the real 2022 results from openfootball ----
const ROUND = (r) => {
  if (/^Matchday/i.test(r)) return 'group';
  if (/Round of 16/i.test(r)) return 'R16';
  if (/Quarter/i.test(r)) return 'QF';
  if (/Semi/i.test(r)) return 'SF';
  if (/third place/i.test(r)) return '3rd_place';
  if (/^Final/i.test(r)) return 'final';
  return r;
};
function normalize(m) {
  const ft = m.score && m.score.ft;
  if (!Array.isArray(ft)) return null;
  const p = m.score.p, et = m.score.et;
  let decidedBy = 'REG', hg = ft[0], ag = ft[1], winSide = null;
  if (Array.isArray(p)) { decidedBy = 'PENS'; winSide = p[0] > p[1] ? 'home' : 'away'; }
  else if (Array.isArray(et)) { decidedBy = 'ET'; hg = et[0]; ag = et[1]; winSide = hg > ag ? 'home' : ag > hg ? 'away' : null; }
  else { winSide = hg > ag ? 'home' : ag > hg ? 'away' : null; }
  return {
    date: m.date, time: m.time || null, round: ROUND(m.round),
    group: m.group ? m.group.replace(/^Group\s+/i, '').trim() : null,
    home: m.team1, away: m.team2, homeGoals: hg, awayGoals: ag, decidedBy,
    winner: winSide === 'home' ? m.team1 : winSide === 'away' ? m.team2 : null,
  };
}
const results = of.matches.map(normalize).filter(Boolean)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const base = Object.fromEntries(teamsDoc.teams.map((t) => [t.name, t.strength]));

// build a clamp object from a set of finished matches
function buildClamp(played) {
  const clamp = { groups: new Map(), ko: new Map() };
  for (const m of played) {
    if (m.round === 'group') {
      if (!clamp.groups.has(m.group)) clamp.groups.set(m.group, new Map());
      clamp.groups.get(m.group).set(pairKey(m.home, m.away), { [m.home]: m.homeGoals, [m.away]: m.awayGoals });
    } else {
      clamp.ko.set(pairKey(m.home, m.away), { goals: { [m.home]: m.homeGoals, [m.away]: m.awayGoals }, winner: m.winner, decidedBy: m.decidedBy });
    }
  }
  return clamp;
}
const teamsByNameWith = (ratings) => new Map(teamsDoc.teams.map((t) => [t.name, { ...t, strength: ratings[t.name] ?? t.strength }]));

// ---- SANITY GATE: clamp all 64 → must reproduce the real champion (Argentina) ----
const { ratings: finalRatings } = updateRatings(base, results);
const fullClamp = buildClamp(results);
const realSim = simulateTournament(teamsByNameWith(finalRatings), groupsDoc, bracket, mulberry32(simSeed(MASTER_SEED, 0)), MODEL, fullClamp);
const realChampion = realSim.champion.name;
const realReach = {
  r16: new Set(realSim.reach.r16.map((t) => t.name)),
  qf: new Set(realSim.reach.qf.map((t) => t.name)),
  sf: new Set(realSim.reach.sf.map((t) => t.name)),
  final: new Set(realSim.reach.final.map((t) => t.name)),
  title: new Set([realChampion]),
};
if (realChampion !== 'Argentina') {
  console.error(`SANITY FAIL: clamp-all champion is ${realChampion}, expected Argentina. Check bracket wiring / results.`);
  process.exit(1);
}

// ---- PRE-TOURNAMENT outright forecast: 50k conditional MC, zero games clamped ----
const teamsByName = teamsByNameWith(base);
const reachCount = new Map();
const rc = (n) => { let r = reachCount.get(n); if (!r) reachCount.set(n, (r = { r16: 0, qf: 0, sf: 0, final: 0, title: 0 })); return r; };
let completed = 0;
for (let i = 0; i < SIMS; i++) {
  let sim;
  try { sim = simulateTournament(teamsByName, groupsDoc, bracket, mulberry32(simSeed(MASTER_SEED, i)), MODEL); }
  catch { continue; }
  completed++;
  for (const t of sim.reach.r16) rc(t.name).r16++;
  for (const t of sim.reach.qf) rc(t.name).qf++;
  for (const t of sim.reach.sf) rc(t.name).sf++;
  for (const t of sim.reach.final) rc(t.name).final++;
  rc(sim.champion.name).title++;
}
const ROUNDS = ['r16', 'qf', 'sf', 'final', 'title'];
const outright = teamsDoc.teams.map((t) => {
  const c = reachCount.get(t.name) || { r16: 0, qf: 0, sf: 0, final: 0, title: 0 };
  const prob = {}, hit = {};
  for (const r of ROUNDS) { prob[r] = c[r] / completed; hit[r] = realReach[r].has(t.name) ? 1 : 0; }
  return { name: t.name, code: t.code, fieldRank: t.fieldRank, worldRank: t.worldRank, prob, hit };
}).sort((a, b) => b.prob.title - a.prob.title);

// ---- PER-MATCH W/D/L predictions for the 48 group games (Elo-updated as we go) ----
const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
const pois = (l, k) => (Math.exp(-l) * Math.pow(l, k)) / fact(k);
function wdl(home, away, ratings) {
  const [la, lb] = expectedGoals(ratings[home], ratings[away], MODEL);
  const ph = Array.from({ length: 11 }, (_, k) => pois(la, k));
  const pa = Array.from({ length: 11 }, (_, k) => pois(lb, k));
  let h = 0, d = 0, a = 0;
  for (let x = 0; x < 11; x++) for (let y = 0; y < 11; y++) { const p = ph[x] * pa[y]; if (x > y) h += p; else if (x < y) a += p; else d += p; }
  return { h, d, a };
}
const groupResults = results.filter((m) => m.round === 'group');
const matchPreds = [];
for (let i = 0; i < groupResults.length; i++) {
  const m = groupResults[i];
  const prior = groupResults.slice(0, i); // chronological — only earlier group games inform the rating
  const { ratings } = updateRatings(base, prior);
  const pr = wdl(m.home, m.away, ratings);
  const actual = m.homeGoals > m.awayGoals ? 'h' : m.homeGoals < m.awayGoals ? 'a' : 'd';
  matchPreds.push({ date: m.date, home: m.home, away: m.away, p: pr, actual });
}

// ---- assemble the calibration dataset: binary (predicted prob, did-it-happen) pairs ----
const points = [];
for (const o of outright) for (const r of ROUNDS) points.push({ p: o.prob[r], outcome: o.hit[r], kind: 'outright', round: r });
for (const mp of matchPreds) for (const k of ['h', 'd', 'a']) points.push({ p: mp.p[k], outcome: mp.actual === k ? 1 : 0, kind: 'match' });

const baselinePoints = points.map((pt) => ({ ...pt, p: pt.kind === 'match' ? 1 / 3 : null })); // match baseline = 1/3 each
// outright baseline: predict each round's base rate (16/32, 8/32, 4/32, 2/32, 1/32)
const BASE_RATE = { r16: 16 / 32, qf: 8 / 32, sf: 4 / 32, final: 2 / 32, title: 1 / 32 };
for (const bp of baselinePoints) if (bp.p === null) bp.p = BASE_RATE[bp.round];

const out = {
  kind: 'backtest', tournament: 'FIFA World Cup 2022',
  generatedFrom: { ratings: teamsDoc.ratingSnapshot, results: 'openfootball/worldcup.json (2022)' },
  config: { sims: SIMS, completed, masterSeed: MASTER_SEED, model: MODEL, frozen: true },
  sanity: { clampAllChampion: realChampion, expected: 'Argentina', ok: realChampion === 'Argentina' },
  realChampion,
  outright,
  matchPreds,
  calibration: {
    n: points.length,
    reliability: reliability(points, 10),
    brier: brier(points),
    brierBaseline: brier(baselinePoints),
    logloss: logloss(points),
    byRound: Object.fromEntries(ROUNDS.map((r) => [r, brier(points.filter((p) => p.kind === 'outright' && p.round === r))])),
    matchBrier: brier(points.filter((p) => p.kind === 'match')),
    matchBrierBaseline: brier(baselinePoints.filter((p) => p.kind === 'match')),
  },
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'backtest-2022.json'), JSON.stringify(out, null, 2) + '\n');

// ---- console report ----
const pct = (x) => (100 * x).toFixed(1);
console.log(`\n2022 BACKTEST — ${completed.toLocaleString()} sims · model FROZEN · sanity champion: ${realChampion} (${out.sanity.ok ? 'OK' : 'FAIL'})`);
console.log(`\nPRE-TOURNAMENT TITLE ODDS (top 8) — model vs what happened:`);
for (const o of outright.slice(0, 8)) console.log(`  ${o.name.padEnd(13)} ${pct(o.prob.title).padStart(5)}%  title · reached ${['title', 'final', 'sf', 'qf', 'r16'].find((r) => o.hit[r]) || 'group'}`);
console.log(`\nCALIBRATION over ${points.length} predictions:`);
console.log(`  Brier ${out.calibration.brier.toFixed(4)}  (baseline ${out.calibration.brierBaseline.toFixed(4)})  · lower is better`);
console.log(`  per-match Brier ${out.calibration.matchBrier.toFixed(4)} (baseline ${out.calibration.matchBrierBaseline.toFixed(4)})`);
console.log(`\nReliability (predicted → observed):`);
for (const b of out.calibration.reliability) if (b.n) console.log(`  ${pct(b.lo)}-${pct(b.hi)}%: predicted ${pct(b.meanP)}% → observed ${pct(b.obs)}%  (n=${b.n})`);
console.log(`\nWrote pipeline/out/backtest-2022.json\n`);
