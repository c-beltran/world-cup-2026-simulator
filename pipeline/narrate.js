// Stage 3/4 — AI narration (offline, pre-baked).
// For a featured sim, generates per-knockout-match takes along the story team's
// path + a tournament storyline, under the §7.3 prompt contract:
//   input  = real teams + the sim's ACTUAL result + context (field ranks, round)
//   rule   = narrate ONLY this outcome; never change the winner or score
//   output = tight broadcast prose, keyed to match IDs
//
// Honesty guard: every match take must echo back winner + exact score; we verify
// that against the sim and retry/flag on mismatch. The model cannot ship a take
// that changes the result.
//
//   npm run narrate            # default: the Cinderella sim
//   npm run narrate -- chaos   # or modalChampion | chalkFinal | chaos | all

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { generate, llmInfo } from './lib/llm.js';
import { rankViolation, titleClaim, reputationClaim } from './lib/rankguard.js';

const OUT = join(import.meta.dirname, 'out');
const RESULTS = join(OUT, 'sim-results.json');
const NARRATION = join(OUT, 'narration.json');
const sim = JSON.parse(readFileSync(RESULTS, 'utf8'));

const ROUND = {
  R32: 'Round of 32',
  R16: 'Round of 16',
  QF: 'Quarter-final',
  SF: 'Semi-final',
  '3rd_place': 'Third-place play-off',
  final: 'Final',
};
const CO_HOSTS = new Set(['Canada', 'Mexico', 'United States']);
const seed = (name) => `field #${sim.featured ? rankOf(name) : '?'}`;
function rankOf(name) {
  for (const key of Object.keys(sim.featured)) {
    for (const m of sim.featured[key].bracket.knockout) {
      if (m.home.name === name) return m.home.fieldRank;
      if (m.away.name === name) return m.away.fieldRank;
    }
  }
  return '?';
}

const SYSTEM = `You are a world-class football broadcast writer producing colour for a MONTE CARLO-SIMULATED World Cup 2026 — ONE specific simulated universe, not a real or predicted match. You are handed a single knockout result a statistical simulation produced; narrate THAT result vividly and accurately.

HARD RULES (non-negotiable):
- Never change the winner, the loser, or the score. Narrate exactly the result you are given.
- Any goalscorer, minute, or moment you invent is imagined flavour for THIS simulated game. If you narrate the run of play, it MUST add up to the exact final score for BOTH teams — never describe a sequence that implies a different score (e.g. do not call the game level or "1-1" when the result is 2-1, and account for every goal the winner scored). Do not name real players as having scored.
- You know only the FINAL score, never the order or timing of goals. If a goal-by-goal account would risk not summing exactly to that score, describe the match's character (control, pressure, resilience, a decisive finish) consistent with the score rather than enumerating a goal sequence.
- Use team names. Do NOT assert real-world facts, injuries, line-ups, transfers, or quotes as literally true, and do NOT claim a team has previously won this or any tournament ("their second title", "back-to-back", "defending champions").
- Do NOT characterize any team's pre-tournament status, seeding, ranking, form, or reputation in your own words. The ONLY rank reference allowed is the exact field-rank integer printed above, written as "#N" (e.g. "the #1 side", "field #27"). Never use the words seed/seeded/seeding, favourite(s)/favorite(s)/favoured/favored, underdog, dark horse, minnow, ranking, or ANY "X-ranked" comparative (top-/higher-/lower-/highest-/lowest-/best-/worst-/stronger-/weaker-/strongest-/weakest-ranked). Do NOT add status adjectives such as "the highest-ranked side", "the favourites", "the top side", "elite", "powerhouse", "heavyweight", "world-class", "storied", "pedigree", or "quality". To convey that one side is stronger, rely ONLY on the rank integers — a #1 vs #38 matchup makes the gap obvious — and state who won and the exact score; let the numbers carry it. Any number you use as a rank MUST be one of the field ranks printed above. Write "the #N side" or "field #N", never "#N seed", "the N seed", or "Nth seed".
- Do NOT invent a stadium, city, or country for the match, and do NOT say where it is played — World Cup 2026 is hosted across the USA, Canada and Mexico at neutral venues. Never imply any team plays "at home" or on "home soil"; the model gives NO home advantage.
- Stick to THIS match and its stakes. Do not reference other fixtures, other semi-finalists, or the wider bracket you were not given (no claims about who else is a host, who else advanced, etc.).
- This is one simulated outcome — write it as a story of that game, not a prediction of the real tournament.
- Tone: restrained, confident match-writing — a sharp broadcast desk, NOT a hype reel. 2-3 sentences. At most ONE vivid image per take; no piled-up adjectives (avoid words like "seismic", "fever dream", "pendulum", "earthquake", "shockwaves"). Let the result carry the drama — don't strain on top of it.

Return ONLY valid JSON (no markdown fences): {"winner": string, "homeGoals": number, "awayGoals": number, "take": string}. winner/homeGoals/awayGoals MUST equal the result you were given — this is a self-check.`;

