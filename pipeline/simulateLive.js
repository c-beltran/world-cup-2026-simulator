// Live (conditional) Monte Carlo — the "as of today" re-forecast.
//
//   node simulateLive.js [sims]      (default 50000)   env: SIMS, SEED
//
// Two things change vs the frozen pre-tournament sim, both driven by REAL results
// from data/live/latest.json (openfootball):
//   1. RATINGS move on the pitch — lib/elo.js replays every finished match onto the
//      frozen 1-April FIFA points (FIFA's own SUM formula). Updated ratings drive the
//      strength of every STILL-UNPLAYED match.
//   2. PLAYED matches are CLAMPED — the sim is forced to reproduce the real scoreline
//      (it draws no RNG for them) and only re-simulates the unknown remainder.
// At 0 games played this is identical to the frozen baseline (validated).
//
// Also emits analytic (closed-form, no RNG) per-match odds for every upcoming fixture
// whose teams are already known — W/D/L, advance%, expected + most-likely scoreline.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32, simSeed } from './lib/rng.js';
import { prepareBracket, simulateTournament, pairKey } from './lib/tournament.js';
import { MODEL, winExpectancy, expectedGoals } from './lib/model.js';
import { updateRatings } from './lib/elo.js';
import { groupTable, clinchFlags } from './lib/standings.js';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(import.meta.dirname, 'out');
const read = (p) => JSON.parse(readFileSync(join(ROOT, 'data', p), 'utf8'));

const teamsDoc = read('teams.json');
const groupsDoc = read('groups.json');
const bracketDoc = read('bracket.json');
const live = JSON.parse(readFileSync(join(ROOT, 'data', 'live', 'latest.json'), 'utf8'));

// Frozen baseline for the Δ columns. Prefer pipeline/out/sim-results.json (full local
// run); fall back to the committed app/data.json (same numbers, shipped in the app) so
// CI doesn't have to regenerate the baseline — pipeline/out is gitignored.
function loadBaseline() {
  const simPath = join(OUT_DIR, 'sim-results.json');
  if (existsSync(simPath)) {
    const s = JSON.parse(readFileSync(simPath, 'utf8'));
    return { champions: s.champions, reach: s.reach, completed: s.config.completed || s.config.sims, seed: s.config.masterSeed };
  }
  const d = JSON.parse(readFileSync(join(ROOT, 'app', 'data.json'), 'utf8'));
  return { champions: d.stats.champions, reach: d.stats.reach, completed: d.meta.sims, seed: d.meta.masterSeed };
}
const baseline = loadBaseline();

const bracket = prepareBracket(bracketDoc);
const SIMS = Number(process.argv[2] || process.env.SIMS || 50000);
const MASTER_SEED = Number(process.env.SEED || 20260611);

// ---- 1. REAL played matches → Elo update on the frozen ratings ----
const baseRatings = Object.fromEntries(teamsDoc.teams.map((t) => [t.name, t.strength]));
const played = live.matches
  .filter((mm) => mm.finished && mm.home && mm.away)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const { ratings: liveRatings, log: eloLog } = updateRatings(baseRatings, played);

// Updated team objects (strength moves; identity/rank/base points preserved).
const teamsByName = new Map(
  teamsDoc.teams.map((t) => [t.name, { ...t, strength: liveRatings[t.name] ?? t.strength }]),
);

// ---- 2. Clamp REAL results so the sim reproduces them exactly ----
const clamp = { groups: new Map(), ko: new Map() };
for (const mm of played) {
  if (mm.round === 'group') {
    const g = mm.group;
    if (!clamp.groups.has(g)) clamp.groups.set(g, new Map());
    clamp.groups.get(g).set(pairKey(mm.home, mm.away), { [mm.home]: mm.homeGoals, [mm.away]: mm.awayGoals });
  } else {
    clamp.ko.set(pairKey(mm.home, mm.away), {
      goals: { [mm.home]: mm.homeGoals, [mm.away]: mm.awayGoals },
      winner: mm.winner,
      decidedBy: mm.decidedBy || 'REG',
    });
  }
}

