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

// Deterministic top-2 clinch / elimination, FIXTURE-AWARE (conservative — see header).
// We enumerate every win/draw/loss completion of the remaining group games and apply
// provably-correct, goal-difference-agnostic rules:
//   clinchedTop2:   in EVERY completion, at most ONE other team finishes with points
//                   >= this team's → it is 1st or 2nd no matter the scorelines. (A points
//                   TIE is treated as unsafe: GD could break it either way.)
//   eliminatedTop2: in EVERY completion, at least TWO other teams finish STRICTLY above
//                   → it cannot reach the top 2 (it may still chase a 3rd-place spot).
// Counting rivals independently (points floor/ceiling alone) over-estimates how many can
// catch a team when those rivals must still play EACH OTHER — two chasers in the same
// remaining fixture can't both win. Enumerating the real fixtures fixes that.
//   rows:      group table rows (need .name, .pts).
//   remaining: unplayed group games among these teams, as [{ home, away }] (names).
export function clinchFlags(rows, remaining = []) {
  const base = Object.fromEntries(rows.map((r) => [r.name, r.pts]));
  const completions = [];
  for (let mask = 0; mask < 3 ** remaining.length; mask++) {
    const pts = { ...base };
    let m = mask;
    for (const g of remaining) {
      const o = m % 3; m = (m - o) / 3;
      if (o === 0) pts[g.home] += 3;                            // home win
      else if (o === 1) { pts[g.home] += 1; pts[g.away] += 1; } // draw
      else pts[g.away] += 3;                                    // away win
    }
    completions.push(pts);
  }
  const out = {};
  for (const t of rows) {
    let clinched = true, eliminated = true;
    for (const pts of completions) {
      const tp = pts[t.name];
      let geq = 0, above = 0;
      for (const u of rows) {
        if (u.name === t.name) continue;
        if (pts[u.name] >= tp) geq++;
        if (pts[u.name] > tp) above++;
      }
      if (geq >= 2) clinched = false;    // some completion lets 2+ teams reach/pass t
      if (above < 2) eliminated = false; // some completion keeps t within top-2 reach
    }
    out[t.name] = { clinchedTop2: clinched, eliminatedTop2: eliminated };
  }
  return out;
}
