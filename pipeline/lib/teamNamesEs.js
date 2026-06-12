// Canonical English -> Spanish team names for all 48 finalists, keyed by the EXACT
// English name used in the data (data/groups.json -> sim-results -> narration).
//
// Single source of truth: narrate.js (`--lang es`) uses it to write Spanish prose
// with Spanish names, and build.js bakes it into data.meta.teamNamesEs so the app
// localizes the cards/kicker/headers to match. Keep the two in sync by construction.
//
// REVIEW AT THE SAMPLE GATE (dialect-dependent, native-speaker call):
//   Qatar -> Catar | Qatar      Saudi Arabia -> Arabia Saudita | Arabia Saudí
//   Czechia -> Chequia | Rep. Checa   Congo DR -> RD Congo   Curaçao -> Curazao | Curaçao
//   Korea Republic -> Corea del Sur | República de Corea
export const TEAM_NAMES_ES = {
  France: 'Francia',
  Spain: 'España',
  Argentina: 'Argentina',
  England: 'Inglaterra',
  Portugal: 'Portugal',
  Brazil: 'Brasil',
  Netherlands: 'Países Bajos',
  Morocco: 'Marruecos',
  Belgium: 'Bélgica',
  Germany: 'Alemania',
  Croatia: 'Croacia',
  Colombia: 'Colombia',
  Senegal: 'Senegal',
  Mexico: 'México',
  'United States': 'Estados Unidos',
  Uruguay: 'Uruguay',
  Japan: 'Japón',
  Switzerland: 'Suiza',
  Iran: 'Irán',
  'Türkiye': 'Turquía',
  Ecuador: 'Ecuador',
  Austria: 'Austria',
  'Korea Republic': 'Corea del Sur',
  Australia: 'Australia',
  Algeria: 'Argelia',
  Egypt: 'Egipto',
  Canada: 'Canadá',
  Norway: 'Noruega',
  Panama: 'Panamá',
  "Côte d'Ivoire": 'Costa de Marfil',
  Sweden: 'Suecia',
  Paraguay: 'Paraguay',
  Czechia: 'Chequia',
  Scotland: 'Escocia',
  Tunisia: 'Túnez',
  'Congo DR': 'RD Congo',
  Uzbekistan: 'Uzbekistán',
  Qatar: 'Catar',
  Iraq: 'Irak',
  'South Africa': 'Sudáfrica',
  'Saudi Arabia': 'Arabia Saudita',
  Jordan: 'Jordania',
  'Bosnia and Herzegovina': 'Bosnia y Herzegovina',
  'Cabo Verde': 'Cabo Verde',
  Ghana: 'Ghana',
  'Curaçao': 'Curazao',
  Haiti: 'Haití',
  'New Zealand': 'Nueva Zelanda',
};

// Spanish name for an English team name (identity fallback if unmapped).
export const esName = (en) => TEAM_NAMES_ES[en] || en;