// ---- 2b. Upcoming fixtures + per-match conditional-advancement tracking ----
// Track every upcoming GROUP match so ONE conditional run can bucket, per team,
// P(reach R32 | they win / draw / lose this exact match) — the honest basis for
// "what needs to happen" (no separate sims, no false determinism).
const upcoming = live.matches
  .filter((mm) => !mm.finished && mm.home && mm.away)
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const nextDate = upcoming.length ? upcoming[0].date : null;
const trackPairs = upcoming.filter((mm) => mm.round === 'group');
const track = trackPairs.length ? new Set(trackPairs.map((mm) => pairKey(mm.home, mm.away))) : null;
const cond = new Map(); // pairKey -> { [team]: { win:{n,adv}, draw:{n,adv}, loss:{n,adv} } }
for (const mm of trackPairs) {
  const blank = () => ({ win: { n: 0, adv: 0 }, draw: { n: 0, adv: 0 }, loss: { n: 0, adv: 0 } });
  cond.set(pairKey(mm.home, mm.away), { [mm.home]: blank(), [mm.away]: blank() });
}

// ---- 2c. Real third-place slot assignment (so the projected bracket uses the TRUE R32) ----
// assignThirds is a disclosed Annex-C APPROXIMATION; once the groups are decided and the real
// R32 draw is published upstream, derive the true slot→group mapping and pin it, so the
// knockout projection is built on the REAL bracket — not the approximation (which can swap a
// couple of thirds). Returns null until the R32 is fully drawn → engine falls back gracefully.
function deriveThirdOverride() {
  const r32 = live.matches.filter((mm) => mm.round === 'R32' && mm.home && mm.away);
  const r32MatchCount = bracketDoc.knockout.filter((mm) => mm.round === 'R32').length;
  if (r32.length < r32MatchCount) return null;
  const rowsByGroup = new Map();
  const where = new Map(); // name -> { group, pos (1-based) } from the final group tables
  for (const g of groupsDoc.groups) {
    const rows = groupTable(g.teams.map((t) => teamsByName.get(t.name)), played.filter((mm) => mm.round === 'group' && mm.group === g.id));
    rowsByGroup.set(g.id, rows);
    rows.forEach((r) => where.set(r.name, { group: g.id, pos: r.pos }));
  }
  const oppOf = new Map();
  for (const mm of r32) { oppOf.set(mm.home, mm.away); oppOf.set(mm.away, mm.home); }
  const override = new Map();
  for (const mm of bracketDoc.knockout) {
    if (mm.round !== 'R32') continue;
    const groupSlot = mm.home.source === 'third' ? mm.away : mm.away.source === 'third' ? mm.home : null;
    if (!groupSlot) continue; // no third-place slot in this match
    const rows = rowsByGroup.get(groupSlot.group);
    const groupTeam = rows && rows.find((r) => r.pos === (groupSlot.pos === 'winner' ? 1 : 2));
    if (!groupTeam) return null;
    const third = where.get(oppOf.get(groupTeam.name)); // the team really paired here = the third
    if (!third || third.pos !== 3) return null;
    override.set(mm.id, third.group);
  }
  return override.size === bracketDoc.knockout.filter((mm) => mm.round === 'R32' && (mm.home.source === 'third' || mm.away.source === 'third')).length
    ? override : null;
}
const thirdOverride = deriveThirdOverride();

// ---- 3. Conditional Monte Carlo ----
const codeOf = (n) => teamsByName.get(n)?.code || '';
const fieldOf = (n) => teamsByName.get(n)?.fieldRank;
const championCount = new Map();
const reach = new Map();
const reachOf = (n) => {
  let r = reach.get(n);
  if (!r) reach.set(n, (r = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, title: 0 }));
  return r;
};
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
const violations = { roundSize: 0, matchingFail: 0 };

