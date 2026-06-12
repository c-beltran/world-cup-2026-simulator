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
import { esName } from './lib/teamNamesEs.js';

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

// ============================ Spanish (ES) narration ============================
// Native Spanish generation with a Latin/Spanish football-TV voice (¡GOOOOL!): the
// voice is exuberant, the CLAIMS stay exact. Same §7.3 contract + honesty guards as
// EN (ported to Spanish vocab). Writes takeEs/storylineEs ALONGSIDE the EN fields so
// build.js can bake {en,es}; the verified EN narration is never modified.

const ROUND_ES = { R32: 'Dieciseisavos de final', R16: 'Octavos de final', QF: 'Cuartos de final', SF: 'Semifinal', '3rd_place': 'Partido por el tercer puesto', final: 'Final' };
const RD_NEXT_ES = { R32: 'los octavos de final', R16: 'los cuartos de final', QF: 'la semifinal' };
const CEIL_ES = { 'Round of 32': 'los dieciseisavos de final', 'Round of 16': 'los octavos de final', 'Quarter-final': 'los cuartos de final', 'Semi-final': 'la semifinal', 'Final': 'la final' };

const SYSTEM_ES = `Eres un comentarista y redactor de televisión de fútbol de primer nivel, en español, generando color para un Mundial 2026 SIMULADO POR MONTE CARLO — UN universo simulado concreto, no un partido real ni una predicción. Se te entrega un único resultado de eliminatoria; nárralo con vibra de transmisión, vívido y exacto.

VOZ (televisión latina/española): energía de relato, cadencia de comentarista. Cuando menciones un gol, celébralo como en la tele — "¡GOOOOL!", "¡GOOOOOOL!", "¡golazo!" — pero SOLO de forma coherente con el marcador final exacto. La voz es exuberante; los HECHOS son exactos.

REGLAS DURAS (innegociables):
- Nunca cambies al ganador, al perdedor ni el marcador. Narra exactamente el resultado dado.
- Cualquier goleador, minuto o jugada que imagines es color para ESTE partido simulado. Si narras el desarrollo, DEBE sumar exactamente el marcador final para AMBOS equipos — nunca describas una secuencia que implique otro marcador (no lo llames empate o "1-1" cuando es 2-1, y da cuenta de cada gol del ganador). No nombres a futbolistas reales como goleadores.
- Solo conoces el marcador FINAL, nunca el orden ni el minuto de los goles. Si un relato gol a gol corriera el riesgo de no sumar exactamente, describe el carácter del partido (control, presión, resiliencia, una definición decisiva) coherente con el marcador. Puedes gritar "¡GOOOOL!" sin inventar quién ni cuándo.
- Usa los nombres de los equipos en español. NO afirmes hechos reales, lesiones, alineaciones, fichajes ni declaraciones como ciertos, y NO afirmes que un equipo ya ganó este ni ningún torneo ("su segundo título", "bicampeón", "campeón defensor").
- NO caracterices el estatus, la siembra, el ranking, la forma ni la reputación previa de ningún equipo con tus propias palabras. La ÚNICA referencia de rango permitida es el entero de puesto exacto impreso arriba, escrito como "#N" (p. ej. "el #1", "el #27"). Nunca uses las palabras sembrado/cabeza de serie, favorito(s), aspirante, tapado, gallito, cenicienta, comparsa, ranking, ni comparativos "mejor/peor clasificado/rankeado". No añadas adjetivos de estatus como "potencia", "gigante", "coloso", "clase mundial", "estrellas", "figuras", "galácticos", "prestigio", "jerarquía", "élite", "tradición" ni "calidad". Para transmitir que un equipo es más fuerte, apóyate SOLO en los enteros de puesto — un #1 contra #38 hace evidente la diferencia — y di quién ganó y el marcador exacto. Cualquier número que uses como rango DEBE ser uno de los puestos impresos arriba. Escribe "el #N" o "puesto #N", nunca "#N de la siembra".
- NO inventes estadio, ciudad ni país, y NO digas dónde se juega — el Mundial 2026 se disputa entre EE. UU., Canadá y México en sedes neutrales. Nunca insinúes que un equipo juega "de local" ni "en casa"; el modelo NO da ventaja de localía.
- Cíñete a ESTE partido y su contexto. No menciones otros partidos ni el resto del cuadro que no se te dio.
- Este es un resultado simulado — escríbelo como la historia de ese partido, no como predicción del torneo real.
- Tono: relato de TV enérgico pero medido — una mesa afilada, no un carrete de hype puro. 2-3 oraciones. Como mucho UNA imagen vívida por texto; no apiles adjetivos.

Devuelve SOLO JSON válido (sin bloques de código): {"winner": string, "homeGoals": number, "awayGoals": number, "take": string}. homeGoals/awayGoals DEBEN ser el resultado dado; devuelve "winner" con el nombre EN INGLÉS que se te indica (para la auto-verificación). El campo "take" va en español.`;

