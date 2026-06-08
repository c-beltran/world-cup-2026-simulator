// Stage 2 — Monte Carlo.
// Runs N tournaments over the real groups + real bracket wiring, aggregates the
// stats, validates the structure, selects + persists the featured sims (full
// bracket paths), and writes pipeline/out/sim-results.json.
//
//   node simulate.js [sims]      (default 50000)   env: SIMS, SEED
//
// All ranks are FIELD rank (1-48). worldRank is carried only as flavor.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, simSeed } from './lib/rng.js';
import { prepareBracket, simulateTournament } from './lib/tournament.js';
import { serializeSim } from './lib/serialize.js';
import { MODEL, winExpectancy } from './lib/model.js';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const read = (p) => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));

const teamsDoc = read('teams.json');
const groupsDoc = read('groups.json');
const bracketDoc = read('bracket.json');

const teamsByName = new Map(teamsDoc.teams.map((t) => [t.name, t]));
const bracket = prepareBracket(bracketDoc);

const SIMS = Number(process.argv[2] || process.env.SIMS || 50000);
const MASTER_SEED = Number(process.env.SEED || 20260611);

// Featured Cinderella is LOCKED to the user's pick (Canada, co-host) — chosen for
// the 2026-in-North-America narrative, not auto-selected. Index is seed-specific.
const FEATURED_CINDERELLA = { team: 'Canada', index: 50 };

const runSim = (i) => simulateTournament(teamsByName, groupsDoc, bracket, mulberry32(simSeed(MASTER_SEED, i)), MODEL);

// ---- aggregators ----
const championCount = new Map();
const finalistCount = new Map();
const reach = new Map(); // name -> {r32,r16,qf,sf,final,title}
const finalPairs = new Map();
const cinderellaTeam = new Map();
let simsWithCinderella = 0;

const totals = { groupGoals: 0, koGoals: 0, favWin: 0, draw: 0, dogWin: 0, koUpsets: 0, et: 0, pens: 0 };
const violations = { roundSize: 0, selfMatch: 0, ineligibleThird: 0, matchingFail: 0 };

// featured candidates (best on the fly; replayed for full detail after the loop)
const bestChalkByChamp = new Map(); // champ -> {index, chalk}
let bestCinderella = null; // most extreme underdog SF+ (informational)
let chalkFinal = null; // most top-heavy final
let chaosRun = null; // most cumulative upset magnitude

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const reachOf = (name) => {
  let r = reach.get(name);
  if (!r) reach.set(name, (r = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, title: 0 }));
  return r;
};

// ---- Pick-Your-Nation selection (Option B) ----
// For every team, track the single BEST sim for each possible deepest round, where
// "best" = most aggregate upset magnitude along the team's OWN knockout wins (its most
// dramatic run that ends in that round). After the loop, a team's "ceiling" = the
// deepest round it reaches in >=1% of sims, and we feature the best sim ending there.
const NATION_BUCKETS = ['r32', 'r16', 'qf', 'sf', 'final', 'title']; // indexed by deepest-round rank
const RRANK = { R32: 0, R16: 1, QF: 2, SF: 3, final: 4 };
const muUpset = (w, l) => { const we = winExpectancy(w.strength, l.strength); return we < 0.5 ? 0.5 - we : 0; };
// name -> { bucket -> Map(headlineVictim -> { index, dramatic }) }: best sim PER DISTINCT giant
// toppled, so a shallow run can be steered to a different giant when its first choice is taken.
const nationBest = new Map();

