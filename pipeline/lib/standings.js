// Live group standings from the REAL played results, plus deterministic
// clinched/eliminated flags. Used by the live forecast's "what needs to happen".
//
// The flags are deliberately CONSERVATIVE — provably correct sufficient conditions,
// computed on points alone, so we never claim "through" or "out" unless it is
// mathematically guaranteed regardless of remaining scorelines. The finer cases
// (who grabs one of the 8 best-third spots, and points-ties broken by goal
// difference) are left to the Monte-Carlo advance% — never asserted as certainty.

// rows: build a table for one group from its played matches.
//   teams:  [{ name, strength, ... }] (4)  ·  played: [{home,away,homeGoals,awayGoals}]
// Returns rows sorted by the engine's order (pts → GD → GF → rating) with positions.
export function groupTable(teams, played) {
  const row = new Map(teams.map((t) => [t.name, { team: t, name: t.name, code: t.code, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
  for (const m of played) {
    const h = row.get(m.home), a = row.get(m.away);
    if (!h || !a) continue;
    h.p++; a.p++;
    h.gf += m.homeGoals; h.ga += m.awayGoals;
    a.gf += m.awayGoals; a.ga += m.homeGoals;
    if (m.homeGoals > m.awayGoals) { h.w++; a.l++; h.pts += 3; }
    else if (m.homeGoals < m.awayGoals) { a.w++; h.l++; a.pts += 3; }
    else { h.d++; a.d++; h.pts++; a.pts++; }
  }
  const rows = [...row.values()];
  for (const r of rows) r.gd = r.gf - r.ga;
  rows.sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || y.team.strength - x.team.strength);
  rows.forEach((r, i) => { r.pos = i + 1; r.remaining = 3 - r.p; }); // 3 group games per team
  return rows;
}

// Deterministic top-2 clinch / elimination on points (conservative — see header).
//   clinchedTop2:   at most ONE other team can still reach this team's points floor
//                   → it finishes 1st or 2nd no matter what.
//   eliminatedTop2: at least TWO other teams already sit above this team's ceiling
//                   → it cannot finish in the top 2 (it may still chase a 3rd-place spot).
export function clinchFlags(rows) {
  const out = {};
  for (const t of rows) {
    const floor = t.pts;                 // worst case: lose every remaining match
    const ceil = t.pts + 3 * t.remaining; // best case: win every remaining match
    let canReachFloor = 0, sitAboveCeil = 0;
    for (const u of rows) {
      if (u === t) continue;
      if (u.pts + 3 * u.remaining >= floor) canReachFloor++; // u could finish at/above t's floor
      if (u.pts > ceil) sitAboveCeil++;                      // u is already guaranteed above t
    }
    out[t.name] = { clinchedTop2: canReachFloor <= 1, eliminatedTop2: sitAboveCeil >= 2 };
  }
  return out;
}
