// One full tournament, deterministic given an RNG.
// Pure (no fs): caller supplies the verified data + a seeded RNG. This lets Stage 3
// replay any sim exactly.

import { playGroupMatch, playKnockoutMatch, winExpectancy, MODEL } from './model.js';

// Upset magnitude of a decided match: how far below 50% the winner's pre-match
// win-expectancy was. 0 for a coin-flip, → 0.5 for a heavy favourite beaten.
// Summed across ALL matches it measures how chaotic a whole tournament was.
const matchUpset = (w, l) => {
  const we = winExpectancy(w.strength, l.strength);
  return we < 0.5 ? 0.5 - we : 0;
};

// Order-independent key for a matchup, so a clamped REAL result can be looked up
// regardless of which side the sim happens to list as home/away.
export const pairKey = (a, b) => [a, b].sort().join(' | ');

// The 6 round-robin pairings for a group of 4.
const PAIRINGS = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];

// Standings comparator: points -> goal difference -> goals for -> FIFA rating.
// (Real FIFA also uses head-to-head, fair play, then drawing of lots; we approximate
// with the first three official criteria + rating as a deterministic final tiebreak.)
function compareStandings(a, b) {
  return b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.team.strength - a.team.strength;
}

// clampGroup (optional): Map pairKey -> { [teamName]: goals }. When a pairing has a
// clamped REAL result we use those goals and draw NO RNG; otherwise we sample as
// usual. With no clamp the RNG stream is byte-identical to the unconditional sim.
function playGroup(teams, rng, m, clampGroup) {
  const rows = teams.map((team) => ({ team, pts: 0, gf: 0, ga: 0, gd: 0 }));
  let favWin = 0;
  let draw = 0;
  let dogWin = 0;
  let goals = 0;
  let umag = 0;
  for (const [i, j] of PAIRINGS) {
    const fixed = clampGroup && clampGroup.get(pairKey(rows[i].team.name, rows[j].team.name));
    const [gi, gj] = fixed
      ? [fixed[rows[i].team.name], fixed[rows[j].team.name]]
      : playGroupMatch(rng, rows[i].team, rows[j].team, m);
    goals += gi + gj;
    rows[i].gf += gi;
    rows[i].ga += gj;
    rows[j].gf += gj;
    rows[j].ga += gi;
    if (gi > gj) rows[i].pts += 3;
    else if (gj > gi) rows[j].pts += 3;
    else {
      rows[i].pts += 1;
      rows[j].pts += 1;
    }
    if (gi === gj) draw++;
    else {
      const iStronger = rows[i].team.strength >= rows[j].team.strength;
      if (gi > gj === iStronger) favWin++;
      else dogWin++;
      umag += gi > gj ? matchUpset(rows[i].team, rows[j].team) : matchUpset(rows[j].team, rows[i].team);
    }
  }
  for (const r of rows) r.gd = r.gf - r.ga;
  rows.sort(compareStandings);
  return { rows, favWin, draw, dogWin, goals, umag };
}

// Bipartite matching of qualifying third-place GROUPS to the 8 third-place SLOTS,
// constrained to each slot's eligible-groups list (Kuhn's augmenting paths).
// Deterministic (fixed iteration order) so replays are identical. This is the
// disclosed approximation of FIFA Annex C: it always respects slot eligibility and
// always fills all 8 slots, but does not reproduce Annex C's exact fixed permutation.
function assignThirds(qualGroupIds, thirdSlots) {
  const slotToGroup = new Map(); // slotId -> groupId
  const sortedGroups = [...qualGroupIds].sort();

  function tryAssign(group, visited) {
    for (const slot of thirdSlots) {
      if (!slot.eligible.has(group) || visited.has(slot.id)) continue;
      visited.add(slot.id);
      const cur = slotToGroup.get(slot.id);
      if (cur === undefined || tryAssign(cur, visited)) {
        slotToGroup.set(slot.id, group);
        return true;
      }
    }
    return false;
  }

  for (const g of sortedGroups) {
    if (!tryAssign(g, new Set())) {
      throw new Error(`Annex-C matching failed: no eligible slot for group ${g}`);
    }
  }
  return slotToGroup; // size 8
}

// Precompute the bracket once (slot descriptors + the 8 third slots).
export function prepareBracket(bracketDoc) {
  const matches = bracketDoc.knockout;
  const thirdSlots = matches
    .filter((mm) => mm.away.source === 'third' || mm.home.source === 'third')
    .map((mm) => {
      const slot = mm.away.source === 'third' ? mm.away : mm.home;
      return { id: mm.id, eligible: new Set(slot.eligible) };
    });
  return { matches, thirdSlots };
}