const SYSTEM_STORYLINE_ES = `Eres un redactor de fútbol de primer nivel, en español, narrando UN Mundial 2026 simulado por Monte Carlo — un único universo simulado, no una predicción. Escribe una crónica de 4-5 oraciones con vibra de transmisión latina/española: enérgica y con cadencia de relato, pero medida — una mesa afilada, no puro hype. Cuando menciones un gol puedes celebrarlo como en la tele ("¡GOOOOL!", "¡golazo!"), pero SOLO de forma coherente con los marcadores exactos. Como mucho una o dos imágenes figurativas en toda la pieza; recorta adjetivos morados y deja que los resultados lleven el drama. Evita palabras de hype como "sísmico" o "terremoto". Refiérete a cada partido solo por su ronda y marcador final — NO inventes secuencias de goles, remontadas ni desventajas (solo conoces el marcador final), ni totales como cuántos partidos jugó un equipo. No cambies ningún resultado dado. NO inventes estadios, ciudades ni países anfitriones, y nunca insinúes "de local" ni "en casa" (sedes neutrales; sin localía). NO caracterices el estatus, la siembra, el ranking, la forma ni la reputación previa con tus palabras; la ÚNICA referencia de rango permitida es el entero de puesto exacto suministrado (escrito "#N", p. ej. "el #27"). Nunca uses sembrado/cabeza de serie, favorito, aspirante, tapado, cenicienta, comparsa, ranking ni comparativos "mejor/peor clasificado", y nunca afirmes un título previo. Cualquier número usado como rango DEBE ser uno de los puestos suministrados. Di una vez, en palabras simples, que es un torneo de 48 equipos (p. ej. "puesto #27 de 48"). Esta es una historia simulada, enmarcada como tal. Usa nombres de equipos en español. Devuelve SOLO JSON: {"take": string}.`;

function matchPromptEs(m, story) {
  const H = esName(m.home.name), A = esName(m.away.name), Wn = esName(m.winner), St = esName(story);
  const decided =
    m.decidedBy === 'PENS'
      ? ` El partido terminó igualado ${m.homeGoals}-${m.awayGoals}; ${Wn} ganó la tanda de penales.`
      : m.decidedBy === 'ET'
        ? ' El ganador se definió en la prórroga.'
        : '';
  const hostNote = CO_HOSTS.has(story)
    ? ` Nota: ${St} es coanfitrión, y esta simulación NO da ventaja de localía a los anfitriones — su recorrido se gana puramente por el rating FIFA.`
    : '';
  const stake =
    m.round === 'final'
      ? ` EN JUEGO: es la FINAL — el ganador (${Wn}) se corona CAMPEÓN DEL MUNDO y levanta el trofeo. NO digas que "avanza" ni a una "siguiente ronda".`
      : m.round === 'SF'
        ? ` EN JUEGO: el ganador llega a la final; el perdedor queda eliminado.`
        : ` EN JUEGO: el ganador avanza a ${RD_NEXT_ES[m.round] || 'la siguiente ronda'}; el perdedor queda eliminado.`;
  return `${ROUND_ES[m.round]} (simulado).
Local: ${H} (puesto #${m.home.fieldRank}${CO_HOSTS.has(m.home.name) ? ', coanfitrión' : ''})
Visitante: ${A} (puesto #${m.away.fieldRank}${CO_HOSTS.has(m.away.name) ? ', coanfitrión' : ''})
Resultado EXACTO a narrar: ${H} ${m.homeGoals}-${m.awayGoals} ${A}.${decided} Ganador: ${Wn}.${stake}
Para la auto-verificación, devuelve el campo "winner" EXACTAMENTE como: ${m.winner}.
Contexto: esto es parte del recorrido de ${St} en este torneo simulado.${hostNote}
Escribe el texto en español.`;
}

