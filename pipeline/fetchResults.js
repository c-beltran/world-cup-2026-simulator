// Fetch real World Cup 2026 fixtures + results from openfootball/worldcup.json
// (public domain, no API key) and write a committed, timestamped, SOURCED snapshot.
// OFFLINE pipeline only — nothing here reaches /app except via the baked live-data.
//
//   npm run fetch
//
// Source: openfootball — https://github.com/openfootball/worldcup.json (public domain).
//   raw: 2026/worldcup.json  ·  { name, matches:[{round,date,team1,team2,score:{ft,ht},group,...}] }
// A match is PLAYED iff it carries score.ft. Names + round strings are reconciled to
// our canonical data via lib/teamNamesOf.js (the build exits if any real name fails).

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toCanon, toRound, groupIdOf, isPlaceholder } from './lib/teamNamesOf.js';

const SRC = 'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
const OUT = join(import.meta.dirname, '..', 'data', 'live');
const ROOT = join(import.meta.dirname, '..');
const CANON_ROUNDS = ['group', 'R32', 'R16', 'QF', 'SF', '3rd_place', 'final'];

const canonTeams = new Set(
  JSON.parse(readFileSync(join(ROOT, 'data', 'groups.json'), 'utf8')).groups.flatMap((g) => g.teams.map((t) => t.name)),
);

const res = await fetch(SRC);
if (!res.ok) {
  console.error(`openfootball fetch failed: HTTP ${res.status} ${SRC}`);
  process.exit(1);
}
const doc = await res.json();
const raw = Array.isArray(doc.matches) ? doc.matches : [];

// A finished knockout result may carry score.et (after extra time) and/or score.p
// (penalty shootout). Group games only ever have score.ft. winner/decidedBy follow that.
function outcome(m) {
  const ft = m.score && m.score.ft;
  if (!Array.isArray(ft)) return null; // not played
  const p = m.score.p, et = m.score.et;
  let decidedBy = 'REG', hg = ft[0], ag = ft[1], winner = null;
  if (Array.isArray(p)) {
    decidedBy = 'PENS';
    winner = p[0] > p[1] ? 'home' : 'away';
  } else if (Array.isArray(et)) {
    decidedBy = 'ET';
    hg = et[0]; ag = et[1];
    winner = hg > ag ? 'home' : ag > hg ? 'away' : null;
  } else {
    winner = hg > ag ? 'home' : ag > hg ? 'away' : null;
  }
  return { homeGoals: hg, awayGoals: ag, decidedBy, winner };
}

const unmappedRounds = new Set();
const unresolvedNames = new Set();
const matches = [];
for (const m of raw) {
  const home = toCanon(m.team1);
  const away = toCanon(m.team2);
  const undetermined = isPlaceholder(m.team1) || isPlaceholder(m.team2);
  // surface any REAL name we failed to map (placeholders are expected to be null)
  if (!home && !isPlaceholder(m.team1)) unresolvedNames.add(m.team1);
  if (!away && !isPlaceholder(m.team2)) unresolvedNames.add(m.team2);

  const round = toRound(m.round, m.group);
  if (!CANON_ROUNDS.includes(round)) unmappedRounds.add(m.round);

  const o = outcome(m);
  matches.push({
    date: m.date || null,
    round,
    rawRound: m.round,
    group: groupIdOf(m.group),
    home, away, // canonical names, or null for undetermined knockout slots
    rawHome: m.team1, rawAway: m.team2,
    undetermined,
    finished: !!o,
    ...(o
      ? { homeGoals: o.homeGoals, awayGoals: o.awayGoals, decidedBy: o.decidedBy,
          winner: o.winner === 'home' ? home : o.winner === 'away' ? away : null }
      : {}),
  });
}

if (unresolvedNames.size) {
  console.error(`Unresolved openfootball team names (add to OF_TO_CANON): ${[...unresolvedNames].join(', ')}`);
  process.exit(1);
}
if (unmappedRounds.size) {
  console.error(`Unmapped round strings (extend toRound): ${[...unmappedRounds].join(' | ')}`);
  process.exit(1);
}

matches.sort((a, b) => String(a.date).localeCompare(String(b.date)));
const played = matches.filter((m) => m.finished && m.home && m.away);
const groupPlayed = played.filter((m) => m.round === 'group');
const lastDate = played.length ? played[played.length - 1].date : null;

const today = new Date().toISOString().slice(0, 10);
const snapshot = {
  source: 'openfootball/worldcup.json (public domain)',
  sourceUrl: 'https://github.com/openfootball/worldcup.json',
  endpoint: SRC,
  tournament: doc.name || 'World Cup 2026',
  fetchedAt: new Date().toISOString(),
  asOfDate: lastDate,
  matchCount: matches.length,
  playedCount: played.length,
  groupPlayedCount: groupPlayed.length,
  groupTotal: 72,
  matches,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `results-${today}.json`), JSON.stringify(snapshot, null, 2) + '\n');
writeFileSync(join(OUT, 'latest.json'), JSON.stringify(snapshot, null, 2) + '\n');

console.log(`openfootball: ${matches.length} matches · ${played.length} played (${groupPlayed.length}/72 group) · as of ${lastDate}`);
for (const m of played.slice(0, Math.min(played.length, 12))) {
  const tag = m.decidedBy === 'REG' ? '' : ` (${m.decidedBy})`;
  console.log(`  ${m.date}  ${m.home} ${m.homeGoals}-${m.awayGoals} ${m.away}${tag}`);
}
console.log(`\nWrote data/live/results-${today}.json + latest.json`);