const t0 = performance.now();
for (let i = 0; i < SIMS; i++) {
  let sim;
  try {
    sim = runSim(i);
  } catch {
    violations.matchingFail++;
    continue;
  }

  // structural validation
  if (
    sim.reach.r32.length !== 32 ||
    sim.reach.r16.length !== 16 ||
    sim.reach.qf.length !== 8 ||
    sim.reach.sf.length !== 4 ||
    sim.reach.final.length !== 2
  ) {
    violations.roundSize++;
  }
  for (const mm of bracket.matches) {
    if (sim.results[mm.id].home === sim.results[mm.id].away) violations.selfMatch++;
  }
  for (const slot of bracket.thirdSlots) {
    if (!slot.eligible.has(sim.slotToGroup.get(slot.id))) violations.ineligibleThird++;
  }

  // tallies
  bump(championCount, sim.champion.name);
  reachOf(sim.champion.name).title++;
  for (const t of sim.reach.final) {
    bump(finalistCount, t.name);
    reachOf(t.name).final++;
  }
  for (const t of sim.reach.sf) reachOf(t.name).sf++;
  for (const t of sim.reach.qf) reachOf(t.name).qf++;
  for (const t of sim.reach.r16) reachOf(t.name).r16++;
  for (const t of sim.reach.r32) reachOf(t.name).r32++;

  const [fa, fb] = sim.reach.final;
  bump(finalPairs, [fa.name, fb.name].sort().join(' v '));

  totals.groupGoals += sim.groupOutcomes.goals;
  totals.koGoals += sim.koStats.goals;
  totals.favWin += sim.groupOutcomes.favWin;
  totals.draw += sim.groupOutcomes.draw;
  totals.dogWin += sim.groupOutcomes.dogWin;
  totals.koUpsets += sim.koStats.upsets;
  totals.et += sim.koStats.et;
  totals.pens += sim.koStats.pens;

  // featured candidate tracking
  const champ = sim.champion.name;
  const bc = bestChalkByChamp.get(champ);
  if (!bc || sim.scores.chalk > bc.chalk) bestChalkByChamp.set(champ, { index: i, chalk: sim.scores.chalk });

  const cind = sim.scores.cinderella;
  if (cind) {
    simsWithCinderella++;
    bump(cinderellaTeam, cind.team.name);
    if (
      !bestCinderella ||
      cind.depth > bestCinderella.depth ||
      (cind.depth === bestCinderella.depth && cind.team.fieldRank > bestCinderella.fieldRank)
    ) {
      bestCinderella = { index: i, name: cind.team.name, fieldRank: cind.team.fieldRank, round: cind.round, depth: cind.depth };
    }
  }

  const fScore = fa.strength + fb.strength;
  if (!chalkFinal || fScore > chalkFinal.score) {
    chalkFinal = { index: i, score: fScore, champion: sim.champion.name };
  }
  if (!chaosRun || sim.scores.upsetMag > chaosRun.upsetMag) chaosRun = { index: i, upsetMag: sim.scores.upsetMag };

  // per-nation: deepest round, drama (Σ upset magnitude of own wins), headline victim (biggest single upset win)
  const depth = new Map();
  const drama = new Map();
  const headline = new Map(); // name -> { victim, up }
  for (const mm of bracket.matches) {
    const res = sim.results[mm.id];
    if (res.round === '3rd_place') continue;
    const rk = RRANK[res.round];
    if (!depth.has(res.home.name) || depth.get(res.home.name) < rk) depth.set(res.home.name, rk);
    if (!depth.has(res.away.name) || depth.get(res.away.name) < rk) depth.set(res.away.name, rk);
    const up = muUpset(res.winner, res.loser);
    drama.set(res.winner.name, (drama.get(res.winner.name) || 0) + up);
    if (up > 0) {
      const h = headline.get(res.winner.name);
      if (!h || up > h.up) headline.set(res.winner.name, { victim: res.loser.name, up });
    }
  }
  depth.set(sim.champion.name, 5); // champion ranks one above the runner-up ('final' = 4)
  for (const [name, rk] of depth) {
    const bucket = NATION_BUCKETS[rk];
    const dval = drama.get(name) || 0;
    const victim = headline.get(name)?.victim || '(none)'; // biggest giant toppled this run
    let rec = nationBest.get(name);
    if (!rec) nationBest.set(name, (rec = {}));
    const m = rec[bucket] || (rec[bucket] = new Map());
    const cur = m.get(victim);
    if (!cur || dval > cur.dramatic || (dval === cur.dramatic && i < cur.index)) m.set(victim, { index: i, dramatic: dval });
  }

  if ((i + 1) % Math.ceil(SIMS / 10) === 0) process.stdout.write(`  ...${i + 1}/${SIMS}\r`);
}
const elapsed = performance.now() - t0;

// ---- derive reportable stats ----
const N = SIMS - violations.matchingFail;
const pct = (n) => (100 * n) / N;
const groupMatches = 72 * N;
const koMatches = 32 * N;
const meanGoals = (totals.groupGoals + totals.koGoals) / (groupMatches + koMatches);
const codeOf = (name) => teamsByName.get(name)?.code || '';
const fieldOf = (name) => teamsByName.get(name)?.fieldRank;

const champions = [...championCount.entries()]
  .map(([name, count]) => ({ name, code: codeOf(name), fieldRank: fieldOf(name), count, pct: pct(count) }))
  .sort((a, b) => b.count - a.count);
const finalists = [...finalistCount.entries()]
  .map(([name, count]) => ({ name, code: codeOf(name), fieldRank: fieldOf(name), count, pct: pct(count) }))
  .sort((a, b) => b.count - a.count);
