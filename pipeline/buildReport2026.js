// Bake the 2026 model REPORT CARD into app/report-data.js (window.WC_REPORT) + .json.
//
// Grades the FROZEN pre-tournament forecast (app/data.json — 50k sims, built before a ball
// was kicked, never re-baked) against what actually happened (data/live/latest.json, the
// real openfootball results). Everything here is derived; no numbers are hand-entered.
//
//   node buildReport2026.js
//
// Honesty notes:
//  - The graded model is the pre-tournament prior, NOT the live conditional forecast (which
//    now trivially reads the champion at 100%). app/data.json is only touched by the initial
//    build, so it is a fair, hindsight-free prior.
//  - No betting-market comparison: unlike the 2022 backtest there is no single, cleanly-dated
//    2026 outright source in the repo, and inventing one would be dishonest. We show the
//    model's own call vs the real finish instead.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { reliability, brier, logloss } from './lib/calibration.js';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'app');
const data = JSON.parse(readFileSync(join(APP, 'data.json'), 'utf8'));
const live = JSON.parse(readFileSync(join(ROOT, 'data', 'live', 'latest.json'), 'utf8'));

const SIMS = data.meta.sims;
const byNameReach = Object.fromEntries(data.stats.reach.map((r) => [r.name, r]));
const teamMeta = Object.fromEntries(data.teams.map((t) => [t.name, t]));
const rankOf = (n) => (teamMeta[n] ? teamMeta[n].fieldRank : 99);

// ---- real results → who actually reached each round ----
// A team "reaches R16" iff it WON its R32 tie, "reaches QF" iff it won its R16 tie, etc.
const ko = live.matches.filter((m) => m.round !== 'group' && m.finished && m.winner);
const winnersOf = (round) => ko.filter((m) => m.round === round).map((m) => m.winner);
const reached = {
  r16: new Set(winnersOf('R32')),
  qf: new Set(winnersOf('R16')),
  sf: new Set(winnersOf('QF')),
  final: new Set(winnersOf('SF')),
};
const finalM = ko.find((m) => m.round === 'final');
const tpM = ko.find((m) => m.round === '3rd_place');
const other = (m, t) => (t === m.home ? m.away : m.home);
const champion = finalM.winner;
const runnerUp = other(finalM, champion);
const third = tpM ? tpM.winner : null;
const fourth = tpM ? other(tpM, tpM.winner) : null;
reached.title = new Set([champion]);

const ROUNDS = ['r16', 'qf', 'sf', 'final', 'title'];
const REACHED_COUNT = { r16: 16, qf: 8, sf: 4, final: 2, title: 1 }; // teams reaching each round
const DEPTH = { group: 0, r16: 1, qf: 2, sf: 3, final: 4, title: 5 };
const DEEPEST = ['title', 'final', 'sf', 'qf', 'r16'];
const deepest = (hit) => DEEPEST.find((r) => hit[r]) || 'group';

// ---- outright: each team's pre-tournament reach probabilities + real outcome ----
const outright = data.teams.map((t) => {
  const r = byNameReach[t.name] || {};
  const prob = ROUNDS.reduce((o, k) => ((o[k] = (r[k] || 0) / SIMS), o), {});
  const hit = ROUNDS.reduce((o, k) => ((o[k] = reached[k].has(t.name) ? 1 : 0), o), {});
  return { name: t.name, code: t.code, fieldRank: t.fieldRank, worldRank: t.worldRank, prob, hit, reached: deepest(hit) };
}).sort((a, b) => b.prob.title - a.prob.title);
const byName = Object.fromEntries(outright.map((o) => [o.name, o]));

// ---- calibration over every (team, round) reach prediction ----
const points = [];
for (const o of outright) for (const r of ROUNDS) points.push({ p: o.prob[r], outcome: o.hit[r], round: r });
const nTeams = outright.length;
const baselinePoints = points.map((pt) => ({ ...pt, p: REACHED_COUNT[pt.round] / nTeams })); // predict each round's base rate
const calibration = {
  n: points.length,
  reliability: reliability(points, 10),
  brier: brier(points),
  brierBaseline: brier(baselinePoints),
  logloss: logloss(points),
  byRound: Object.fromEntries(ROUNDS.map((r) => [r, brier(points.filter((p) => p.round === r))])),
};

// ---- headline calls ----
const champObj = byName[champion];
const champRank = outright.findIndex((o) => o.name === champion) + 1; // by title odds
const modelTop4 = outright.slice(0, 4);
const semifinalists = [...reached.sf];
const top4Hits = modelTop4.filter((o) => reached.sf.has(o.name)).length;
// the actual final's rank among all predicted final pairings
const finalKey = [champion, runnerUp].sort().join(' v ');
const finalIdx = data.stats.finals.findIndex((f) => f.pair.split(' v ').sort().join(' v ') === finalKey);
const finalCall = { pair: finalKey, rank: finalIdx >= 0 ? finalIdx + 1 : null, pct: finalIdx >= 0 ? data.stats.finals[finalIdx].pct / 100 : null };

