// Build the self-contained LIVE data for app/live.html.
// Reads pipeline/out/sim-live.json (conditional Monte Carlo + analytic match odds)
// and bakes app/live-data.js (window.WC_LIVE) + app/live-data.json. Like build.js,
// the shipped file contains NO key and makes NO live calls — the "live" numbers are
// re-baked by re-running the pipeline (fetch → simulateLive → buildLive) per matchday.
//
//   npm run build:live

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TEAM_NAMES_ES } from './lib/teamNamesEs.js';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'app');
const OUT = join(import.meta.dirname, 'out');

const sim = JSON.parse(readFileSync(join(OUT, 'sim-live.json'), 'utf8'));

const data = {
  meta: {
    title: 'AI World Cup 2026 — Live Re-Forecast',
    built: new Date().toISOString().slice(0, 10),
    asOfDate: sim.asOfDate,
    fetchedAt: sim.generatedFrom.fetchedAt,
    source: sim.generatedFrom.source,
    sourceUrl: sim.generatedFrom.sourceUrl,
    ratingSource: sim.ratingSource,
    ratingSnapshot: sim.ratingSnapshot,
    eloRule: sim.eloRule,
    sims: sim.config.sims,
    masterSeed: sim.config.masterSeed,
    model: sim.config.model,
    baselineRef: sim.baselineRef,
    playedCount: sim.playedCount,
    groupPlayedCount: sim.groupPlayedCount,
    groupTotal: sim.groupTotal,
    teamNamesEs: TEAM_NAMES_ES,
    method:
      'A re-run of the same honest, seeded Monte Carlo — now CONDITIONAL on real results. Every finished match is clamped to its real scoreline (the sim reproduces it and re-simulates only the unknown remainder), and team ratings are updated on the pitch by FIFA\'s own SUM formula (divisor 600). At zero games played this reproduces the frozen pre-tournament forecast exactly. Per-match odds are closed-form from the same Poisson model — no separate model, no hand-tuning. Neutral venue (no host advantage). Field rank is 1–48 within this field.',
  },
  validation: sim.validation,
  champions: sim.champions,
  reach: sim.reach,
  standings: sim.standings,
  nextDate: sim.nextDate,
  projections: sim.projections,
  projectedBracket: sim.projectedBracket,
  championPath: sim.championPath,
  bracketFeed: sim.bracketFeed,
  movers: sim.movers,
  results: sim.results,
};

mkdirSync(APP, { recursive: true });
writeFileSync(join(APP, 'live-data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(APP, 'live-data.js'), `window.WC_LIVE = ${JSON.stringify(data)};\n`);

console.log('build:live — wrote app/live-data.js + app/live-data.json');
console.log(`  as of ${data.meta.asOfDate} · ${data.meta.groupPlayedCount}/${data.meta.groupTotal} group games · ${data.champions.length} teams · ${data.projections.length} upcoming fixtures`);