const reachTable = [...reach.entries()]
  .map(([name, r]) => ({ name, code: codeOf(name), fieldRank: fieldOf(name), ...r }))
  .sort((a, b) => b.title - a.title || b.final - a.final || b.sf - a.sf);
const finalsTop = [...finalPairs.entries()]
  .map(([pair, count]) => ({ pair, count, pct: pct(count) }))
  .sort((a, b) => b.count - a.count);
const cinderellas = [...cinderellaTeam.entries()]
  .map(([name, count]) => ({ name, code: codeOf(name), fieldRank: fieldOf(name), count, pct: pct(count) }))
  .sort((a, b) => b.count - a.count);

// ---- featured sims: replay + persist full bracket paths ----
const replaySerialize = (i) => serializeSim(runSim(i));

// drift guard: the locked Cinderella index must still be the chosen team's title
const cinSim = runSim(FEATURED_CINDERELLA.index);
if (cinSim.champion.name !== FEATURED_CINDERELLA.team) {
  console.error(
    `FEATURED CINDERELLA DRIFT: sim #${FEATURED_CINDERELLA.index} champion is ${cinSim.champion.name}, expected ${FEATURED_CINDERELLA.team}. Did the seed/model change?`,
  );
  process.exit(1);
}

const featured = {
  modalChampion: {
    angle: `The most likely winner (${champions[0].name}) on a clean, chalk run — what a "typical" 2026 looks like.`,
    storyTeam: champions[0].name,
    simIndex: bestChalkByChamp.get(champions[0].name).index,
    bracket: replaySerialize(bestChalkByChamp.get(champions[0].name).index),
  },
  cinderella: {
    angle:
      'Co-host Canada wins it all on pure FIFA rating — the model gives the hosts NO home-field bump, so even with zero home advantage baked in, the sim still found a universe where the hosts lift the trophy.',
    storyTeam: FEATURED_CINDERELLA.team,
    hostNeutralNote: true,
    simIndex: FEATURED_CINDERELLA.index,
    bracket: serializeSim(cinSim),
  },
  chalkFinal: {
    angle: `A top-heavy "chalk" final between the tournament's strongest sides, won by ${chalkFinal.champion}.`,
    storyTeam: chalkFinal.champion,
    simIndex: chalkFinal.index,
    bracket: replaySerialize(chalkFinal.index),
  },
  chaos: {
    angle:
      'Maximum chaos — the single bracket with the highest aggregate upset magnitude across all 104 matches. The field detonates (even the #1 side falls early), yet a top side survives the carnage to lift the trophy.',
    simIndex: chaosRun.index,
    bracket: replaySerialize(chaosRun.index),
  },
};
featured.chaos.storyTeam = featured.chaos.bracket.champion.name;

// ---- Pick-Your-Nation: resolve each team's ceiling + its most-dramatic sim, persist the path ----
const NATION_LABEL = { r32: 'Round of 32', r16: 'Round of 16', qf: 'Quarter-final', sf: 'Semi-final', final: 'Final', title: 'Champion' };
const NATION_DEPTH = { r32: 1, r16: 2, qf: 3, sf: 4, final: 5, title: 5 };
const NATION_TH = 0.01 * N; // "recurring" = reached in >=1% of completed sims
const reachByName = new Map(reachTable.map((r) => [r.name, r]));
// France (modal) and Canada (Cinderella) are pinned to their featured title sims so the
// dropdown entry matches the surfaced tab exactly. They are deliberate featured picks,
// labelled with their honest (often rare) title frequency — exempt from the >=1% auto-rule.
const pinnedOf = { [champions[0].name]: 'modalChampion', [FEATURED_CINDERELLA.team]: 'cinderella' };
const pinIndex = { modalChampion: featured.modalChampion.simIndex, cinderella: featured.cinderella.simIndex };
const serCache = new Map();
const serOf = (i) => { if (!serCache.has(i)) serCache.set(i, replaySerialize(i)); return serCache.get(i); };

// pass 1 — each team's ceiling = deepest round it reaches in >=1% of sims
const nMeta = {};
for (const t of teamsDoc.teams) {
  const r = reachByName.get(t.name);
  let ceil = 'r32';
  for (const b of NATION_BUCKETS) if ((r[b] || 0) >= NATION_TH) ceil = b;
  const pin = pinnedOf[t.name] || null;
  const ceilingKey = pin ? 'title' : ceil; // both pinned featured runs are titles
  nMeta[t.name] = { ceilingKey, champion: ceilingKey === 'title', reachCount: r[ceilingKey], pin };
}