function matchPrompt(m, story) {
  const decided =
    m.decidedBy === 'PENS'
      ? ` The game finished level at ${m.homeGoals}-${m.awayGoals}; ${m.winner} won the penalty shootout.`
      : m.decidedBy === 'ET'
        ? ' The winner was settled in extra time.'
        : '';
  const hostNote = CO_HOSTS.has(story)
    ? ` Note: ${story} are a co-host, and this simulation gives hosts NO home-field advantage — so their run is earned purely on FIFA rating.`
    : '';
  const stake =
    m.round === 'final'
      ? ` STAKES: this is the FINAL — the winner (${m.winner}) is crowned WORLD CHAMPION and lifts the trophy. Do NOT say they "advance" or reach a "next round".`
      : m.round === 'SF'
        ? ` STAKES: the winner reaches the final; the loser is out.`
        : ` STAKES: the winner advances to the ${ROUND[{ R32: 'R16', R16: 'QF', QF: 'SF' }[m.round]] || 'next round'}; the loser is eliminated.`;
  return `Simulated ${ROUND[m.round]}.
Home: ${m.home.name} (field #${m.home.fieldRank}${CO_HOSTS.has(m.home.name) ? ', co-host' : ''})
Away: ${m.away.name} (field #${m.away.fieldRank}${CO_HOSTS.has(m.away.name) ? ', co-host' : ''})
EXACT result to narrate: ${m.home.name} ${m.homeGoals}-${m.awayGoals} ${m.away.name}.${decided} Winner: ${m.winner}.${stake}
Context: this is part of ${story}'s run in this simulated tournament.${hostNote}
Write the take.`;
}