async function matchTakeEs(m, story, strict = false) {
  const allowed = new Set([m.home.fieldRank, m.away.fieldRank]);
  const enW = m.winner, esW = esName(m.winner);
  let why = 'sin respuesta válida';
  for (const temperature of [0.85, 0.7, 0.55, 0.4, 0.3, 0.2]) {
    let obj;
    try {
      obj = parseJSON(await generate({ system: SYSTEM_ES, user: matchPromptEs(m, story), temperature }));
    } catch {
      why = 'error de parseo/API';
      continue;
    }
    const scoreOk =
      obj &&
      (obj.winner === enW || obj.winner === esW) && // accept EN canonical or ES name
      Number(obj.homeGoals) === m.homeGoals &&
      Number(obj.awayGoals) === m.awayGoals &&
      typeof obj.take === 'string' &&
      obj.take.length > 0;
    if (!scoreOk) { why = 'marcador/ganador no coincide'; continue; }
    const rv = rankViolation(obj.take, allowed, 'es');
    if (rv) { why = rv; continue; }
    if (strict) {
      const rep = reputationClaim(obj.take, 'es');
      if (rep) { why = `reputación/estatus "${rep}"`; continue; }
    }
    return { take: obj.take.trim(), verified: true };
  }
  return { take: null, verified: false, why };
}

function pathSummaryEs(path, story) {
  return path
    .map((m) => {
      const opp = m.home.name === story ? m.away : m.home;
      const gf = m.home.name === story ? m.homeGoals : m.awayGoals;
      const ga = m.home.name === story ? m.awayGoals : m.homeGoals;
      const res = m.winner === story
        ? `venció a ${esName(opp.name)} (puesto #${opp.fieldRank}) ${gf}-${ga}`
        : `perdió ante ${esName(opp.name)} (puesto #${opp.fieldRank}) ${gf}-${ga}`;
      const pens = m.decidedBy === 'PENS' ? ' en los penales' : m.decidedBy === 'ET' ? ' tras la prórroga' : '';
      return `${ROUND_ES[m.round]}: ${res}${pens}`;
    })
    .join('; ');
}

async function storylineEs(featured) {
  const story = featured.storyTeam;
  const path = featured.bracket.knockout.filter((m) => m.home.name === story || m.away.name === story);
  const summary = pathSummaryEs(path, story);
  const hostFrame = CO_HOSTS.has(story)
    ? `ENCUADRE HONESTO CLAVE para tejer con naturalidad: ${esName(story)} es coanfitrión, pero esta simulación NO da ventaja de localía a los anfitriones — cada equipo se juzga puramente por el rating FIFA — así que este recorrido se gana por mérito, no está fabricado para los anfitriones.`
    : '';
  const user = `Escribe la crónica del recorrido de ${esName(story)} (puesto #${rankOf(story)} de 48) en este torneo simulado.
Encuadre (respétalo; no reformules a un equipo de arriba como tapado ni viceversa): ${featured.angle}
Su camino ${featured.bracket.champion.name === story ? 'al título' : 'a una gran actuación'}: ${summary}.
${hostFrame}
Usa nombres de equipos en español. Devuelve SOLO JSON {"take": string}.`;
  const allowed = new Set();
  for (const m of path) { allowed.add(m.home.fieldRank); allowed.add(m.away.fieldRank); }
  for (const temperature of [0.8, 0.55, 0.35, 0.2]) {
    try {
      const obj = parseJSON(await generate({ system: SYSTEM_STORYLINE_ES, user, maxTokens: 700, temperature }));
      if (obj && typeof obj.take === 'string' && obj.take.length > 0 && !rankViolation(obj.take, allowed, 'es') && !reputationClaim(obj.take, 'es')) {
        return obj.take.trim();
      }
    } catch { /* retry */ }
  }
  return null;
}

