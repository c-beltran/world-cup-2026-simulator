# Data provenance & method note

Where every number in this project comes from, and how it is used. This exists so any
claim on screen can be traced to a real source — per the honesty guardrails in the
[PRD §4](wc-simulator-PRD.md).

## Inputs

### `data/groups.json` and `data/bracket.json` — verified ground truth
The real 2026 World Cup draw (48 teams, 12 groups A–L) and the real knockout wiring
(M73–M104: R32 → R16 → QF → SF → 3rd place → final). These files are treated as
**immutable**: never regenerated, reordered, "corrected," or supplemented from model
memory. They were provided pre-verified against live sources (Jun 2026).

### `data/teams.json` — sourced ratings (generated)
Produced by [`pipeline/rateTeams.js`](../pipeline/rateTeams.js), which joins the team
list/flag codes from `groups.json` with ranking points from the sourced snapshot below.

- **Rating source:** FIFA / Coca-Cola Men's World Ranking.
- **Snapshot:** the **1 April 2026** release — the last official ranking published
  before the tournament (the next release was 10 June 2026). Chosen as the definitive,
  frozen, citable pre-tournament reference.
- **Retrieved:** 2026-06-06.
- **Raw, cited values:** [`pipeline/sources/fifa-rankings-2026-04-01.json`](../pipeline/sources/fifa-rankings-2026-04-01.json).

**How it was verified (no number recalled or guessed):**
- Ranks 1–20 match Wikipedia's full-precision anchor values **exactly**.
- Ranks 1–50 corroborated by ESPN's April-2026 top-50 list.
- The tail (ranks 55–85) had each team's rank confirmed on FIFA.com's official per-team
  pages ("Last official update: 01 April 2026") and its points cross-checked across two
  independent full tables (whereig + soccer365) that agree to the decimal.
- **Discarded** as the wrong snapshot: a 10 June 2026 *live daily projection* (which has
  Argentina #1, vs France #1 in the official April release) and a scrambled third-party
  list. Mixing snapshots would violate the "every on-screen claim is true" rule.

## How ratings are used

`strength` (the value the simulator consumes) **is** the official FIFA ranking points,
used directly. FIFA's post-2018 ranking is itself Elo-based, so the points already lie on
an Elo-like scale (here ~1281 → 1877, a 596-point spread). No rescaling is applied, so the
honest answer to "what are your ratings?" is: *the unmodified official FIFA points.* The
real points are also what we display in the UI — soccer-literate viewers recognize them.

Downstream:
- **Rank basis:** every rank shown (sim, UI, narration) is **field rank** — 1–48 within
  this tournament, by FIFA points. The global FIFA world rank is carried only as flavor and
  is always labeled "world #N", never a bare "#N" ("14th-best in this field" is meaningful;
  "#82 of 48" reads as a broken bracket).
- **Simulation (match model):** a rating gap maps to a win-expectancy via the Elo/logistic
  curve using **FIFA's own divisor (600)** — not a generic 400 — then to a bounded expected
  goal supremacy, then to two Poisson means. Goals are *sampled*, so draws, goal difference
  and goals-for emerge naturally (used for group tiebreakers) and every knockout game has a
  real scoreline plus an extra-time/penalties flag.
- **Neutral venue (deliberate, disclosed):** home advantage is real and well documented in
  football, but the model applies **no host bump** to the USA, Mexico or Canada — every team
  is judged purely on its FIFA rating. This keeps the claim "everything traces to FIFA
  points" exactly true. Upside: when the sim *does* produce a co-host title run, it is earned
  on rating alone, not engineered.
- **AI narration:** the LLM is given the simulation's *actual* result and the teams'
  ratings purely as context to narrate that outcome — it never changes who won or invents
  a different scoreline.

## Reproducing
```
cd pipeline && npm run rate    # regenerates data/teams.json from the sourced snapshot
```
To refresh to a newer FIFA release, replace `pipeline/sources/fifa-rankings-*.json` with a new sourced+cited snapshot and re-run; nothing else changes.