// Run one tournament. teamsByName: Map name -> team object {name, code, group, strength, fifaRank}.
// clamp (optional): the conditional-Monte-Carlo overrides for REAL played results.
//   { groups: Map<groupId, Map<pairKey,{[name]:goals}>>,
//     ko:     Map<pairKey, { goals:{[name]:g}, winner:name, decidedBy:'REG'|'ET'|'PENS' }> }
// Clamped matches draw NO RNG; everything else is sampled. With no clamp this is the
// unconditional sim, bit-for-bit (validated against the frozen baseline at 0 games).
export function simulateTournament(teamsByName, groupsDoc, bracket, rng, m = MODEL, clamp = null) {
  // --- Group stage ---
  const groups = {};
  const thirds = []; // {group, team, pts, gd, gf}
  const groupOutcomes = { favWin: 0, draw: 0, dogWin: 0, goals: 0 };
  let upsetMag = 0; // aggregate upset magnitude across ALL matches (group + knockout)
  for (const g of groupsDoc.groups) {
    const teamObjs = g.teams.map((t) => teamsByName.get(t.name));
    const clampGroup = clamp && clamp.groups && clamp.groups.get(g.id);
    const { rows, favWin, draw, dogWin, goals, umag } = playGroup(teamObjs, rng, m, clampGroup);
    groupOutcomes.favWin += favWin;
    groupOutcomes.draw += draw;
    groupOutcomes.dogWin += dogWin;
    groupOutcomes.goals += goals;
    upsetMag += umag;
    groups[g.id] = {
      standings: rows,
      winner: rows[0].team,
      runnerup: rows[1].team,
      third: rows[2].team,
    };
    const t3 = rows[2];
    thirds.push({ group: g.id, team: t3.team, pts: t3.pts, gd: t3.gd, gf: t3.gf });
  }

  // --- Best 8 third-place teams (points -> GD -> goals -> rating) ---
  thirds.sort(
    (a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || b.team.strength - a.team.strength,
  );
  const qualifyingThirds = thirds.slice(0, 8);
  const qualGroupIds = qualifyingThirds.map((t) => t.group);
  const slotToGroup = assignThirds(qualGroupIds, bracket.thirdSlots);

  // slotId -> third-place team object
  const thirdByGroup = new Map(thirds.map((t) => [t.group, t.team]));
  const thirdSlotTeam = new Map();
  for (const [slotId, groupId] of slotToGroup) thirdSlotTeam.set(slotId, thirdByGroup.get(groupId));

  // --- Knockout ---
  const results = {}; // matchId -> { round, home, away, gh, ga, winner, loser, decidedBy }
  const resolveSlot = (slot, matchId) => {
    if (slot.source === 'group') return groups[slot.group][slot.pos];
    if (slot.source === 'third') return thirdSlotTeam.get(matchId);
    return results[slot.match][slot.take]; // 'winner' | 'loser'
  };

  const participantsByRound = {};
  const koStats = { goals: 0, matches: 0, upsets: 0, et: 0, pens: 0 };
  for (const mm of bracket.matches) {
    const home = resolveSlot(mm.home, mm.id);
    const away = resolveSlot(mm.away, mm.id);
    const fixed = clamp && clamp.ko && clamp.ko.get(pairKey(home.name, away.name));
    let r;
    if (fixed) {
      // REAL knockout result. Orient the stored goals onto this sim's home/away and
      // build the same shape playKnockoutMatch returns (ga = home goals, gb = away).
      const won = fixed.winner === home.name ? home : away;
      r = { ga: fixed.goals[home.name], gb: fixed.goals[away.name], winner: won, loser: won === home ? away : home, decidedBy: fixed.decidedBy };
    } else {
      r = playKnockoutMatch(rng, home, away, m);
    }
    results[mm.id] = {
      round: mm.round,
      home,
      away,
      gh: r.ga, // r.ga is "goals for a" == home (a=home passed first to playKnockoutMatch)
      ga: r.gb,
      winner: r.winner,
      loser: r.loser,
      decidedBy: r.decidedBy,
    };
    koStats.goals += r.ga + r.gb;
    koStats.matches += 1;
    if (r.winner.strength < r.loser.strength) koStats.upsets += 1;
    upsetMag += matchUpset(r.winner, r.loser);
    if (r.decidedBy === 'ET') koStats.et += 1;
    else if (r.decidedBy === 'PENS') koStats.pens += 1;
    (participantsByRound[mm.round] ||= new Set()).add(home).add(away);
  }

  const champion = results.M104.winner;
  const runnerUp = results.M104.loser;
  const thirdPlace = results.M103.winner;
  const fourthPlace = results.M103.loser;

  const reach = {
    r32: [...(participantsByRound.R32 || [])],
    r16: [...(participantsByRound.R16 || [])],
    qf: [...(participantsByRound.QF || [])],
    sf: [...(participantsByRound.SF || [])],
    final: [results.M104.home, results.M104.away],
  };

  // --- Featured-selection scores (cheap; surfaced in Stage 3, not the Stage 2 gate) ---
  let chaos = 0; // total rating "overcome" by knockout winners (bigger = more upsets)
  let chalk = 0; // number of knockout games the higher-rated team won
  for (const mm of bracket.matches) {
    const res = results[mm.id];
    const diff = res.loser.strength - res.winner.strength;
    if (diff > 0) chaos += diff;
    else chalk += 1;
  }
  // Deepest-running team ranked outside the top CINDERELLA_RANK.
  const roundDepth = { SF: 3, final: 4, champion: 5 };
  let cinderella = null;
  const finalists = new Set(reach.final);
  for (const team of reach.sf) {
    if (team.fieldRank <= m.CINDERELLA_RANK) continue;
    let depth = roundDepth.SF;
    let label = 'Semifinal';
    if (team === champion) {
      depth = roundDepth.champion;
      label = 'Champion';
    } else if (finalists.has(team)) {
      depth = roundDepth.final;
      label = 'Final';
    }
    if (!cinderella || depth > cinderella.depth || (depth === cinderella.depth && team.fieldRank > cinderella.team.fieldRank)) {
      cinderella = { team, depth, round: label };
    }
  }

  return {
    champion,
    runnerUp,
    thirdPlace,
    fourthPlace,
    groups,
    qualifyingThirds,
    slotToGroup,
    results,
    reach,
    groupOutcomes,
    koStats,
    scores: { chaos, chalk, cinderella, upsetMag },
  };
}