// ---- knockout-method calibration (predicted vs actual frequencies) ----
const koN = ko.length;
const method = {
  koGames: koN,
  pens: { actual: ko.filter((m) => m.decidedBy === 'PENS').length / koN, pred: data.stats.knockout.pensPct / 100 },
  et: { actual: ko.filter((m) => m.decidedBy === 'ET').length / koN, pred: data.stats.knockout.etPct / 100 },
  upset: { actual: ko.filter((m) => rankOf(m.winner) > rankOf(other(m, m.winner))).length / koN, pred: data.stats.knockout.upsetPct / 100 },
};

// ---- receipts (factual, bilingual captions rendered by kind) ----
const darkHorse = [...outright].filter((o) => o.prob.title < 0.05)
  .sort((a, b) => DEPTH[deepest(b.hit)] - DEPTH[deepest(a.hit)] || a.prob.sf - b.prob.sf)[0];
const favouriteFell = [...outright].filter((o) => ['group', 'r16'].includes(deepest(o.hit)) && o.prob.title >= 0.03)
  .sort((a, b) => b.prob.title - a.prob.title)[0];
// who knocked the dark horse's most famous victim out — for the caption (Norway beat Brazil)
const dhVictimGame = darkHorse && ko.find((m) => (m.winner === darkHorse.name) && rankOf(other(m, m.winner)) <= 8);
const receipts = [
  { kind: 'champion', name: champion, code: champObj.code, titlePct: champObj.prob.title, rank: champRank },
  { kind: 'chalk', top4: modelTop4.map((o) => ({ name: o.name, code: o.code })), hits: top4Hits },
  darkHorse && { kind: 'darkHorse', name: darkHorse.name, code: darkHorse.code, titlePct: darkHorse.prob.title,
    reached: deepest(darkHorse.hit), victim: dhVictimGame ? other(dhVictimGame, darkHorse.name) : null,
    victimRank: dhVictimGame ? rankOf(other(dhVictimGame, darkHorse.name)) : null },
  favouriteFell && { kind: 'favouriteFell', name: favouriteFell.name, code: favouriteFell.code,
    titlePct: favouriteFell.prob.title, rank: outright.findIndex((o) => o.name === favouriteFell.name) + 1, reached: deepest(favouriteFell.hit) },
].filter(Boolean);

const report = {
  meta: {
    title: 'AI World Cup 2026 — model report card',
    built: new Date().toISOString().slice(0, 10),
    tournament: 'FIFA World Cup 2026',
    ratingSnapshot: data.meta.ratingSnapshot,
    sims: SIMS,
    frozenModel: true,
    sources: {
      ratings: `${data.meta.ratingSource} (${data.meta.ratingSnapshot})`,
      results: 'openfootball/worldcup.json (2026) — public domain',
      resultsUrl: live.sourceUrl,
      asOfDate: live.asOfDate,
    },
    teamNamesEs: data.meta.teamNamesEs,
  },
  realChampion: champion,
  finish: { champion, runnerUp, third, fourth },
  champion: { name: champion, code: champObj.code, fieldRank: champObj.fieldRank, titlePct: champObj.prob.title, rank: champRank },
  chalk: { modelTop4: modelTop4.map((o) => ({ name: o.name, code: o.code, titlePct: o.prob.title })), semifinalists, hits: top4Hits },
  finalCall,
  method,
  calibration,
  outright,
  receipts,
};

// ---- sanity gate: the report must reconcile with the real results and beat the baseline ----
assert.equal(report.champion.name, finalM.winner, 'champion must be the real final winner');
assert.equal(calibration.n, outright.length * ROUNDS.length, 'one calibration point per (team, round)');
assert.ok(calibration.brier < calibration.brierBaseline, 'model Brier must beat the naive base-rate baseline');
assert.ok(champObj.prob.title > 0 && champRank >= 1, 'champion needs a real pre-tournament title prob + rank');
assert.equal(new Set([...reached.sf]).size, 4, 'exactly four semi-finalists');
assert.ok(finalCall.rank >= 1, 'the real final must appear among the predicted pairings');
assert.equal(receipts.length, 4, 'four receipts (champion, chalk, dark horse, favourite fell)');
for (const b of calibration.reliability) assert.ok(b.meanP >= 0 && b.obs >= 0 && b.obs <= 1, 'reliability bins in range');

mkdirSync(APP, { recursive: true });
writeFileSync(join(APP, 'report-data.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(APP, 'report-data.js'), `window.WC_REPORT = ${JSON.stringify(report)};\n`);

const pc = (x) => (100 * x).toFixed(1);
console.log('build:report — wrote app/report-data.js + app/report-data.json');
console.log(`  champion ${champion} · model #${champRank} title pick at ${pc(champObj.prob.title)}%`);
console.log(`  top-4 chalk: ${top4Hits}/4 of the model's title top-4 were semi-finalists`);
console.log(`  actual final ${finalKey}: model's #${finalCall.rank} most-likely final (${pc(finalCall.pct)}%)`);
console.log(`  Brier ${calibration.brier.toFixed(4)} vs baseline ${calibration.brierBaseline.toFixed(4)} · logloss ${calibration.logloss.toFixed(3)} · n=${calibration.n}`);
console.log(`  method: pens ${pc(method.pens.actual)}%/${pc(method.pens.pred)}% · ET ${pc(method.et.actual)}%/${pc(method.et.pred)}% · upsets ${pc(method.upset.actual)}%/${pc(method.upset.pred)}%`);
console.log(`  receipts: ${receipts.map((r) => `${r.kind}:${r.name || r.hits + '/4'}`).join(', ')}`);
