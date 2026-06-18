// Bake the 2022 backtest into app/accuracy-data.js (window.WC_ACCURACY) + .json.
// Adds the OUTRIGHT bookmaker comparison (de-vigged from a single dated source) and a
// few concrete "receipts". Per-match market odds are intentionally omitted (no clean,
// honestly-sourceable dataset) — the page states this limitation.
//
//   node buildBacktest.js     (run after backtest2022.js)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'app');
const OUT = join(import.meta.dirname, 'out');
const bt = JSON.parse(readFileSync(join(OUT, 'backtest-2022.json'), 'utf8'));

// Pre-tournament "to win" odds — SI Sportsbook, published 16 Nov 2022 (single source, one
// date, the whole field), so the de-vig is internally consistent. American odds.
const ODDS_SOURCE = { book: 'SI Sportsbook', date: '2022-11-16', url: 'https://www.si.com/betting/2022/11/16/odds-groups-2022-world-cup' };
const AMERICAN = {
  Brazil: 350, Argentina: 500, England: 700, France: 700, Spain: 800, Germany: 1000,
  Netherlands: 1400, Portugal: 1400, Belgium: 1600, Denmark: 2800, Croatia: 5000, Uruguay: 5000,
  Serbia: 6600, Senegal: 8000, Switzerland: 8000, Mexico: 10000, USA: 10000, Poland: 10000, Wales: 10000,
  Canada: 15000, Ecuador: 15000, Ghana: 15000, Morocco: 20000, Qatar: 25000, Cameroon: 25000, Japan: 25000,
  'South Korea': 30000, Tunisia: 30000, Australia: 40000, 'Costa Rica': 50000, 'Saudi Arabia': 50000, Iran: 500000,
};
const impliedOf = (a) => 100 / (a + 100); // American → implied prob (with vig)
const overround = Object.values(AMERICAN).reduce((s, a) => s + impliedOf(a), 0);
const marketProb = (name) => (AMERICAN[name] != null ? impliedOf(AMERICAN[name]) / overround : null); // de-vigged

// Spanish names for the 2022 field (self-contained; openfootball spellings as keys).
const TEAM_ES_2022 = {
  Qatar: 'Catar', Ecuador: 'Ecuador', Senegal: 'Senegal', Netherlands: 'Países Bajos', England: 'Inglaterra',
  Iran: 'Irán', USA: 'Estados Unidos', Wales: 'Gales', Argentina: 'Argentina', 'Saudi Arabia': 'Arabia Saudita',
  Mexico: 'México', Poland: 'Polonia', Denmark: 'Dinamarca', Tunisia: 'Túnez', France: 'Francia', Australia: 'Australia',
  Germany: 'Alemania', Japan: 'Japón', Spain: 'España', 'Costa Rica': 'Costa Rica', Morocco: 'Marruecos', Croatia: 'Croacia',
  Belgium: 'Bélgica', Canada: 'Canadá', Switzerland: 'Suiza', Cameroon: 'Camerún', Brazil: 'Brasil', Serbia: 'Serbia',
  Uruguay: 'Uruguay', 'South Korea': 'Corea del Sur', Portugal: 'Portugal', Ghana: 'Ghana',
};

const DEEPEST = ['title', 'final', 'sf', 'qf', 'r16'];
const deepestRound = (hit) => DEEPEST.find((r) => hit[r]) || 'group';
const DEPTH = { group: 0, r16: 1, qf: 2, sf: 3, final: 4, title: 5 }; // higher = deeper run
const depthOf = (hit) => DEPTH[deepestRound(hit)];

// model title prob vs de-vigged market, for the contenders (top by either measure)
const market = bt.outright
  .map((o) => ({ name: o.name, code: o.code, model: o.prob.title, market: marketProb(o.name), reached: deepestRound(o.hit) }))
  .filter((x) => x.market != null)
  .sort((a, b) => b.market - a.market);

// receipts — concrete, factual calls (the page renders bilingual captions by `kind`)
const byName = Object.fromEntries(bt.outright.map((o) => [o.name, o]));
const champ = byName[bt.realChampion];
const favourite = bt.outright[0]; // model's pre-tournament title favourite
// dark horse: deepest actual run among teams the model gave a long-shot title prob (<5%)
const darkHorse = [...bt.outright]
  .filter((o) => o.prob.title < 0.05)
  .sort((a, b) => depthOf(b.hit) - depthOf(a.hit) || a.prob.sf - b.prob.sf)[0];
// biggest model-over-market miss: model rated them high, market didn't, and they underperformed
const overrated = market
  .map((m) => ({ ...m, gap: m.model - m.market }))
  .filter((m) => m.reached === 'group' || m.reached === 'r16')
  .sort((a, b) => b.gap - a.gap)[0];

const receipts = [
  { kind: 'champion', name: champ.name, code: champ.code, titlePct: champ.prob.title, rank: champ.fieldRank },
  { kind: 'favouriteFell', name: favourite.name, code: favourite.code, titlePct: favourite.prob.title, reached: deepestRound(favourite.hit) },
  darkHorse && { kind: 'darkHorse', name: darkHorse.name, code: darkHorse.code, titlePct: darkHorse.prob.title, sfPct: darkHorse.prob.sf, reached: deepestRound(darkHorse.hit) },
  overrated && { kind: 'overrated', name: overrated.name, code: overrated.code, model: overrated.model, market: overrated.market, reached: overrated.reached },
].filter(Boolean);

const data = {
  meta: {
    title: 'AI World Cup model — 2022 backtest',
    built: new Date().toISOString().slice(0, 10),
    tournament: 'FIFA World Cup 2022',
    ratingSnapshot: '6 October 2022 (pre-tournament FIFA ranking)',
    sims: bt.config.sims,
    frozenModel: true,
    sources: {
      ratings: 'FIFA / Coca-Cola Men\'s World Ranking, 6 Oct 2022 (inside.fifa.com API id13792)',
      results: 'openfootball/worldcup.json (2022) — public domain',
      odds: ODDS_SOURCE,
    },
    teamNamesEs: TEAM_ES_2022,
  },
  sanity: bt.sanity,
  realChampion: bt.realChampion,
  calibration: bt.calibration,
  outright: bt.outright,
  market,
  receipts,
};

mkdirSync(APP, { recursive: true });
writeFileSync(join(APP, 'accuracy-data.json'), JSON.stringify(data, null, 2) + '\n');
writeFileSync(join(APP, 'accuracy-data.js'), `window.WC_ACCURACY = ${JSON.stringify(data)};\n`);

const f = (x) => (100 * x).toFixed(1);
console.log('build:backtest — wrote app/accuracy-data.js + app/accuracy-data.json');
console.log(`  champion ${data.realChampion} · Brier ${bt.calibration.brier.toFixed(4)} vs baseline ${bt.calibration.brierBaseline.toFixed(4)}`);
console.log(`  receipts: ${receipts.map((r) => `${r.kind}:${r.name}`).join(', ')}`);
console.log(`  market de-vig overround ${(overround * 100).toFixed(1)}% · top market ${market[0].name} ${f(market[0].market)}% (model ${f(market[0].model)}%)`);
