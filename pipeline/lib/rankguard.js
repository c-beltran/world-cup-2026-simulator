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
//
// Every exported guard takes an optional `lang` ('en' default | 'es'). The English
// path is unchanged; the Spanish path applies the same structural rules with
// football-TV vocabulary. The STRUCTURAL guarantees (exact score/winner, ranks only
// via supplied #N integers, no fabricated title) are language-independent; the
// seed/reputation WORD LISTS are the dialect-sensitive part, reviewed by a native
// speaker at the sample gate.

export const BANNED_RANK_WORDS =
  /\b(seeds?|seeded|seeding|favou?ri(?:te|tes|ng)|favou?red|under-?dogs?|(?:top|higher|lower|highest|lowest|best|worst|better|worse|stronger|weaker|strongest|weakest)[- ]ranked|rankings?|dark[- ]?horses?|minnows?)\b/i;

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

// ---- Spanish (ES) variants. Unicode-aware boundaries via lookaround so accented
// words match as whole words and "gigantesco" does NOT trip "gigante", etc. ----
const W = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ';
const esWord = (alts) => new RegExp(`(?<![${W}])(?:${alts})(?![${W}])`, 'i');

// Seed/status + comparative-rank vocabulary forbidden outright (the ES analogue of
// seed/favourite/underdog/"X-ranked"). "clasificado" alone is NOT banned (it means
// "qualified"); only the comparative "mejor/peor/más/menos clasificado" is.
export const BANNED_RANK_WORDS_ES = esWord(
  'sembrad[oa]s?|cabezas?\\s+de\\s+serie|favorit[oa]s?|favoritismo|aspirantes?|tapad[oa]s?|gallitos?|cenicientas?|comparsas?|outsiders?|(?:mejor(?:es)?|peor(?:es)?|más|mas|menos)[ -](?:clasificad[oa]s?|rankead[oa]s?|posicionad[oa]s?|valorad[oa]s?)|rankings?|rankead[oa]s?',
);

// Spanish numbers used as a rank: "#N", "puesto #N", "puesto N", "número N", "n.º N".
// Bare spelled ordinals are intentionally NOT matched (collide with round names like
// "octavos"/"cuartos"); the ES prompt instructs the model to cite rank only as "#N".
function rankClaimsEs(text) {
  const nums = [];
  for (const mm of text.matchAll(/(?:puesto\s*)?#\s*(\d{1,2})\b/gi)) nums.push(Number(mm[1]));
  for (const mm of text.matchAll(/\bpuesto\s+(\d{1,2})\b/gi)) nums.push(Number(mm[1]));
  for (const mm of text.matchAll(/(?:n[.º°]\s*|n[uú]mero\s+)(\d{1,2})\b/gi)) nums.push(Number(mm[1]));
  return nums;
}

// Every number the text uses as a rank (digit or spelled-out ordinal).
export function rankClaims(text, lang = 'en') {
  if (lang === 'es') return rankClaimsEs(text);
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
export function rankViolation(text, allowed, lang = 'en') {
  if (typeof text !== 'string' || !text.length) return 'empty take';
  const banned = lang === 'es' ? BANNED_RANK_WORDS_ES : BANNED_RANK_WORDS;
  if (banned.test(text)) return 'banned rank/status word';
  // invented match-count totals (e.g. "across seven matches" / "en siete partidos") —
  // the model isn't told how many games a team played, so any such count is fabricated.
  const countRe =
    lang === 'es'
      ? /\b(?:\d{1,2}|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s+(?:partidos|encuentros|duelos|cotejos)\b/i
      : /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[\s-](?:matches|games|fixtures)\b/i;
  if (countRe.test(text)) return 'invented match-count total';
  for (const n of rankClaims(text, lang)) {
    if (!allowed.has(n)) return `rank #${n} not in supplied field ranks {${[...allowed].sort((a, b) => a - b).join(',')}}`;
  }
  return null;
}

// Blatant championship assertions — used ONLY for non-champion runs (a team whose
// best run ended in elimination). The match-take score guard already stops the
// elimination take from claiming a win; this stops a STORYLINE from fabricating a
// trophy the team never lifted. Honest "fell short of the title / the title eluded
// them" / "se quedó a las puertas del título" phrasing is intentionally NOT matched.
const TITLE_CLAIM =
  /\b(?:crowned|world\s+champions?|champions?\s+of\s+the\s+world|world\s+cup\s+(?:winners?|champions?))\b|\b(?:lift(?:ed|s|ing)?|hoist(?:ed|s|ing)?|rais(?:ed|es|ing)?|claim(?:ed|s|ing)?)\s+the\s+(?:trophy|cup|title|crown)\b|\bwon\s+(?:the\s+)?(?:world\s+cup|tournament|title|trophy|it\s+all)\b/i;

const TITLE_CLAIM_ES = esWord(
  'campe(?:ó|o)n(?:es|a|as)?\\s+(?:del\\s+mundo|mundial(?:es)?|del\\s+torneo|del\\s+planeta)|se\\s+coron(?:ó|o|aron)|coronad[oa]s?\\s+campe(?:ó|o)n(?:es|a|as)?|(?:levant|alz|conquist|gan)(?:ó|o|aron)\\s+(?:el\\s+|la\\s+)?(?:trofeo|copa(?:\\s+del\\s+mundo)?|t(?:í|i)tulo|mundial)',
);

// Returns the offending phrase if the text asserts a championship, else null.
export function titleClaim(text, lang = 'en') {
  if (typeof text !== 'string') return null;
  const m = text.match(lang === 'es' ? TITLE_CLAIM_ES : TITLE_CLAIM);
  return m ? m[0] : null;
}

// Real-world reputation/status framing that is NOT grounded in the supplied field
// rating. The model may explain a gap via the field-rank integers (which encode the
// FIFA rating) — "the #10 side edged the #48 side" — but NOT via reputation, pedigree,
// resources, history, or "class". Strict, rating-grounded honesty for the per-nation runs.
const REPUTATION_WORDS =
  /\b(pedigreed?|powerhouses?|heavyweights?|juggernauts?|elite|world[- ]?class|star[- ]?studded|superstars?|gala?cticos?|storied|vaunted|illustrious|fancied|prestigious|prestige|aristocrac\w*|household names?|deeper resources|resources|reputations?|highest level)\b/i;

// ES reputation/pedigree/class vocabulary. "potencia" is banned only in its status
// sense ("potencia mundial/del fútbol"), not the shot sense ("remató con potencia").
const REPUTATION_WORDS_ES = esWord(
  'potencias?\\s+(?:mundial(?:es)?|del\\s+fútbol|futbol(?:í|i)stica|continental|europea|sudamericana|africana|asiática)|gigantes?|colosos?|clase\\s+mundial|gal(?:á|a)ctic[oa]s?|estrellas?|figuras?|cracks?|estelares?|pedigr(?:í|i|ee)|prestigi[oa]s?|prestigios[oa]s?|abolengo|jerarqu(?:í|i)a|aristocr[a-záéíóú]*|tradici(?:ó|o)n|reputaci(?:ó|o)n|cach[ée]|recursos|(?:é|e)lite|primer\\s+nivel|máximo\\s+nivel|fuera\\s+de\\s+serie|nombres?\\s+ilustres?',
);

// Returns the offending reputation phrase if present, else null.
export function reputationClaim(text, lang = 'en') {
  if (typeof text !== 'string') return null;
  const m = text.match(lang === 'es' ? REPUTATION_WORDS_ES : REPUTATION_WORDS);
  return m ? m[0] : null;
}
