// Turn a full in-memory sim result into a compact, JSON-safe object: the full
// knockout bracket + group standings. This is what gets persisted for featured
// sims (Stage 3 narration + Stage 4 UI consume it).

function teamRef(t) {
  return {
    name: t.name,
    code: t.code,
    group: t.group,
    fieldRank: t.fieldRank,
    worldRank: t.worldRank, // flavor only — always render as "world #N"
    points: t.fifaPoints,
  };
}

export function serializeSim(sim) {
  const groups = {};
  for (const [id, g] of Object.entries(sim.groups)) {
    groups[id] = g.standings.map((r) => ({
      ...teamRef(r.team),
      pts: r.pts,
      gf: r.gf,
      ga: r.ga,
      gd: r.gd,
    }));
  }
  const knockout = Object.entries(sim.results).map(([id, r]) => ({
    id,
    round: r.round,
    home: teamRef(r.home),
    away: teamRef(r.away),
    homeGoals: r.gh,
    awayGoals: r.ga,
    winner: r.winner.name,
    loser: r.loser.name,
    decidedBy: r.decidedBy, // 'REG' | 'ET' | 'PENS'
  }));
  return {
    champion: teamRef(sim.champion),
    runnerUp: teamRef(sim.runnerUp),
    thirdPlace: teamRef(sim.thirdPlace),
    fourthPlace: teamRef(sim.fourthPlace),
    groups,
    knockout,
  };
}