// projected-bracket tally: per KO match, who occupies each slot + who advances, across sims.
const slotTally = new Map(); // matchId -> { home:Map, away:Map, win:Map }
const slotOf = (id) => { let s = slotTally.get(id); if (!s) slotTally.set(id, (s = { home: new Map(), away: new Map(), win: new Map() })); return s; };

// per-group final-position distribution (for the projected final table)
const posCount = new Map(); // groupId -> Map(teamName -> [p1,p2,p3,p4])
for (const g of groupsDoc.groups) {
  const mt = new Map();
  for (const tt of g.teams) mt.set(tt.name, [0, 0, 0, 0]);
  posCount.set(g.id, mt);
}

const t0 = performance.now();
for (let i = 0; i < SIMS; i++) {
  let sim;
  try {
    sim = simulateTournament(teamsByName, groupsDoc, bracket, mulberry32(simSeed(MASTER_SEED, i)), MODEL, clamp, track, thirdOverride);
  } catch {
    violations.matchingFail++;
    continue;
  }
  if (sim.reach.r32.length !== 32 || sim.reach.sf.length !== 4 || sim.reach.final.length !== 2) violations.roundSize++;
  bump(championCount, sim.champion.name);
  reachOf(sim.champion.name).title++;
  for (const t of sim.reach.final) reachOf(t.name).final++;
  for (const t of sim.reach.sf) reachOf(t.name).sf++;
  for (const t of sim.reach.qf) reachOf(t.name).qf++;
  for (const t of sim.reach.r16) reachOf(t.name).r16++;
  for (const t of sim.reach.r32) reachOf(t.name).r32++;

  // projected-bracket: tally who fills each slot and who advances from each KO match
  for (const mm of bracketDoc.knockout) {
    const res = sim.results[mm.id];
    if (!res) continue;
    const s = slotOf(mm.id);
    bump(s.home, res.home.name); bump(s.away, res.away.name); bump(s.win, res.winner.name);
  }

  // tally each team's final position within its group (standings sorted 1st→4th)
  for (const g of groupsDoc.groups) {
    const st = sim.groups[g.id].standings, mt = posCount.get(g.id);
    for (let p = 0; p < st.length; p++) mt.get(st[p].team.name)[p]++;
  }

  // bucket conditional advancement for the tracked group matches
  if (sim.tracked) {
    const r32 = new Set(sim.reach.r32.map((t) => t.name));
    for (const key in sim.tracked) {
      const goals = sim.tracked[key], c = cond.get(key);
      if (!c) continue;
      const [n1, n2] = Object.keys(goals);
      for (const [name, other] of [[n1, n2], [n2, n1]]) {
        const bucket = goals[name] > goals[other] ? 'win' : goals[name] < goals[other] ? 'loss' : 'draw';
        c[name][bucket].n++;
        if (r32.has(name)) c[name][bucket].adv++;
      }
    }
  }
}
const elapsed = performance.now() - t0;
const N = SIMS - violations.matchingFail;
const pct = (n) => (100 * n) / N;

const baseTitlePct = new Map(baseline.champions.map((c) => [c.name, c.pct]));
const baseReach = new Map(baseline.reach.map((r) => [r.name, r]));
const baseN = baseline.completed || 50000;

const champions = [...championCount.entries()]
  .map(([name, count]) => ({
    name, code: codeOf(name), fieldRank: fieldOf(name),
    count, pct: pct(count),
    basePct: baseTitlePct.get(name) ?? 0,
    delta: pct(count) - (baseTitlePct.get(name) ?? 0),
  }))
  .sort((a, b) => b.count - a.count);

