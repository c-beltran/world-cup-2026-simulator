// One-time, reproducible builder for the 2022 World Cup BACKTEST inputs.
// Fetches the two public sources, reconciles names, and writes the committed files:
//   data/2022/groups.json           — real 8-group draw (names + flag codes)
//   data/2022/bracket.json          — 32-team knockout wiring (verified vs actual matchups)
//   data/2022/teams.json            — rated teams (strength = pre-WC FIFA points)
//   data/2022/results-openfootball.json — raw results snapshot (offline + provenance)
//   pipeline/sources/fifa-ranking-2022-10-06.raw.json   — raw FIFA API payload
//   pipeline/sources/fifa-rankings-2022-10-06.json      — derived 32-team rating source
//
//   node init2022.js
//
// HONESTY: ratings are the GENUINE pre-tournament FIFA ranking (release 6 Oct 2022,
// the last before Qatar 2022 — FIFA ranking API dateId id13792), NOT the post-event
// Dec 2022 ranking. The 6-Oct order (Brazil, Belgium, Argentina, France, England,
// Italy, Spain, Netherlands, Portugal, Denmark; Morocco #22) is cross-checked against
// independent reporting of that release. No hindsight.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const D2022 = join(ROOT, 'data', '2022');
const SRC = join(import.meta.dirname, 'sources');

const OF_URL = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2022/worldcup.json';
const FIFA_DATE_ID = 'id13792'; // 2022-10-06 men's ranking (verified)
const FIFA_URL = `https://inside.fifa.com/api/ranking-overview?locale=en&dateId=${FIFA_DATE_ID}`;

// canonical name (openfootball spelling) -> flagcdn code
const CODES = {
  Qatar: 'qa', Ecuador: 'ec', Senegal: 'sn', Netherlands: 'nl', England: 'gb-eng', Iran: 'ir', USA: 'us', Wales: 'gb-wls',
  Argentina: 'ar', 'Saudi Arabia': 'sa', Mexico: 'mx', Poland: 'pl', Denmark: 'dk', Tunisia: 'tn', France: 'fr', Australia: 'au',
  Germany: 'de', Japan: 'jp', Spain: 'es', 'Costa Rica': 'cr', Morocco: 'ma', Croatia: 'hr', Belgium: 'be', Canada: 'ca',
  Switzerland: 'ch', Cameroon: 'cm', Brazil: 'br', Serbia: 'rs', Uruguay: 'uy', 'South Korea': 'kr', Portugal: 'pt', Ghana: 'gh',
};
// FIFA ranking spells two of our teams differently
const CANON_TO_FIFA = { Iran: 'IR Iran', 'South Korea': 'Korea Republic' };
const fifaName = (c) => CANON_TO_FIFA[c] || c;

// 32-team knockout wiring. Verified: with the real group winners/runners-up it reproduces
// every actual 2022 R16→Final matchup (Argentina champion). Final=M104, 3rd=M103 so the
// engine's result-keying works unchanged. No third-place slots (thirds go home).
const G = (group, pos) => ({ source: 'group', group, pos });
const W = (match) => ({ source: 'match', match, take: 'winner' });
const Lz = (match) => ({ source: 'match', match, take: 'loser' });
const BRACKET = {
  tournament: 'FIFA World Cup 2022 — knockout stage',
  source: 'Official 2022 bracket; wiring verified against actual openfootball matchups.',
  knockout: [
    { id: 'M89', round: 'R16', home: G('A', 'winner'), away: G('B', 'runnerup') },
    { id: 'M90', round: 'R16', home: G('C', 'winner'), away: G('D', 'runnerup') },
    { id: 'M91', round: 'R16', home: G('E', 'winner'), away: G('F', 'runnerup') },
    { id: 'M92', round: 'R16', home: G('G', 'winner'), away: G('H', 'runnerup') },
    { id: 'M93', round: 'R16', home: G('B', 'winner'), away: G('A', 'runnerup') },
    { id: 'M94', round: 'R16', home: G('D', 'winner'), away: G('C', 'runnerup') },
    { id: 'M95', round: 'R16', home: G('F', 'winner'), away: G('E', 'runnerup') },
    { id: 'M96', round: 'R16', home: G('H', 'winner'), away: G('G', 'runnerup') },
    { id: 'M97', round: 'QF', home: W('M89'), away: W('M90') },
    { id: 'M98', round: 'QF', home: W('M91'), away: W('M92') },
    { id: 'M99', round: 'QF', home: W('M93'), away: W('M94') },
    { id: 'M100', round: 'QF', home: W('M95'), away: W('M96') },
    { id: 'M101', round: 'SF', home: W('M97'), away: W('M98') },
    { id: 'M102', round: 'SF', home: W('M99'), away: W('M100') },
    { id: 'M103', round: '3rd_place', home: Lz('M101'), away: Lz('M102') },
    { id: 'M104', round: 'final', home: W('M101'), away: W('M102') },
  ],
};

