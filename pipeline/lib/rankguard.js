// Rank/seed honesty guard — shared by narrate.js (reject-on-generate) and
// verify.js (independent QA re-scan).
//
// The narration may reference rank ONLY via the exact field-rank integers we
// supply. (1) Pre-tournament status vocabulary is forbidden outright. (2) Any
// number used in a rank context (digit or spelled-out ordinal) must be one of
// the supplied field ranks — so the model can't invent a seeding that contradicts
// the data (e.g. calling #1 France a "second seed"). Same hard-fail as the score
// guard. Scores ("1-0") and minutes never match: every pattern needs #/field/
// ranked/seed context.

export const BANNED_RANK_WORDS =
  /\b(seeds?|seeded|seeding|favou?ri(?:te|tes|ng)|favou?red|under-?dogs?|(?:top|higher|lower|highest|lowest|best|worst|better|worse|stronger|weaker|strongest|weakest)[- ]ranked|rankings?|dark[- ]?horses?|minnows?)\b/i;

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

// Every number the text uses as a rank (digit or spelled-out ordinal).
export function rankClaims(text) {
  const nums = [];
  for (const mm of text.matchAll(/\b(?:field\s*)?#\s*(\d{1,2})\b/gi)) nums.push(Number(mm[1]));
  for (const mm of text.matchAll(/\bfield\s+(\d{1,2})\b/gi)) nums.push(Number(mm[1]));
  for (const mm of text.matchAll(/\branked\s*#?\s*(\d{1,2})(?:st|nd|rd|th)?\b/gi)) nums.push(Number(mm[1]));
  for (const mm of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)[- ]ranked\b/gi)) nums.push(Number(mm[1]));
  const ord = Object.keys(ORDINALS).join('|');
  const re = new RegExp(`\\b(${ord})[- ](?:seed|seeded|ranked)\\b|\\branked\\s+(${ord})\\b`, 'gi');
  for (const mm of text.matchAll(re)) nums.push(ORDINALS[(mm[1] || mm[2]).toLowerCase()]);
  return nums;
}

// Returns null if clean, else a short reason. `allowed` = Set of field ranks the
// model was given for this take (both teams) or storyline (the whole path).
export function rankViolation(text, allowed) {
  if (typeof text !== 'string' || !text.length) return 'empty take';
  if (BANNED_RANK_WORDS.test(text)) return 'banned rank/status word';
  // invented match-count totals (e.g. "across seven matches") — the model isn't told
  // how many games a team played, so any such count is fabricated.
  if (/\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-](?:matches|games|fixtures)\b/i.test(text)) {
    return 'invented match-count total';
  }
  for (const n of rankClaims(text)) {
    if (!allowed.has(n)) return `rank #${n} not in supplied field ranks {${[...allowed].sort((a, b) => a - b).join(',')}}`;
  }
  return null;
}

// Blatant championship assertions — used ONLY for non-champion runs (a team whose
// best run ended in elimination). The match-take score guard already stops the
// elimination take from claiming a win; this stops a STORYLINE from fabricating a
// trophy the team never lifted. Honest "fell short of the title / the title eluded
// them" phrasing is intentionally NOT matched.
const TITLE_CLAIM =
  /\b(?:crowned|world\s+champions?|champions?\s+of\s+the\s+world|world\s+cup\s+(?:winners?|champions?))\b|\b(?:lift(?:ed|s|ing)?|hoist(?:ed|s|ing)?|rais(?:ed|es|ing)?|claim(?:ed|s|ing)?)\s+the\s+(?:trophy|cup|title|crown)\b|\bwon\s+(?:the\s+)?(?:world\s+cup|tournament|title|trophy|it\s+all)\b/i;

// Returns the offending phrase if the text asserts a championship, else null.
export function titleClaim(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(TITLE_CLAIM);
  return m ? m[0] : null;
}

// Real-world reputation/status framing that is NOT grounded in the supplied field
// rating. The model may explain a gap via the field-rank integers (which encode the
// FIFA rating) — "the #10 side edged the #48 side" — but NOT via reputation, pedigree,
// resources, history, or "class". Strict, rating-grounded honesty for the per-nation runs.
const REPUTATION_WORDS =
  /\b(pedigreed?|powerhouses?|heavyweights?|juggernauts?|elite|world[- ]?class|star[- ]?studded|superstars?|gala?cticos?|storied|vaunted|illustrious|fancied|prestigious|prestige|aristocrac\w*|household names?|deeper resources|resources|reputations?|highest level)\b/i;

// Returns the offending reputation phrase if present, else null.
export function reputationClaim(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(REPUTATION_WORDS);
  return m ? m[0] : null;
}