const reachTable = [...reach.entries()]
  .map(([name, r]) => {
    const br = baseReach.get(name);
    const advPct = pct(r.r32); // "advance from the group" = reach the Round of 32
    const baseAdv = br ? (100 * br.r32) / baseN : 0;
    return {
      name, code: codeOf(name), fieldRank: fieldOf(name), ...r,
      advancePct: advPct, baseAdvancePct: baseAdv, advanceDelta: advPct - baseAdv,
      titlePct: pct(r.title), baseTitlePct: baseTitlePct.get(name) ?? 0,
    };
  })
  .sort((a, b) => b.title - a.title || b.final - a.final || b.sf - a.sf);

// ---- 4. Analytic per-match odds for upcoming fixtures with known teams ----
const fact = (k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return f; };
const pois = (lam, k) => (Math.exp(-lam) * Math.pow(lam, k)) / fact(k);
const GRID = 11; // goals 0..10 — captures ~all mass for these lambdas

function projectMatch(home, away, round) {
  const a = teamsByName.get(home), b = teamsByName.get(away);
  const [la, lb] = expectedGoals(a.strength, b.strength, MODEL);
  const ph = Array.from({ length: GRID }, (_, k) => pois(la, k));
  const pa = Array.from({ length: GRID }, (_, k) => pois(lb, k));
  let pHome = 0, pDraw = 0, pAway = 0, best = { p: -1, h: 0, a: 0 };
  for (let h = 0; h < GRID; h++) for (let g = 0; g < GRID; g++) {
    const p = ph[h] * pa[g];
    if (h > g) pHome += p; else if (h < g) pAway += p; else pDraw += p;
    if (p > best.p) best = { p, h, a: g };
  }
  const we = winExpectancy(a.strength, b.strength);
  // knockout: a draw is resolved in ET/penalties, tilted to the better side (PEN_TILT)
  const penHome = 0.5 + (we - 0.5) * MODEL.PEN_TILT;
  return {
    home, homeCode: codeOf(home), away, awayCode: codeOf(away), round,
    pHome, pDraw, pAway,
    advanceHome: pHome + pDraw * penHome, // for knockout fixtures
    expHome: la, expAway: lb,
    likely: { home: best.h, away: best.a, p: best.p },
    knockout: round !== 'group',
  };
}

// conditional advancement P(reach R32 | win/draw/loss) per tracked match + team
const condResult = {};
for (const [key, c] of cond) {
  condResult[key] = {};
  for (const name in c) {
    const o = c[name];
    const safe = (x) => (x.n > 0 ? x.adv / x.n : null);
    condResult[key][name] = { ifWin: safe(o.win), ifDraw: safe(o.draw), ifLoss: safe(o.loss), nWin: o.win.n, nDraw: o.draw.n, nLoss: o.loss.n };
  }
}

const projections = upcoming.map((mm) => {
  const base = { date: mm.date, time: mm.time, kickoff: mm.kickoff, group: mm.group, ...projectMatch(mm.home, mm.away, mm.round) };
  const c = condResult[pairKey(mm.home, mm.away)];
  if (c) base.cond = { home: c[mm.home] || null, away: c[mm.away] || null };
  return base;
});

