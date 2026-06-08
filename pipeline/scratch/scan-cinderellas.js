// READ-ONLY analysis (not part of the pipeline): surface Cinderella candidates
// under the new rule — lowest-rated (FIELD rank > 16) team reaching at least the
// final. Uses the same seed+engine as the planned final run, so any sim index
// printed here replays identically in Stage 3.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, simSeed } from '../lib/rng.js';
import { prepareBracket, simulateTournament } from '../lib/tournament.js';
import { MODEL } from '../lib/model.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));
const teamsDoc = read('teams.json');
const groupsDoc = read('groups.json');
const bracketDoc = read('bracket.json');

// FIELD rank (1..48) by points — the new primary basis.
const byPoints = [...teamsDoc.teams].sort((a, b) => b.fifaPoints - a.fifaPoints);
const fieldRank = new Map(byPoints.map((t, i) => [t.name, i + 1]));
const teamsByName = new Map(
  teamsDoc.teams.map((t) => [t.name, { ...t, fieldRank: fieldRank.get(t.name), worldRank: t.fifaRank }]),
);
const bracket = prepareBracket(bracketDoc);

const SIMS = 50000;
const SEED = 20260611;
const THRESH = 16;
const fr = (name) => teamsByName.get(name).fieldRank;
const wr = (name) => teamsByName.get(name).worldRank;

const stat = new Map(); // name -> {fieldRank, finals, titles, firstFinalSim, firstTitleSim, firstRunnerUpSim}
for (let i = 0; i < SIMS; i++) {
  const sim = simulateTournament(teamsByName, groupsDoc, bracket, mulberry32(simSeed(SEED, i)), MODEL);
  for (const t of sim.reach.final) {
    if (fr(t.name) <= THRESH) continue;
    let s = stat.get(t.name);
    if (!s) {
      s = { name: t.name, fieldRank: fr(t.name), finals: 0, titles: 0, firstFinalSim: i, firstTitleSim: null, firstRunnerUpSim: null };
      stat.set(t.name, s);
    }
    s.finals++;
    if (t === sim.champion) {
      s.titles++;
      if (s.firstTitleSim === null) s.firstTitleSim = i;
    } else if (s.firstRunnerUpSim === null) {
      s.firstRunnerUpSim = i;
    }
  }
}

// Replay a sim and describe a team's knockout path + the final.
function describe(index, teamName) {
  const sim = simulateTournament(teamsByName, groupsDoc, bracket, mulberry32(simSeed(SEED, index)), MODEL);
  const f = sim.results.M104;
  const path = [];
  for (const mm of bracket.matches) {
    const r = sim.results[mm.id];
    if (r.home.name !== teamName && r.away.name !== teamName) continue;
    if (mm.round === '3rd_place') continue;
    const isHome = r.home.name === teamName;
    const opp = isHome ? r.away : r.home;
    const gf = isHome ? r.gh : r.ga;
    const ga = isHome ? r.ga : r.gh;
    const won = r.winner.name === teamName;
    const suffix = r.decidedBy === 'PENS' ? ' (pens)' : r.decidedBy === 'ET' ? ' (a.e.t.)' : '';
    path.push(`${mm.round}: ${won ? 'beat' : 'lost to'} ${opp.name} (#${fr(opp.name)}) ${gf}-${ga}${suffix}`);
  }
  return {
    finalLine: `${f.home.name} (#${fr(f.home.name)}) ${f.gh}-${f.ga} ${f.away.name} (#${fr(f.away.name)})${f.decidedBy === 'PENS' ? ' (pens)' : f.decidedBy === 'ET' ? ' (a.e.t.)' : ''} -> champion ${f.winner.name}`,
    path,
  };
}

const finalists = [...stat.values()].sort((a, b) => b.fieldRank - a.fieldRank);

console.log(`\nCinderella finalists (FIELD rank > ${THRESH}) across ${SIMS.toLocaleString()} sims, seed ${SEED}`);
console.log(`Lowest-rated first. "reached final" counts both finalists; "won" = lifted the trophy.\n`);
console.log(`  field  world  team                 reached-final   won-it`);
for (const s of finalists) {
  console.log(
    `   #${String(s.fieldRank).padStart(2)}   #${String(wr(s.name)).padStart(3)}   ${s.name.padEnd(20)} ${String(s.finals).padStart(5)} (${((100 * s.finals) / SIMS).toFixed(2)}%)   ${s.titles}`,
  );
}

// Curated menu spanning the believability range. prefer 'runnerup' shows a
// reached-the-final-and-lost story (the purest Cinderella archetype).
const repSim = (name, prefer) => {
  const s = stat.get(name);
  if (!s) return null;
  if (prefer === 'runnerup' && s.firstRunnerUpSim !== null) return { index: s.firstRunnerUpSim, won: false };
  if (s.firstTitleSim !== null) return { index: s.firstTitleSim, won: true };
  if (s.firstRunnerUpSim !== null) return { index: s.firstRunnerUpSim, won: false };
  return { index: s.firstFinalSim, won: null };
};

const menu = [
  ['Australia', 'title', 'genuine underdog that WON it (field #24) — dramatic but believable'],
  ['Canada', 'title', 'co-HOST Cinderella — perfect for the 2026-in-North-America angle'],
  ["Côte d'Ivoire", 'title', 'deeper underdog (field #30), recognizable, frequent enough to be believable'],
  ['South Africa', 'runnerup', 'reached the FINAL and lost to a giant (field #40) — purest Cinderella'],
  ['New Zealand', 'title', 'field #48 winning it — shown only as the TAIL EVENT to AVOID'],
];

console.log(`\n${'='.repeat(64)}\nCANDIDATE DETAIL (curated menu)\n${'='.repeat(64)}`);
for (const [name, prefer, why] of menu) {
  const s = stat.get(name);
  const rep = repSim(name, prefer);
  if (!s || !rep) {
    console.log(`\n* ${name}: no qualifying final found.`);
    continue;
  }
  const d = describe(rep.index, name);
  const outcome = rep.won === true ? 'WON the final' : rep.won === false ? 'reached the final (lost)' : 'reached the final';
  console.log(`\n* ${name}  (field #${s.fieldRank}, world #${wr(name)})  — ${why}`);
  console.log(`  reached final ${s.finals}/${SIMS} (${((100 * s.finals) / SIMS).toFixed(2)}%), won ${s.titles}`);
  console.log(`  representative sim #${rep.index}  [${outcome}]`);
  console.log(`  final: ${d.finalLine}`);
  console.log(`  ${name}'s run:`);
  for (const line of d.path) console.log(`    ${line}`);
}
console.log('');
