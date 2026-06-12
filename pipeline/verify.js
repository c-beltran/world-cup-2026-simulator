// QA — independently verify narration faithfulness (the project's core honesty claim).
// Re-derives each featured sim from its master seed (the source of truth), then
// confirms every baked take's score + winner match it and that none were flagged.
// This trusts nothing the narration step reported about itself.
//
//   npm run verify        (exit 0 = all faithful, 1 = a mismatch)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, simSeed } from './lib/rng.js';
import { prepareBracket, simulateTournament } from './lib/tournament.js';
import { MODEL } from './lib/model.js';
import { rankViolation, titleClaim, reputationClaim } from './lib/rankguard.js';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(import.meta.dirname, 'out');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const d = (p) => read(join(ROOT, 'data', p));

const teams = d('teams.json');
const tb = new Map(teams.teams.map((t) => [t.name, t]));
const bracket = prepareBracket(d('bracket.json'));
const groups = d('groups.json');
const sim = read(join(OUT, 'sim-results.json'));
const nar = read(join(OUT, 'narration.json'));

let checked = 0;
let mism = 0;
let missing = 0;
let rankBad = 0;
let esRank = 0, esRep = 0, esTitle = 0, esUnver = 0; // Spanish parity scan

for (const [key, f] of Object.entries(sim.featured)) {
  if (!nar.sims?.[key]) {
    console.log(`- ${key}: not narrated yet`);
    continue;
  }
  const r = simulateTournament(tb, groups, bracket, mulberry32(simSeed(sim.config.masterSeed, f.simIndex)), MODEL);
  const story = f.storyTeam;
  const takes = nar.sims[key].matches || {};

  // Field ranks the storyline was allowed to cite: the story team + every opponent
  // it actually faced (incl. any 3rd-place game), re-derived from the seed.
  const storyAllowed = new Set();
  for (const m of bracket.matches) {
    const res = r.results[m.id];
    if (res.home.name === story || res.away.name === story) {
      storyAllowed.add(res.home.fieldRank);
      storyAllowed.add(res.away.fieldRank);
    }
  }

  let ok = 0;
  for (const m of bracket.matches) {
    const res = r.results[m.id];
    if ((res.home.name !== story && res.away.name !== story) || m.round === '3rd_place') continue;
    const truth = `${res.gh}-${res.ga}`;
    const t = takes[m.id];
    if (!t) {
      console.log(`  MISSING ${key} ${m.id}`);
      missing++;
      continue;
    }
    checked++;
    if (t.score !== truth || t.winner !== res.winner.name || t.verified !== true || !t.take) {
      console.log(`  MISMATCH ${key} ${m.id}: take[${t.score} ${t.winner} verified=${t.verified}] vs seed-truth[${truth} ${res.winner.name}]`);
      mism++;
      continue;
    }
    const rv = rankViolation(t.take, new Set([res.home.fieldRank, res.away.fieldRank]));
    if (rv) {
      console.log(`  RANK ${key} ${m.id}: ${rv} — "${t.take.slice(0, 80)}..."`);
      rankBad++;
    } else ok++;
    if (t.takeEs) { // Spanish parity (featured takes: rank only, like EN)
      if (t.verifiedEs !== true) { console.log(`  ES-UNVERIFIED ${key} ${m.id}`); esUnver++; }
      const erv = rankViolation(t.takeEs, new Set([res.home.fieldRank, res.away.fieldRank]), 'es');
      if (erv) { console.log(`  ES-RANK ${key} ${m.id}: ${erv}`); esRank++; }
    }
  }

  const sl = nar.sims[key].storyline;
  if (sl) {
    const rv = rankViolation(sl, storyAllowed);
    if (rv) {
      console.log(`  RANK ${key} storyline: ${rv}`);
      rankBad++;
    }
  }
  const slEs = nar.sims[key].storylineEs;
  if (slEs) {
    const rv = rankViolation(slEs, storyAllowed, 'es');
    if (rv) { console.log(`  ES-RANK ${key} storyline: ${rv}`); esRank++; }
  }
  console.log(`- ${key.padEnd(14)} ${story.padEnd(14)} sim #${String(f.simIndex).padStart(5)}: ${ok} path takes faithful${sl ? ' + storyline' : ''}`);
}