async function nationStorylineEs(nation) {
  const story = nation.name, St = esName(story);
  const summary = pathSummaryEs(nation.path, story);
  const hostFrame = CO_HOSTS.has(story)
    ? `ENCUADRE HONESTO CLAVE para tejer con naturalidad: ${St} es coanfitrión, pero esta simulación NO da ventaja de localía a los anfitriones — cada equipo se juzga puramente por el rating FIFA — así que este recorrido se gana por mérito.`
    : '';
  const isChamp = nation.champion;
  const ceil = CEIL_ES[nation.ceilingRound] || nation.ceilingRound;
  const endClause = isChamp
    ? ''
    : ` CRUCIAL: ${St} NO ganó este torneo — su recorrido TERMINÓ con la eliminación en ${ceil}. Nunca afirmes ni insinúes que fue campeón, que se coronó, que levantó el trofeo o la copa, ni que ganó el Mundial; puedes decir que el recorrido terminó ahí o que se quedó corto. El último latido de su historia es una derrota, no un triunfo.`;
  const sys = `Eres un redactor de fútbol de primer nivel, en español, narrando UN Mundial 2026 simulado por Monte Carlo — un único universo simulado, no una predicción. Escribe una crónica de 4-5 oraciones con vibra de transmisión latina/española: enérgica y con cadencia de relato, pero medida — una mesa afilada, no puro hype. Cuando menciones un gol puedes celebrarlo como en la tele ("¡GOOOOL!", "¡golazo!"), pero SOLO coherente con los marcadores exactos. Como mucho una o dos imágenes figurativas; recorta adjetivos morados y deja que los resultados lleven el drama. Evita "sísmico" o "terremoto". Refiérete a cada partido solo por su ronda y marcador final — NO inventes secuencias de goles, remontadas ni desventajas (solo conoces el marcador final), ni totales como cuántos partidos jugó. No cambies ningún resultado. NO inventes estadios, ciudades ni países anfitriones, y nunca insinúes "de local" ni "en casa" (sedes neutrales; sin localía). NO caracterices estatus, siembra, ranking, forma ni reputación previa con tus palabras; la ÚNICA referencia de rango permitida es el entero de puesto exacto suministrado (escrito "#N", p. ej. "el #${nation.fieldRank}"). Nunca uses sembrado/cabeza de serie, favorito(s), aspirante, tapado, gallito, cenicienta, comparsa, ranking ni comparativos "mejor/peor clasificado/rankeado", y nunca afirmes un título previo. Cualquier número usado como rango DEBE ser uno de los puestos suministrados. Escribe "el #N" o "puesto #N", nunca "#N de la siembra". Explica cualquier diferencia competitiva SOLO mediante los puestos suministrados (que codifican el rating FIFA) — p. ej. "el #10 tenía ventaja sobre el #48". NO atribuyas resultados a reputación o estatus del mundo real, y NO uses palabras como élite, potencia, gigante, coloso, clase mundial, estrellas, figuras, cracks, galácticos, prestigio, jerarquía, tradición, recursos, experiencia ni "calidad"; esto es una simulación basada en rating, no un duelo de reputaciones. Deja que los enteros de puesto digan qué lado era más fuerte. Di una vez, en palabras simples, que es un cuadro de 48 (p. ej. "puesto #${nation.fieldRank} de 48").${endClause} Esta es una historia simulada, enmarcada como tal. Usa nombres de equipos en español. Devuelve SOLO JSON: {"take": string}.`;
  const framing = isChamp
    ? `Encuadre: ${St} gana el título en este universo simulado — narra el recorrido por sus méritos.`
    : `Encuadre: ${St} llega a ${ceil} en este universo simulado antes de quedar fuera — narra hasta dónde llegó, por sus méritos, SIN dar a entender que ganó el torneo.`;
  const runLine = isChamp ? 'Su camino al título' : `Su recorrido, que terminó con la eliminación en ${ceil}`;
  const user = `Escribe la crónica del recorrido de ${St} (puesto #${nation.fieldRank} de 48) en este torneo simulado.
${framing}
${runLine}: ${summary}.
${hostFrame}
Usa nombres de equipos en español. Devuelve SOLO JSON {"take": string}.`;
  const allowed = new Set();
  for (const m of nation.path) { allowed.add(m.home.fieldRank); allowed.add(m.away.fieldRank); }
  for (const temperature of [0.85, 0.7, 0.5, 0.35, 0.2]) {
    try {
      const obj = parseJSON(await generate({ system: sys, user, maxTokens: 700, temperature }));
      if (obj && typeof obj.take === 'string' && obj.take.length > 0) {
        if (rankViolation(obj.take, allowed, 'es')) continue;
        if (!isChamp && titleClaim(obj.take, 'es')) continue;
        if (reputationClaim(obj.take, 'es')) continue;
        return obj.take.trim();
      }
    } catch { /* retry */ }
  }
  return null;
}