// ---- 4b. Live group standings (deterministic) + projected finish + status ----
const advByName = new Map(reachTable.map((r) => [r.name, r.advancePct]));
// projected finish: rank a group's teams by EXPECTED final position (Σ pos·P(pos)) →
// a clean 1-4 permutation. posDist = [P(1st)..P(4th)]. A fully-played group is
// deterministic, so its projection equals the real final order (a free correctness check).
function projectGroup(gid) {
  const mt = posCount.get(gid);
  const out = new Map();
  const ranked = [...mt.entries()].map(([name, c]) => {
    const tot = c[0] + c[1] + c[2] + c[3] || 1;
    const dist = c.map((n) => n / tot);
    const exp = dist.reduce((s, p, i) => s + (i + 1) * p, 0);
    out.set(name, { posDist: dist, exp });
    return { name, exp };
  });
  ranked.sort((a, b) => a.exp - b.exp);
  ranked.forEach((r, i) => { out.get(r.name).projectedPos = i + 1; });
  return out;
}
const standings = groupsDoc.groups.map((g) => {
  const teamObjs = g.teams.map((t) => teamsByName.get(t.name));
  const gp = played.filter((m) => m.round === 'group' && m.group === g.id);
  const rows = groupTable(teamObjs, gp);
  // Remaining (unplayed) group fixtures, so the clinch test knows which chasers must
  // still play each other (two of them can't both win their head-to-head).
  const remaining = live.matches
    .filter((m) => m.round === 'group' && m.group === g.id && !m.finished && m.home && m.away)
    .map((m) => ({ home: m.home, away: m.away }));
  const flags = clinchFlags(rows, remaining);
  const proj = projectGroup(g.id);
  return {
    id: g.id,
    rows: rows.map((r) => {
      const f = flags[r.name];
      const adv = advByName.get(r.name) ?? 0;
      const pr = proj.get(r.name);
      let status = 'live';
      if (f.clinchedTop2) status = 'through';      // guaranteed top 2 → through
      else if (f.eliminatedTop2 && adv < 0.05) status = 'out'; // can't make top 2 and 0% via thirds
      else if (f.eliminatedTop2) status = 'third'; // top 2 gone, 3rd-place path still alive
      return {
        pos: r.pos, name: r.name, code: r.code,
        p: r.p, w: r.w, d: r.d, l: r.l, gf: r.gf, ga: r.ga, gd: r.gd, pts: r.pts, remaining: r.remaining,
        advancePct: adv, status,
        projectedPos: pr.projectedPos, posDist: pr.posDist.map((x) => Math.round(x * 1000) / 1000),
      };
    }),
  };
});

// ---- 5. Rating movers (biggest Elo deltas so far) ----
const movers = Object.entries(eloLog)
  .map(([name, l]) => ({ name, code: codeOf(name), from: l.from, to: l.to, delta: l.to - l.from, played: l.played }))
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

// ---- projected bracket: top occupants per slot + projected advancer, from the slot tally ----
// home[0]/away[0] = modal occupant + its MARGINAL probability of reaching that slot (not a
// joint-pairing claim). With the real third-place override, R32 occupants are deterministic
// (p≈1); R16+ are projections that converge to the real teams as KO games are clamped.
const teamRef = (name) => ({ name, code: codeOf(name), fieldRank: fieldOf(name) });
const topOccupants = (mp, k) => [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, c]) => ({ ...teamRef(name), p: c / N }));
const projectedBracket = bracketDoc.knockout.map((mm) => {
  const s = slotTally.get(mm.id) || { home: new Map(), away: new Map(), win: new Map() };
  return { id: mm.id, round: mm.round, home: topOccupants(s.home, 3), away: topOccupants(s.away, 3), favorite: topOccupants(s.win, 1)[0] || null };
});