function parseJSON(s) {
  let t = s.trim();
  if (t.startsWith('```')) t = t.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

async function matchTake(m, story, strict = false) {
  const allowed = new Set([m.home.fieldRank, m.away.fieldRank]);
  let why = 'no valid response';
  for (const temperature of [0.85, 0.7, 0.55, 0.4, 0.3, 0.2]) {
    let obj;
    try {
      obj = parseJSON(await generate({ system: SYSTEM, user: matchPrompt(m, story), temperature }));
    } catch {
      why = 'parse/API error';
      continue; // parse/API hiccup — retry
    }
    const scoreOk =
      obj &&
      obj.winner === m.winner &&
      Number(obj.homeGoals) === m.homeGoals &&
      Number(obj.awayGoals) === m.awayGoals &&
      typeof obj.take === 'string' &&
      obj.take.length > 0;
    if (!scoreOk) {
      why = 'winner/score mismatch';
      continue;
    }
    const rv = rankViolation(obj.take, allowed); // reject invented seedings — same hard-fail as score
    if (rv) {
      why = rv;
      continue;
    }
    if (strict) {
      const rep = reputationClaim(obj.take); // per-nation runs: rating-grounded only
      if (rep) { why = `reputation/status claim "${rep}"`; continue; }
    }
    return { take: obj.take.trim(), verified: true };
  }
  return { take: null, verified: false, why }; // flagged — never silently ship a drifted take
}

async function storyline(featured) {
  const story = featured.storyTeam;
  const path = featured.bracket.knockout.filter((m) => m.home.name === story || m.away.name === story);
  const summary = path
    .map((m) => {
      const opp = m.home.name === story ? m.away : m.home;
      const gf = m.home.name === story ? m.homeGoals : m.awayGoals;
      const ga = m.home.name === story ? m.awayGoals : m.homeGoals;
      const res = m.winner === story ? `beat ${opp.name} (field #${opp.fieldRank}) ${gf}-${ga}` : `lost to ${opp.name} ${gf}-${ga}`;
      const pens = m.decidedBy === 'PENS' ? ' on penalties' : m.decidedBy === 'ET' ? ' after extra time' : '';
      return `${ROUND[m.round]}: ${res}${pens}`;
    })
    .join('; ');
  const hostFrame = CO_HOSTS.has(story)
    ? `CRUCIAL HONEST FRAMING to weave in naturally: ${story} are a co-host, but this simulation gives the hosts NO home-field advantage — every team is judged purely on FIFA rating — so this run is earned on merit, not engineered for the hosts.`
    : '';
  const sys = `You are a world-class football writer narrating ONE Monte Carlo-simulated World Cup 2026 — a single simulated universe, not a prediction. Write a restrained, confident 4-5 sentence storyline — a sharp broadcast desk, not a hype reel. At most one or two figurative images in the whole piece; trim purple adjectives and let the results carry the drama. Avoid hype words like "seismic", "earthquake", "shockwaves". Refer to each match only by its round and final score — do NOT invent intra-match goal sequences, comebacks, or deficits (you know only the final scores, not the order goals were scored), and do NOT invent numeric totals such as how many matches a team has played. Do not change any result you are given. Do NOT invent stadiums, cities or host countries, and never imply a team plays "at home" or on "home soil" (neutral venues; no home advantage). Do NOT characterize any team's pre-tournament status, seeding, ranking, form, or reputation in your own words; the ONLY rank reference allowed is the exact field-rank integer supplied (written as "#N", e.g. "the #27 side"). Never use the words seed/seeded/seeding, favourite/favorite/favoured/favored, underdog, top-ranked/higher-ranked/lower-ranked, dark horse, ranking, or minnow, and never claim a prior title. Any number used as a rank MUST be one of the field ranks supplied. State once, in plain words, that this is a 48-team field (e.g. "field #27 of 48", or "the #27 side in a 48-team field") so a casual reader grasps the scale of the run. This is a simulated story, framed as such. Return ONLY JSON: {"take": string}.`;
  const user = `Write the storyline for ${story}'s run (field #${rankOf(story)} of 48) in this simulated tournament.
Framing for this run (match it; do not reframe a top side as an underdog or vice-versa): ${featured.angle}
Their path to ${featured.bracket.champion.name === story ? 'the title' : 'a deep run'}: ${summary}.
${hostFrame}
Return ONLY JSON {"take": string}.`;
  const allowed = new Set();
  for (const m of path) {
    allowed.add(m.home.fieldRank);
    allowed.add(m.away.fieldRank);
  }
  const temps = [0.8, 0.4, 0.2]; // ladder down: lower temp = less training-prior editorializing
  for (const temperature of temps) {
    try {
      const obj = parseJSON(await generate({ system: sys, user, maxTokens: 700, temperature }));
      if (obj && typeof obj.take === 'string' && obj.take.length > 0 && !rankViolation(obj.take, allowed)) return obj.take.trim();
    } catch {
      /* retry */
    }
  }
  return null; // flagged — storyline failed the rank/seed guard, ship none
}

// ---- Pick-Your-Nation narration (Stage 3/4, Part B) ----
// Same contract as the featured runs: narrate the sim's ACTUAL result, never invent one.
// For NON-champion runs the last match is a defeat (their elimination) — the score guard
// already forbids the elimination take from claiming a win, and titleClaim() blocks a
// storyline from fabricating a trophy the team never lifted.
async function nationStoryline(nation) {
  const story = nation.name;
  const path = nation.path;
  const summary = path
    .map((m) => {
      const opp = m.home.name === story ? m.away : m.home;
      const gf = m.home.name === story ? m.homeGoals : m.awayGoals;
      const ga = m.home.name === story ? m.awayGoals : m.homeGoals;
      const res = m.winner === story ? `beat ${opp.name} (field #${opp.fieldRank}) ${gf}-${ga}` : `lost to ${opp.name} (field #${opp.fieldRank}) ${gf}-${ga}`;
      const pens = m.decidedBy === 'PENS' ? ' on penalties' : m.decidedBy === 'ET' ? ' after extra time' : '';
      return `${ROUND[m.round]}: ${res}${pens}`;
    })
    .join('; ');
  const hostFrame = CO_HOSTS.has(story)
    ? `CRUCIAL HONEST FRAMING to weave in naturally: ${story} are a co-host, but this simulation gives the hosts NO home-field advantage — every team is judged purely on FIFA rating — so this run is earned on merit, not engineered for the hosts.`
    : '';
  const isChamp = nation.champion;
  const endClause = isChamp
    ? ''
    : ` CRUCIAL: ${story} did NOT win this tournament — their run ENDED with elimination in the ${nation.ceilingRound}. Never state or imply they were champions, were crowned, lifted the trophy or cup, or won the World Cup; you may say the run ended there or fell short. The last beat of their story is a defeat, not a triumph.`;
  const sys = `You are a world-class football writer narrating ONE Monte Carlo-simulated World Cup 2026 — a single simulated universe, not a prediction. Write a restrained, confident 4-5 sentence storyline — a sharp broadcast desk, not a hype reel. At most one or two figurative images in the whole piece; trim purple adjectives and let the results carry the drama. Avoid hype words like "seismic", "earthquake", "shockwaves". Refer to each match only by its round and final score — do NOT invent intra-match goal sequences, comebacks, or deficits (you know only the final scores, not the order goals were scored), and do NOT invent numeric totals such as how many matches a team has played. Do not change any result you are given. Do NOT invent stadiums, cities or host countries, and never imply a team plays "at home" or on "home soil" (neutral venues; no home advantage). Do NOT characterize any team's pre-tournament status, seeding, ranking, form, or reputation in your own words; the ONLY rank reference allowed is the exact field-rank integer supplied (written as "#N", e.g. "the #${nation.fieldRank} side"). Never use the words seed/seeded/seeding, favourite(s)/favorite(s)/favoured/favored, underdog, dark horse, minnow, ranking, or ANY "X-ranked" comparative (top-/higher-/lower-/highest-/lowest-/best-/worst-/stronger-/weaker-/strongest-/weakest-ranked), and never claim a prior title. Any number used as a rank MUST be one of the field ranks supplied. Write "the #N side" or "field #N", never "#N seed" or "Nth seed". Explain any competitive gap ONLY through the supplied field ranks (which encode the FIFA rating) — e.g. "the #10 side had the edge over the #48 side". Do NOT attribute outcomes to real-world reputation or status, and do NOT use words like elite, powerhouse, heavyweight, world-class, storied, vaunted, illustrious, fancied, pedigree, resources, experience, history, star players, "class", or "quality"; this is a rating-driven simulation, not a contest of reputations. Let the rank integers carry which side was stronger. State once, in plain words, that this is a 48-team field (e.g. "field #${nation.fieldRank} of 48", or "the #${nation.fieldRank} side in a 48-team field") so a casual reader grasps the scale of the run.${endClause} This is a simulated story, framed as such. Return ONLY JSON: {"take": string}.`;
  const runLine = isChamp ? `Their path to the title` : `Their run, which ended with elimination in the ${nation.ceilingRound}`;
  const framing = isChamp
    ? `Framing: ${story} win the title in this simulated universe — narrate the run on its merits.`
    : `Framing: ${story} reach the ${nation.ceilingRound} in this simulated universe before going out — narrate how far this run went, on its merits, WITHOUT implying they won the tournament.`;
  const user = `Write the storyline for ${story}'s run (field #${nation.fieldRank} of 48) in this simulated tournament.
${framing}
${runLine}: ${summary}.
${hostFrame}
Return ONLY JSON {"take": string}.`;
  const allowed = new Set();
  for (const m of path) { allowed.add(m.home.fieldRank); allowed.add(m.away.fieldRank); }
  // storyline guard is stricter than the per-match score guard (whole-prose rank/title scan);
  // give it a longer temperature ladder so a clean generation is reliably found.
  for (const temperature of [0.85, 0.7, 0.5, 0.35, 0.2]) {
    try {
      const obj = parseJSON(await generate({ system: sys, user, maxTokens: 700, temperature }));
      if (obj && typeof obj.take === 'string' && obj.take.length > 0) {
        if (rankViolation(obj.take, allowed)) continue;
        if (!isChamp && titleClaim(obj.take)) continue; // no fabricated trophy
        if (reputationClaim(obj.take)) continue; // rating-grounded only — no reputation/pedigree/class
        return obj.take.trim();
      }
    } catch {
      /* retry */
    }
  }
  return null; // flagged — failed the guard after retries, ship none
}

async function narrateNation(name, all) {
  const nation = sim.nations?.[name];
  if (!nation) { console.error(`  Unknown nation "${name}"`); return 1; }
  const story = nation.name;
  all.nations ||= {};

  // Pinned featured teams (France→modal, Canada→Cinderella): reuse the already-verified
  // featured takes + storyline so the dropdown entry matches the surfaced tab exactly.
  if (nation.pinned) {
    const src = all.sims?.[nation.pinned];
    if (!src || !src.matches) { console.error(`  [FLAG] ${name}: pinned source "${nation.pinned}" not narrated yet — run featured first`); return 1; }
    const matches = {};
    for (const m of nation.path) if (src.matches[m.id]) matches[m.id] = { ...src.matches[m.id] };
    all.nations[name] = { name, fieldRank: nation.fieldRank, simIndex: nation.simIndex, pinned: nation.pinned, ceiling: nation.ceiling, champion: nation.champion, storyline: src.storyline, matches };
    console.log(`  [pin ] ${name.padEnd(16)} ← ${nation.pinned} (sim #${nation.simIndex}) · reused ${Object.keys(matches).length} takes + storyline`);
    return 0;
  }

  const matches = {};
  let flagged = 0;
  for (const m of nation.path) {
    const { take, verified, why } = await matchTake(m, story, true); // strict: rating-grounded, no reputation framing
    matches[m.id] = { round: m.round, home: m.home.name, away: m.away.name, score: `${m.homeGoals}-${m.awayGoals}`, winner: m.winner, decidedBy: m.decidedBy, take, verified };
    if (!verified) { flagged++; console.log(`         [FLAG] ${name} ${m.id} ${ROUND[m.round]}: ${why}`); }
  }
  const story_text = await nationStoryline(nation);
  if (!story_text) flagged++;
  all.nations[name] = { name, fieldRank: nation.fieldRank, simIndex: nation.simIndex, pinned: null, ceiling: nation.ceiling, champion: nation.champion, storyline: story_text, matches };
  const tag = flagged === 0 ? 'ok  ' : 'FLAG';
  console.log(`  [${tag}] ${name.padEnd(16)} ${nation.ceilingRound.padEnd(13)} sim #${String(nation.simIndex).padStart(5)} · ${nation.path.length} take(s)${story_text ? '' : ' · NO storyline'}${flagged ? ` · ${flagged} flagged` : ''}`);
  return flagged;
}

async function narrateFeatured(key, { storylineOnly = false } = {}) {
  const featured = sim.featured[key];
  if (!featured) {
    console.error(`Unknown featured sim "${key}". Options: ${Object.keys(sim.featured).join(', ')}`);
    process.exit(1);
  }
  const story = featured.storyTeam;

  // Storyline-only: refresh just the storyline (e.g. to add the field-size phrase),
  // keeping the already-verified match takes untouched.
  if (storylineOnly) {
    const all = existsSync(NARRATION) ? JSON.parse(readFileSync(NARRATION, 'utf8')) : { generatedWith: llmInfo(), sims: {} };
    const existing = all.sims[key];
    if (!existing || !existing.matches) {
      console.error(`storyline-only: "${key}" has no existing takes to keep — run a full narrate first.`);
      process.exit(1);
    }
    console.log(`\nStoryline-only re-narrate "${key}" — ${story} (sim #${featured.simIndex})`);
    const story_text = await storyline(featured);
    if (!story_text) console.log(`  [FLAG] storyline failed the rank/seed guard after retries — keeping the previous storyline`);
    all.generatedWith = llmInfo();
    all.sims[key] = { ...existing, storyline: story_text || existing.storyline };
    writeFileSync(NARRATION, JSON.stringify(all, null, 2) + '\n');
    console.log(`\n${'='.repeat(70)}\nSTORYLINE — ${story}\n${'='.repeat(70)}\n${all.sims[key].storyline}\n`);
    console.log(`Wrote ${NARRATION}\n`);
    return;
  }
  const path = featured.bracket.knockout.filter(
    (m) => (m.home.name === story || m.away.name === story) && m.round !== '3rd_place',
  );
  console.log(`\nNarrating "${key}" — ${story}'s ${path.length}-match path (sim #${featured.simIndex}) via ${llmInfo().provider}/${llmInfo().model}`);

  const matches = {};
  let flagged = 0;
  for (const m of path) {
    const { take, verified, why } = await matchTake(m, story);
    matches[m.id] = { round: m.round, home: m.home.name, away: m.away.name, score: `${m.homeGoals}-${m.awayGoals}`, winner: m.winner, decidedBy: m.decidedBy, take, verified };
    if (!verified) flagged++;
    const tag = verified ? 'ok ' : 'FLAG';
    console.log(`  [${tag}] ${ROUND[m.round]}: ${m.home.name} ${m.homeGoals}-${m.awayGoals} ${m.away.name}${verified ? '' : `  (${why})`}`);
  }
  const story_text = await storyline(featured);
  if (!story_text) {
    console.log(`  [FLAG] storyline failed the rank/seed guard after retries — shipping no storyline`);
    flagged++;
  }

  const all = existsSync(NARRATION) ? JSON.parse(readFileSync(NARRATION, 'utf8')) : { generatedWith: llmInfo(), sims: {} };
  all.generatedWith = llmInfo();
  all.sims[key] = { storyTeam: story, simIndex: featured.simIndex, angle: featured.angle, storyline: story_text, matches };
  writeFileSync(NARRATION, JSON.stringify(all, null, 2) + '\n');

  // --- show the samples ---
  console.log(`\n${'='.repeat(70)}\nSTORYLINE — ${story}\n${'='.repeat(70)}\n${story_text}\n`);
  for (const m of path) {
    const t = matches[m.id];
    console.log(`${'-'.repeat(70)}\n${ROUND[m.round]} · ${m.home.name} ${m.homeGoals}-${m.awayGoals} ${m.away.name}${m.decidedBy !== 'REG' ? ` (${m.decidedBy})` : ''} · winner ${m.winner}`);
    console.log(t.take || '  [FLAGGED — verification failed, not shipping]');
  }
  console.log(`\n${flagged === 0 ? 'All takes verified against the sim result.' : `${flagged} take(s) FLAGGED — winner/score mismatch, not shipped.`}`);
  console.log(`Wrote ${NARRATION}\n`);
}

// CLI:
//   npm run narrate -- all                                  full narrate, every featured sim
//   npm run narrate -- chaos                                full narrate, one sim
//   npm run narrate -- storyline modalChampion chalkFinal   refresh storylines only (keep takes)
//   npm run narrate -- nations Haiti "New Zealand"          narrate specific nation runs (Part B)
//   npm run narrate -- nations all                          narrate all 48 nation runs
const args = process.argv.slice(2);
const mode = args[0];

if (mode === 'nations') {
  const all = existsSync(NARRATION) ? JSON.parse(readFileSync(NARRATION, 'utf8')) : { generatedWith: llmInfo(), sims: {} };
  all.generatedWith = llmInfo();
  all.nations ||= {};
  const list = args.slice(1);
  const names = list.length === 0 || list[0] === 'all' ? Object.keys(sim.nations) : list;
  console.log(`\nNarrating ${names.length} nation run(s) via ${llmInfo().provider}/${llmInfo().model}`);
  let flags = 0;
  for (const nm of names) {
    flags += await narrateNation(nm, all);
    writeFileSync(NARRATION, JSON.stringify(all, null, 2) + '\n'); // checkpoint after each — resumable
  }
  console.log(`\n${flags === 0 ? 'All nation runs verified against the sim result.' : `${flags} flag(s) — see above; those entries shipped no take/storyline.`}`);
  console.log(`Wrote ${NARRATION}\n`);
} else {
  const storylineOnly = mode === 'storyline';
  const list = storylineOnly ? args.slice(1) : args;
  const keys = list.length === 0 || list[0] === 'all' ? Object.keys(sim.featured) : list;
  for (const k of keys) await narrateFeatured(k, { storylineOnly });
}
