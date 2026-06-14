// openfootball/worldcup.json -> our canonical team names (data/groups.json) and
// our canonical round codes (used by lib/elo.js importance + the sim).
//
// openfootball spells a handful of nations differently and uses placeholder slot
// codes for undetermined knockout participants ("1A", "2B", "3A/B/C/D/F", "W73",
// "L101"). toCanon() returns the canonical name for a REAL team, or null for a
// placeholder — callers skip nulls. The map is validated against groups.json by
// the fetcher (it exits if any real openfootball name fails to resolve).

// Only the names that differ from ours need an entry; everything else passes through.
export const OF_TO_CANON = {
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
  'Cape Verde': 'Cabo Verde',
  'Czech Republic': 'Czechia',
  'DR Congo': 'Congo DR',
  'Ivory Coast': "Côte d'Ivoire",
  'South Korea': 'Korea Republic',
  Turkey: 'Türkiye',
  USA: 'United States',
};

// Placeholder participant codes: group winner/runner-up (1A/2B), best-third slot
// (3A/B/C/D/F), knockout winner/loser of a prior match (W73 / L101).
const PLACEHOLDER = /^(?:[123][A-L](?:\/|$)|[WL]\d+$)/;
export const isPlaceholder = (name) => PLACEHOLDER.test(String(name || '').trim());

// Returns canonical name, or null if this is an undetermined-slot placeholder.
export function toCanon(name) {
  const n = String(name || '').trim();
  if (!n || isPlaceholder(n)) return null;
  return OF_TO_CANON[n] || n;
}

// openfootball round string -> our canonical round code.
export function toRound(round, group) {
  const s = String(round || '');
  if (/^Matchday/i.test(s) || group) return 'group';
  if (/Round of 32/i.test(s)) return 'R32';
  if (/Round of 16/i.test(s)) return 'R16';
  if (/Quarter/i.test(s)) return 'QF';
  if (/Semi/i.test(s)) return 'SF';
  if (/third place/i.test(s)) return '3rd_place';
  if (/^Final/i.test(s)) return 'final';
  return s; // unmapped — surfaced by the fetcher
}

// "Group A" -> "A" (group matches only; null otherwise).
export const groupIdOf = (group) => {
  const m = /^Group\s+([A-L])/i.exec(String(group || ''));
  return m ? m[1].toUpperCase() : null;
};