// ---- fetch sources ----
const of = await (await fetch(OF_URL)).json();
const fifaRaw = await (await fetch(FIFA_URL)).json();
const fmap = new Map(fifaRaw.rankings.map((x) => [x.rankingItem.name, { rank: x.rankingItem.rank, pts: x.rankingItem.totalPoints }]));

// ---- derive groups from openfootball ----
const groupMap = {}; // gid -> Set(names)
for (const m of of.matches) {
  if (!m.group) continue;
  const gid = m.group.replace(/^Group\s+/i, '').trim();
  (groupMap[gid] ||= new Set()).add(m.team1);
  groupMap[gid].add(m.team2);
}
const allTeams = [...new Set(Object.values(groupMap).flatMap((s) => [...s]))];

// ---- resolve ratings; fieldRank within the 32 by FIFA points ----
const missing = allTeams.filter((n) => !fmap.get(fifaName(n)) || !CODES[n]);
if (missing.length) { console.error('Unresolved teams (need code/rating):', missing.join(', ')); process.exit(1); }
const teams = allTeams.map((n) => {
  const f = fmap.get(fifaName(n));
  const gid = Object.keys(groupMap).find((g) => groupMap[g].has(n));
  return { name: n, code: CODES[n], group: gid, worldRank: f.rank, fifaPoints: f.pts, strength: f.pts };
});
teams.sort((a, b) => b.fifaPoints - a.fifaPoints).forEach((t, i) => { t.fieldRank = i + 1; });
const byName = new Map(teams.map((t) => [t.name, t]));

// ---- groups.json (teams ordered by rating within each group) ----
const groups = Object.keys(groupMap).sort().map((gid) => ({
  id: gid,
  teams: [...groupMap[gid]].map((n) => byName.get(n)).sort((a, b) => a.fieldRank - b.fieldRank).map((t) => ({ name: t.name, code: t.code })),
}));

// ---- write everything ----
mkdirSync(D2022, { recursive: true });
mkdirSync(SRC, { recursive: true });

writeFileSync(join(SRC, 'fifa-ranking-2022-10-06.raw.json'), JSON.stringify(fifaRaw, null, 2) + '\n');
writeFileSync(join(SRC, 'fifa-rankings-2022-10-06.json'), JSON.stringify({
  source: 'FIFA / Coca-Cola Men\'s World Ranking',
  release: '2022-10-06',
  note: 'The LAST official ranking before the 2022 World Cup (20 Nov 2022). Genuinely pre-tournament — NOT the post-event Dec 2022 ranking. No hindsight.',
  endpoint: FIFA_URL,
  dateId: FIFA_DATE_ID,
  retrievedVia: 'inside.fifa.com ranking API',
  verification: 'Order cross-checked vs independent reporting of the 6 Oct 2022 release (Brazil 1, Belgium 2, Argentina 3, France 4, England 5, Italy 6, Spain 7, Netherlands 8, Portugal 9, Denmark 10; Morocco 22).',
  teams: teams.slice().sort((a, b) => a.worldRank - b.worldRank).map((t) => ({ name: t.name, fifaName: fifaName(t.name), worldRank: t.worldRank, points: t.fifaPoints })),
}, null, 2) + '\n');

writeFileSync(join(D2022, 'results-openfootball.json'), JSON.stringify(of, null, 2) + '\n');
writeFileSync(join(D2022, 'groups.json'), JSON.stringify({
  tournament: 'FIFA World Cup 2022', note: 'Real 2022 group draw (8 groups). Derived from openfootball; teams ordered by pre-WC FIFA points.', groups,
}, null, 2) + '\n');
writeFileSync(join(D2022, 'bracket.json'), JSON.stringify(BRACKET, null, 2) + '\n');
writeFileSync(join(D2022, 'teams.json'), JSON.stringify({
  tournament: 'FIFA World Cup 2022',
  ratingSource: 'FIFA / Coca-Cola Men\'s World Ranking',
  ratingSnapshot: '6 October 2022',
  ratingNote: 'Pre-tournament (last release before Qatar 2022). strength = FIFA points, used directly (model divisor 600). fieldRank = 1-32 within this field.',
  rankBasis: 'fieldRank (1-32) primary; worldRank is the global FIFA rank (flavor).',
  teams: teams.sort((a, b) => a.fieldRank - b.fieldRank),
}, null, 2) + '\n');

console.log(`init2022: ${teams.length} teams · ${groups.length} groups · bracket ${BRACKET.knockout.length} matches`);
console.log(`  top 5: ${teams.slice(0, 5).map((t) => `${t.name} ${t.fifaPoints}`).join(', ')}`);
console.log(`  wrote data/2022/{groups,bracket,teams,results-openfootball}.json + pipeline/sources/fifa-ranking(s)-2022-10-06*`);