// ---- Pick-Your-Nation runs (Part B): re-derive each narrated nation from its seed ----
let nChecked = 0, nMism = 0, nRank = 0, nTitle = 0, nRep = 0, nMissing = 0, nSeen = 0;
for (const [name, nat] of Object.entries(sim.nations || {})) {
  const narN = nar.nations?.[name];
  if (!narN) continue; // not narrated yet (expected during the sample stage)
  nSeen++;
  const r = simulateTournament(tb, groups, bracket, mulberry32(simSeed(sim.config.masterSeed, nat.simIndex)), MODEL);

  // field ranks the storyline may cite = every opponent on this team's re-derived path
  const allowed = new Set();
  for (const m of nat.path) { const res = r.results[m.id]; allowed.add(res.home.fieldRank); allowed.add(res.away.fieldRank); }

  let ok = 0;
  for (const m of nat.path) {
    const res = r.results[m.id];
    const truth = `${res.gh}-${res.ga}`;
    const t = narN.matches?.[m.id];
    if (!t) { console.log(`  MISSING nation ${name} ${m.id}`); nMissing++; continue; }
    nChecked++;
    if (t.score !== truth || t.winner !== res.winner.name || t.verified !== true || !t.take) {
      console.log(`  MISMATCH nation ${name} ${m.id}: take[${t.score} ${t.winner} v=${t.verified}] vs seed[${truth} ${res.winner.name}]`);
      nMism++; continue;
    }
    const rv = rankViolation(t.take, new Set([res.home.fieldRank, res.away.fieldRank]));
    if (rv) { console.log(`  RANK nation ${name} ${m.id}: ${rv}`); nRank++; continue; }
    const rep = reputationClaim(t.take);
    if (rep) { console.log(`  REPUTATION nation ${name} ${m.id}: "${rep}"`); nRep++; continue; }
    if (t.takeEs) { // Spanish parity (nation takes: rank + reputation, like EN strict)
      if (t.verifiedEs !== true) { console.log(`  ES-UNVERIFIED nation ${name} ${m.id}`); esUnver++; }
      const erv = rankViolation(t.takeEs, new Set([res.home.fieldRank, res.away.fieldRank]), 'es');
      if (erv) { console.log(`  ES-RANK nation ${name} ${m.id}: ${erv}`); esRank++; }
      const erep = reputationClaim(t.takeEs, 'es');
      if (erep) { console.log(`  ES-REP nation ${name} ${m.id}: "${erep}"`); esRep++; }
    }
    ok++;
  }
  const sl = narN.storyline;
  if (sl) {
    const rv = rankViolation(sl, allowed);
    if (rv) { console.log(`  RANK nation ${name} storyline: ${rv}`); nRank++; }
    const rep = reputationClaim(sl);
    if (rep) { console.log(`  REPUTATION nation ${name} storyline: "${rep}"`); nRep++; }
    if (!nat.champion) {
      const tc = titleClaim(sl);
      if (tc) { console.log(`  TITLE-CLAIM nation ${name} storyline: "${tc}" — run ended in the ${nat.ceilingRound}`); nTitle++; }
    }
  }
  const slEs = narN.storylineEs;
  if (slEs) {
    if (rankViolation(slEs, allowed, 'es')) { console.log(`  ES-RANK nation ${name} storyline`); esRank++; }
    const erep = reputationClaim(slEs, 'es');
    if (erep) { console.log(`  ES-REP nation ${name} storyline: "${erep}"`); esRep++; }
    if (!nat.champion) { const tc = titleClaim(slEs, 'es'); if (tc) { console.log(`  ES-TITLE nation ${name} storyline: "${tc}"`); esTitle++; } }
  }
  console.log(`- nation ${name.padEnd(16)} ${nat.ceilingRound.padEnd(13)} sim #${String(nat.simIndex).padStart(5)}: ${ok}/${nat.path.length} takes faithful${sl ? ' + storyline' : ''}`);
}

const pass = mism === 0 && missing === 0 && rankBad === 0 && nMism === 0 && nMissing === 0 && nRank === 0 && nTitle === 0 && nRep === 0 && esRank === 0 && esRep === 0 && esTitle === 0 && esUnver === 0;
console.log(`\nFEATURED · ${checked} takes re-derived: ${mism} score/winner mismatches, ${rankBad} rank/seed violations, ${missing} missing.`);
console.log(`NATIONS  · ${nSeen} narrated, ${nChecked} takes re-derived: ${nMism} mismatches, ${nRank} rank/seed violations, ${nTitle} false title claims, ${nRep} reputation claims, ${nMissing} missing.`);
console.log(`SPANISH  · ${esUnver} unverified, ${esRank} rank/seed violations, ${esRep} reputation claims, ${esTitle} false title claims.`);
console.log(`\n${pass ? 'PASS' : 'FAIL'} — every baked take re-derived from the seed-true simulation.`);
process.exit(pass ? 0 : 1);