// ---- champion's road to the final: the modal champion's path through the bracket, R32 → final.
// The bracket is a fixed tree, so the champion occupies exactly one slot per round. We follow the
// winner-feed edges forward from its (clamped, deterministic) R32 match to M104, attaching the
// champion's MARGINAL reach probability at each node — an honest "odds at each step", not a joint
// claim. Driven off the champion's own reach counts, so it stays correct even if it isn't the
// modal occupant of some deep slot on a future re-bake. null if the bracket isn't yet derivable.
const championPath = (() => {
  const champ = champions[0];
  if (!champ) return null;
  const winnerFeed = new Map(); // matchId -> the match that consumes its winner
  for (const mm of bracketDoc.knockout)
    for (const slot of [mm.home, mm.away])
      if (slot.source === 'match' && slot.take === 'winner') winnerFeed.set(slot.match, mm.id);
  let cur = null; // the champion's R32 match (its slot tally contains it)
  for (const mm of bracketDoc.knockout) {
    if (mm.round !== 'R32') continue;
    const s = slotTally.get(mm.id);
    if (s && ((s.home.get(champ.name) || 0) > 0 || (s.away.get(champ.name) || 0) > 0)) { cur = mm.id; break; }
  }
  if (!cur) return null;
  const cr = reach.get(champ.name) || {};
  const reachByRound = { R32: cr.r32 || 0, R16: cr.r16 || 0, QF: cr.qf || 0, SF: cr.sf || 0, final: cr.final || 0 };
  const nodes = [];
  while (cur) {
    const mm = bracketDoc.knockout.find((x) => x.id === cur);
    const s = slotTally.get(cur) || { home: new Map(), away: new Map() };
    const side = (s.home.get(champ.name) || 0) >= (s.away.get(champ.name) || 0) ? 'home' : 'away';
    nodes.push({ id: cur, round: mm.round, side, reachPct: pct(reachByRound[mm.round] ?? 0) });
    cur = winnerFeed.get(cur);
  }
  return { name: champ.name, code: champ.code, fieldRank: champ.fieldRank, titlePct: champ.pct, nodes };
})();

const out = {
  kind: 'live',
  generatedFrom: { source: live.source, sourceUrl: live.sourceUrl, fetchedAt: live.fetchedAt },
  asOfDate: live.asOfDate,
  playedCount: live.playedCount,
  groupPlayedCount: live.groupPlayedCount,
  groupTotal: live.groupTotal,
  config: { sims: SIMS, completed: N, masterSeed: MASTER_SEED, model: MODEL, elapsedMs: Math.round(elapsed) },
  ratingSource: teamsDoc.ratingSource,
  ratingSnapshot: teamsDoc.ratingSnapshot,
  eloRule: "FIFA SUM: P' = P + I·(W − We), divisor 600; W/D/L 1/0.5/0, shootout 0.75/0.25.",
  baselineRef: { sims: baseN, seed: baseline.seed },
  validation: violations,
  champions,
  reach: reachTable,
  standings,
  nextDate,
  projections,
  projectedBracket,
  championPath,
  thirdOverrideApplied: !!thirdOverride,
  movers,
  results: played, // the clamped real results, for display + provenance
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'sim-live.json'), JSON.stringify(out, null, 2) + '\n');

// ---- console report ----
const f1 = (x) => x.toFixed(1);
const sgn = (x) => (x >= 0 ? `+${f1(x)}` : f1(x));
console.log(`\nLIVE MONTE CARLO — ${N.toLocaleString()} sims in ${(elapsed / 1000).toFixed(2)}s · as of ${live.asOfDate} (${live.groupPlayedCount}/72 group games)`);
console.log(`Validation (want 0): bad round sizes ${violations.roundSize} | matching failures ${violations.matchingFail}`);
console.log(`\nTITLE ODDS — live vs frozen (top 10)`);
for (const c of champions.slice(0, 10)) {
  console.log(`  ${`${c.name} [#${c.fieldRank}]`.padEnd(22)} ${f1(c.pct).padStart(5)}%  (was ${f1(c.basePct)}%, ${sgn(c.delta)})`);
}
console.log(`\nBIGGEST RATING MOVES (FIFA SUM)`);
for (const m of movers.slice(0, 8)) console.log(`  ${m.name.padEnd(22)} ${sgn(m.delta).padStart(6)}  (${m.played} game${m.played === 1 ? '' : 's'})`);
console.log(`\nNEXT FIXTURES (${nextDate}) — analytic odds`);
for (const p of projections.filter((x) => x.date === nextDate)) {
  console.log(`  ${p.home} vs ${p.away}:  ${Math.round(p.pHome * 100)}% / ${Math.round(p.pDraw * 100)}% / ${Math.round(p.pAway * 100)}%  · likely ${p.likely.home}-${p.likely.away}`);
}
console.log(`\nWrote pipeline/out/sim-live.json\n`);