async function narrateFeaturedEs(key, all) {
  const featured = sim.featured[key];
  if (!featured) { console.error(`Featured desconocido "${key}". Opciones: ${Object.keys(sim.featured).join(', ')}`); process.exit(1); }
  const story = featured.storyTeam;
  all.sims ||= {};
  const en = all.sims[key];
  if (!en || !en.matches) { console.error(`  [FLAG] "${key}" sin narración EN previa — corre el narrate EN primero`); return; }
  const path = featured.bracket.knockout.filter((m) => (m.home.name === story || m.away.name === story) && m.round !== '3rd_place');
  console.log(`\n[ES] Narrando "${key}" — recorrido de ${esName(story)} (${path.length} partidos) vía ${llmInfo().provider}/${llmInfo().model}`);
  let flagged = 0;
  for (const m of path) {
    const { take, verified, why } = await matchTakeEs(m, story);
    en.matches[m.id] ||= {};
    en.matches[m.id].takeEs = take;
    en.matches[m.id].verifiedEs = verified;
    if (!verified) flagged++;
    console.log(`  [${verified ? 'ok ' : 'FLAG'}] ${ROUND_ES[m.round]}: ${esName(m.home.name)} ${m.homeGoals}-${m.awayGoals} ${esName(m.away.name)}${verified ? '' : `  (${why})`}`);
  }
  const sl = await storylineEs(featured);
  if (!sl) { console.log('  [FLAG] crónica ES falló el guard tras reintentos'); flagged++; }
  en.storylineEs = sl;
  console.log(`\n${'='.repeat(70)}\nCRÓNICA — ${esName(story)}\n${'='.repeat(70)}\n${sl || '[SIN crónica]'}\n`);
  for (const m of path) { const t = en.matches[m.id]; console.log(`${'-'.repeat(70)}\n${ROUND_ES[m.round]} · ${esName(m.home.name)} ${m.homeGoals}-${m.awayGoals} ${esName(m.away.name)}\n${t.takeEs || '[MARCADO]'}`); }
  console.log(`\n${flagged === 0 ? 'Todos los textos ES verificados contra la simulación.' : `${flagged} texto(s) MARCADOS.`}`);
}

