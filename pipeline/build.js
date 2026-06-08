// Stage 5 — Build the self-contained app data.
// Merges teams.json + sim-results.json + narration.json into app/data.js and
// app/data.json. data.js assigns window.WC_DATA so the app opens straight off the
// filesystem (file://) with no server, no fetch, no API key, no live calls.
//
//   npm run build
//
// Safe to run before narration exists — takes simply come through as null.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'app');
const OUT = join(import.meta.dirname, 'out');

const teams = JSON.parse(readFileSync(join(ROOT, 'data', 'teams.json'), 'utf8'));
const sim = JSON.parse(readFileSync(join(OUT, 'sim-results.json'), 'utf8'));
const narration = existsSync(join(OUT, 'narration.json'))
  ? JSON.parse(readFileSync(join(OUT, 'narration.json'), 'utf8'))
  : { sims: {} };

// Merge AI takes into each featured sim's knockout matches (keyed by match id).
let takeCount = 0;
const featured = {};
for (const [key, f] of Object.entries(sim.featured)) {
  const nar = narration.sims?.[key];
  const knockout = f.bracket.knockout.map((m) => {
    const take = nar?.matches?.[m.id]?.take || null;
    if (take) takeCount++;
    return { ...m, take };
  });
  featured[key] = {
    angle: f.angle,
    storyTeam: f.storyTeam,
    simIndex: f.simIndex,
    storyline: nar?.storyline || null,
    champion: f.bracket.champion,
    runnerUp: f.bracket.runnerUp,
    thirdPlace: f.bracket.thirdPlace,
    fourthPlace: f.bracket.fourthPlace,
    groups: f.bracket.groups,
    knockout,
  };
}

// Pick-Your-Nation (Part B): one compact record per team — its selected run path with
// AI takes merged in. Paths are baked for all 48 so the dropdown is complete; takes /
// storyline are present only for teams that have been narrated (null otherwise).
let nationTakeCount = 0;
let nationsNarrated = 0;
const nations = {};
for (const [name, nat] of Object.entries(sim.nations || {})) {
  const nar = narration.nations?.[name];
  if (nar?.storyline) nationsNarrated++;
  const path = nat.path.map((mm) => {
    const take = nar?.matches?.[mm.id]?.take || null;
    if (take) nationTakeCount++;
    return { ...mm, take };
  });
  nations[name] = {
    name: nat.name, code: nat.code, fieldRank: nat.fieldRank, worldRank: nat.worldRank,
    ceiling: nat.ceiling, ceilingRound: nat.ceilingRound, depth: nat.depth, champion: nat.champion,
    reachCount: nat.reachCount, reachPct: nat.reachPct, titleCount: nat.titleCount, titlePct: nat.titlePct,
    simIndex: nat.simIndex, pinned: nat.pinned,
    storyline: nar?.storyline || null,
    path,
  };
}

const data = {
  meta: {
    title: 'AI World Cup 2026 Simulator & Journey Tree',
    built: new Date().toISOString().slice(0, 10),
    ratingSource: sim.ratingSource,
    ratingSnapshot: sim.ratingSnapshot,
    sims: sim.config.sims,
    masterSeed: sim.config.masterSeed,
    model: sim.config.model,
    rankBasis: sim.rankBasis,
    method:
      "An honest, seeded Monte Carlo of the real 2026 World Cup. Match scorelines come from a Poisson model parameterized by the FIFA/Elo rating gap (FIFA's own divisor, 600). Team strength = the official FIFA/Coca-Cola ranking points (1 April 2026), used directly. Storylines are real LLM output, generated offline and each constrained to narrate the simulation's actual result — never to change it. Neutral venue (no host advantage). All ranks are field rank (1-48 within this field); world rank is shown only as flavor.",
    narration: narration.generatedWith || null,
  },
  teams: [...teams.teams].sort((a, b) => a.fieldRank - b.fieldRank),
  stats: {
    meanGoalsPerGame: sim.meanGoalsPerGame,
    groupStage: sim.groupStage,
    knockout: sim.knockout,
    champions: sim.champions,
    finalists: sim.finalists,
    reach: sim.reach,
    finals: sim.finals,
    cinderella: sim.cinderella,
    validation: sim.validation,
  },
  featured,
  nations,
};

mkdirSync(APP, { recursive: true });
writeFileSync(join(APP, 'data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(APP, 'data.js'), `window.WC_DATA = ${JSON.stringify(data)};\n`);

const need = Object.values(featured).reduce(
  (n, f) => n + f.knockout.filter((m) => (m.home.name === f.storyTeam || m.away.name === f.storyTeam) && m.round !== '3rd_place').length,
  0,
);
console.log('build: wrote app/data.json + app/data.js');
console.log(`  teams ${data.teams.length} · featured sims ${Object.keys(featured).length} · baked takes ${takeCount}/${need} path matches`);
console.log(`  nations ${Object.keys(nations).length} (paths) · narrated ${nationsNarrated}/${Object.keys(nations).length} · nation takes ${nationTakeCount}`);
if (takeCount === 0) console.log('  NOTE: no AI takes baked yet — run `npm run narrate -- all` (needs ANTHROPIC_API_KEY), then rebuild.');
else if (takeCount < need) console.log('  NOTE: some featured sims not yet narrated — run `npm run narrate -- all`, then rebuild.');