// pass 2 — diversify the SHALLOW runs only. A deep/champion run beats several teams, so its
// "biggest giant toppled" is one beat among many and repetition is invisible — those keep their
// single most-dramatic sim. A shallow run (R16/QF) IS just "the giant they beat", so if three
// minnows all topple #1 it reads as a template. For those, spread headline victims to distinct
// giants (biggest underdog picks first), falling back to most-dramatic if none are free.
const NATION_CAP = 1;        // among shallow runs, a giant may headline at most this many
const SHALLOW_MAX = 3;       // depth <= 3 == R16 / QF (the single-storyline runs)
const headlineUsed = new Map();
const useHeadline = (v) => { if (v && v !== '(none)') headlineUsed.set(v, (headlineUsed.get(v) || 0) + 1); };
const sortedEntries = (team, bucket) =>
  [...nationBest.get(team)[bucket].entries()].sort((a, b) => b[1].dramatic - a[1].dramatic || a[1].index - b[1].index);
const chosenIndex = {};
for (const t of teamsDoc.teams) if (nMeta[t.name].pin) chosenIndex[t.name] = pinIndex[nMeta[t.name].pin];

// shallow runs: pick the most-dramatic giant not already claimed (biggest underdog picks first)
let diversified = 0, repeated = 0;
const shallow = teamsDoc.teams
  .filter((t) => !nMeta[t.name].pin && NATION_DEPTH[nMeta[t.name].ceilingKey] <= SHALLOW_MAX)
  .sort((a, b) => NATION_DEPTH[nMeta[a.name].ceilingKey] - NATION_DEPTH[nMeta[b.name].ceilingKey] || b.fieldRank - a.fieldRank);
for (const t of shallow) {
  const entries = sortedEntries(t.name, nMeta[t.name].ceilingKey); // [victim, {index,dramatic}] by drama desc
  const free = entries.find(([v]) => v !== '(none)' && (headlineUsed.get(v) || 0) < NATION_CAP);
  const pick = free || entries[0];
  if (free) diversified++; else repeated++;
  chosenIndex[t.name] = pick[1].index;
  useHeadline(pick[0]);
}
// deep runs (SF / Final / Champion): keep the single most-dramatic sim (multi-win paths vary already)
for (const t of teamsDoc.teams) {
  if (nMeta[t.name].pin || NATION_DEPTH[nMeta[t.name].ceilingKey] <= SHALLOW_MAX) continue;
  chosenIndex[t.name] = sortedEntries(t.name, nMeta[t.name].ceilingKey)[0][1].index;
}

// pass 3 — build each nation record from its chosen sim
const nations = {};
const nationDist = {};
for (const t of teamsDoc.teams) {
  const r = reachByName.get(t.name);
  const mt = nMeta[t.name];
  const simIndex = chosenIndex[t.name];
  const path = serOf(simIndex).knockout.filter((mm) => (mm.home.name === t.name || mm.away.name === t.name) && mm.round !== '3rd_place');
  nations[t.name] = {
    name: t.name, code: t.code, fieldRank: t.fieldRank, worldRank: t.worldRank, points: t.fifaPoints,
    ceiling: mt.ceilingKey, ceilingRound: NATION_LABEL[mt.ceilingKey], depth: NATION_DEPTH[mt.ceilingKey],
    champion: mt.champion, reachCount: mt.reachCount, reachPct: pct(mt.reachCount), titleCount: r.title, titlePct: pct(r.title),
    simIndex, pinned: mt.pin, path,
  };
  nationDist[mt.ceilingKey] = (nationDist[mt.ceilingKey] || 0) + 1;
}

const out = {
  config: { sims: SIMS, completed: N, masterSeed: MASTER_SEED, model: MODEL, elapsedMs: Math.round(elapsed) },
  ratingSource: teamsDoc.ratingSource,
  ratingSnapshot: teamsDoc.ratingSnapshot,
  rankBasis: 'fieldRank (1-48) primary; worldRank is global FIFA rank, flavor only ("world #N").',
  meanGoalsPerGame: meanGoals,
  groupStage: {
    favWinPct: (100 * totals.favWin) / groupMatches,
    drawPct: (100 * totals.draw) / groupMatches,
    dogWinPct: (100 * totals.dogWin) / groupMatches,
  },
  knockout: {
    upsetPct: (100 * totals.koUpsets) / koMatches,
    etPct: (100 * totals.et) / koMatches,
    pensPct: (100 * totals.pens) / koMatches,
  },
  champions,
  finalists,
  reach: reachTable,
  finals: finalsTop.slice(0, 12),
  cinderella: { fieldRankThreshold: MODEL.CINDERELLA_RANK, simsWithCinderellaPct: pct(simsWithCinderella), mostExtreme: bestCinderella, teams: cinderellas },
  validation: violations,
  featured,
  nations,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'sim-results.json'), JSON.stringify(out, null, 2) + '\n');