async function narrateNationEs(name, all) {
  const nation = sim.nations?.[name];
  if (!nation) { console.error(`  Selección desconocida "${name}"`); return 1; }
  all.nations ||= {};
  const en = all.nations[name];
  if (!en) { console.error(`  [FLAG] ${name}: sin narración EN previa — corre el narrate EN de naciones primero`); return 1; }
  if (nation.pinned) {
    const src = all.sims?.[nation.pinned];
    if (!src || !src.storylineEs) { console.error(`  [FLAG] ${name}: fuente pinned "${nation.pinned}" sin ES aún — narra ese featured en ES primero`); return 1; }
    en.storylineEs = src.storylineEs;
    for (const m of nation.path) if (src.matches?.[m.id]?.takeEs && en.matches?.[m.id]) {
      en.matches[m.id].takeEs = src.matches[m.id].takeEs;
      en.matches[m.id].verifiedEs = src.matches[m.id].verifiedEs ?? true; // carry the verification stamp
    }
    console.log(`  [pin ] ${name.padEnd(16)} ← ${nation.pinned} (ES reutilizado)`);
    return 0;
  }
  let flagged = 0;
  for (const m of nation.path) {
    const { take, verified, why } = await matchTakeEs(m, nation.name, true); // strict: rating-grounded
    en.matches ||= {};
    en.matches[m.id] ||= {};
    en.matches[m.id].takeEs = take;
    en.matches[m.id].verifiedEs = verified;
    if (!verified) { flagged++; console.log(`         [FLAG] ${name} ${m.id} ${ROUND_ES[m.round]}: ${why}`); }
  }
  const sl = await nationStorylineEs(nation);
  if (!sl) flagged++;
  en.storylineEs = sl;
  const tag = flagged === 0 ? 'ok  ' : 'FLAG';
  console.log(`  [${tag}] ${name.padEnd(16)} ${nation.ceilingRound.padEnd(13)} · ${nation.path.length} texto(s)${sl ? '' : ' · SIN crónica'}${flagged ? ` · ${flagged} marcados` : ''}`);
  return flagged;
}

// CLI:
//   npm run narrate -- all                                  full narrate (EN), every featured sim
//   npm run narrate -- chaos                                full narrate (EN), one sim
//   npm run narrate -- storyline modalChampion chalkFinal   refresh storylines only (keep takes)
//   npm run narrate -- nations Haiti "New Zealand"          narrate specific nation runs (Part B)
//   npm run narrate -- nations all                          narrate all 48 nation runs
//   npm run narrate -- --lang es chaos                      Spanish featured (adds takeEs/storylineEs)
//   npm run narrate -- --lang es nations all                Spanish nation runs
const rawArgs = process.argv.slice(2);
let LANG = 'en';
const li = rawArgs.indexOf('--lang');
if (li >= 0) { LANG = (rawArgs[li + 1] || 'en').toLowerCase(); rawArgs.splice(li, 2); }
const args = rawArgs;
const mode = args[0];

if (LANG === 'es') {
  // Spanish pass: attaches takeEs/storylineEs onto the EXISTING (EN) narration entries.
  const all = existsSync(NARRATION) ? JSON.parse(readFileSync(NARRATION, 'utf8')) : { generatedWith: llmInfo(), sims: {}, nations: {} };
  all.generatedWith = llmInfo();
  if (mode === 'nations') {
    const list = args.slice(1);
    const names = list.length === 0 || list[0] === 'all' ? Object.keys(sim.nations) : list;
    console.log(`\n[ES] Narrando ${names.length} selección(es) vía ${llmInfo().provider}/${llmInfo().model}`);
    let flags = 0;
    for (const nm of names) {
      flags += await narrateNationEs(nm, all);
      writeFileSync(NARRATION, JSON.stringify(all, null, 2) + '\n'); // checkpoint — resumable
    }
    console.log(`\n${flags === 0 ? 'Todas las selecciones ES verificadas.' : `${flags} marca(s) — esas entradas no llevan texto/crónica ES.`}`);
    console.log(`Wrote ${NARRATION}\n`);
  } else {
    const keys = args.length === 0 || args[0] === 'all' ? Object.keys(sim.featured) : args;
    for (const k of keys) {
      await narrateFeaturedEs(k, all);
      writeFileSync(NARRATION, JSON.stringify(all, null, 2) + '\n');
    }
    console.log(`Wrote ${NARRATION}\n`);
  }
} else if (mode === 'nations') {
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