// ---- console report ----
const f1 = (x) => x.toFixed(1);
const bar = (p, max) => '█'.repeat(Math.round((p / max) * 28));
console.log(`\n\n${'='.repeat(64)}`);
console.log(`MONTE CARLO — ${N.toLocaleString()} simulations in ${(elapsed / 1000).toFixed(2)}s  (seed ${MASTER_SEED})`);
console.log(`Match model: Poisson-from-Elo, divisor ${MODEL.ELO_DIVISOR}, total≈${MODEL.TOTAL_GOALS}, supremacyMax ${MODEL.SUPREMACY_MAX}`);
console.log('='.repeat(64));

console.log(`\nSANITY`);
console.log(`  mean goals/game        ${meanGoals.toFixed(2)}   (target 2.5-2.8)`);
console.log(`  group: favorite ${f1(out.groupStage.favWinPct)}% / draw ${f1(out.groupStage.drawPct)}% / upset ${f1(out.groupStage.dogWinPct)}%`);
console.log(`  knockout upsets        ${f1(out.knockout.upsetPct)}%   (lower-rated team wins)`);
console.log(`  went to ET ${f1(out.knockout.etPct)}% / penalties ${f1(out.knockout.pensPct)}% of KO games`);

console.log(`\nVALIDATION (across all sims; all should be 0)`);
console.log(`  bad round sizes ${violations.roundSize} | self-matchups ${violations.selfMatch} | ineligible thirds ${violations.ineligibleThird} | matching failures ${violations.matchingFail}`);

console.log(`\nCHAMPION ODDS (top 16; field rank in brackets)`);
const maxChamp = champions[0].pct;
for (const c of champions.slice(0, 16)) {
  console.log(`  ${`${c.name} [#${c.fieldRank}]`.padEnd(22)} ${f1(c.pct).padStart(5)}%  ${bar(c.pct, maxChamp)}`);
}

console.log(`\nDEEP RUNS — P(reach round), top 14 by title odds`);
console.log(`  Team              R16    QF    SF   Final  Title`);
for (const r of reachTable.slice(0, 14)) {
  const p = (n) => f1(pct(n)).padStart(5);
  console.log(`  ${r.name.padEnd(16)}${p(r.r16)} ${p(r.qf)} ${p(r.sf)} ${p(r.final)} ${p(r.title)}`);
}

console.log(`\nMOST COMMON FINALS (top 8)`);
for (const fp of finalsTop.slice(0, 8)) console.log(`  ${f1(fp.pct).padStart(5)}%  ${fp.pair}`);

console.log(`\nCINDERELLA (field rank > ${MODEL.CINDERELLA_RANK} reaching SF+)  —  ${f1(out.cinderella.simsWithCinderellaPct)}% of sims have one`);
for (const c of cinderellas.slice(0, 8)) {
  console.log(`  ${`${c.name} [#${c.fieldRank}]`.padEnd(22)} ${f1(c.pct).padStart(5)}% reach SF+`);
}

console.log(`\nFEATURED SIMS (full paths persisted)`);
console.log(`  modal champion  : ${featured.modalChampion.storyTeam} (sim #${featured.modalChampion.simIndex})`);
console.log(`  Cinderella      : ${featured.cinderella.storyTeam} [LOCKED, co-host] (sim #${featured.cinderella.simIndex})`);
console.log(`  chalk final     : ${featured.chalkFinal.storyTeam} (sim #${featured.chalkFinal.simIndex})`);
console.log(`  chaos bracket   : ${featured.chaos.storyTeam} #${featured.chaos.bracket.champion.fieldRank} (sim #${featured.chaos.simIndex}, Σupset ${chaosRun.upsetMag.toFixed(2)}) [max aggregate upset / 104 matches]`);
console.log(`\nPICK-YOUR-NATION (Option B: deepest round reached in >=1% of sims; 48 paths persisted)`);
console.log(`  ${NATION_BUCKETS.slice().reverse().map((b) => `${NATION_LABEL[b]} ${nationDist[b] || 0}`).join(' · ')}`);
console.log(`  shallow runs (R16/QF) toppling a distinct giant: ${diversified} diversified, ${repeated} unavoidable repeats`);
console.log(`\nWrote pipeline/out/sim-results.json\n`);
