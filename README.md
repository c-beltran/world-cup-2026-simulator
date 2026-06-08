# ⚽ AI World Cup 2026 Simulator & Journey Tree

Run an honest Monte Carlo simulation of the **real** 2026 FIFA World Cup tens of thousands of times, then use an LLM to narrate the stories hidden inside the results — and render it all as a screen-recordable "journey tree" you can turn into a video.

> **The thesis:** good engineering means using the right tool for the job. The **math** (who wins) comes from a simulation. The **storytelling** (why, and how the drama unfolds) comes from an LLM. Two engines, each doing what it's actually good at.

---

## What you get
- A **Monte Carlo simulator** over the real 48 teams, real groups, and the real knockout bracket wiring — 50,000 runs in ~1.6s.
- Aggregate stats: champion odds, finalist rates, per-round survival, Cinderella runs.
- **Pre-baked AI narration** for a handful of featured simulations (per-match takes + tournament storylines), each mechanically verified to match the simulation's actual result.
- A self-contained **presentation page** (dark-pitch aesthetic, golden journey tree, auto-scroll capture mode) — opens off the filesystem, no live API calls, no dependencies except Chart.js via CDN.

---

## How it works (the honest method)
1. **Ratings** = the official **FIFA / Coca-Cola World Ranking points** (snapshot **1 April 2026**, the last release before the tournament), used directly as Elo-scale strengths. Sourced + cited in [`pipeline/sources/`](pipeline/sources/) and [`docs/data-provenance.md`](docs/data-provenance.md) — never hand-guessed.
2. **Simulation** plays each real group as a round-robin (3/1/0, real tiebreakers), qualifies the top 2 + 8 best third-placed teams (eligibility-respecting allocation), and runs the real R32→final bracket. Match scorelines come from a **Poisson model parameterized by the rating gap** using **FIFA's own logistic divisor (600)** — *not* a bare win-probability — so draws, goal difference and real scorelines all emerge naturally.
3. **Featured selection** picks the modal champion, a Cinderella, a chalk final, and a chaos bracket; their full bracket paths are persisted.
4. **AI narration** is generated **once, offline**, for those featured sims only. Each call gets the sim's *actual* result and is constrained to narrate exactly that — and must echo back the winner + score, which the pipeline **verifies and rejects on any mismatch**. The model cannot ship a take that changes who won.
5. **Presentation** bakes all of that into `app/data.js`, which the page reads with zero network calls.

**Principles this repo holds to:** the AI is real LLM output (not a phrase bank); it narrates results it's given and never invents them; the tournament data is the real 2026 draw; ratings are sourced; the venue is neutral (no host advantage, disclosed); and every rank shown is **field rank (1–48)**, with global FIFA rank used only as labeled "world #N" flavor.

---

## Repo structure
```
.
├── data/
│   ├── groups.json        # verified real 2026 groups (A–L) + flag codes  [ground truth]
│   ├── bracket.json       # verified real knockout wiring (M73–M104)       [ground truth]
│   └── teams.json         # GENERATED: teams + field/world rank + FIFA points
├── pipeline/              # offline generation (Node, zero runtime deps) — uses the API key
│   ├── rateTeams.js       #  -> data/teams.json from the sourced FIFA snapshot
│   ├── simulate.js        #  -> out/sim-results.json (Monte Carlo + featured sims)
│   ├── narrate.js         #  -> out/narration.json (verified LLM takes, provider-agnostic)
│   ├── build.js           #  -> app/data.js + app/data.json
│   ├── lib/               #  rng · model (Poisson-from-Elo) · tournament · serialize · llm
│   ├── sources/           #  cited raw FIFA ranking snapshot
│   └── out/               #  generated intermediates (gitignored)
├── app/                   # the self-contained presentation layer
│   ├── index.html         #  opens in a browser; reads window.WC_DATA from data.js
│   └── data.js            #  GENERATED: stats + featured brackets + AI takes (no key)
├── docs/                  # PRD + data-provenance / method note
└── .env                   # your API key (gitignored; used only by /pipeline)
```

---

## Quick start

### Prerequisites
- **Node 18+** (uses built-in `fetch` and `--env-file`). No `npm install` needed — the pipeline has zero runtime dependencies.
- One LLM API key. **Default: Anthropic (Claude).** Provider-agnostic via `LLM_PROVIDER` (a Gemini adapter is included as a free-tier fallback).

### Configure the key
Create a `.env` in the repo root (gitignored — the key never leaves it and never reaches `app/`):
```
ANTHROPIC_API_KEY=sk-ant-...
LLM_MODEL=claude-haiku-4-5      # verified against platform.claude.com/docs (cheap + fast)
# LLM_PROVIDER=anthropic        # default; "gemini" also supported (set GEMINI_API_KEY)
```

### Run the pipeline (offline, one time)
```bash
cd pipeline
npm run rate              # -> data/teams.json   (from the sourced FIFA snapshot)
npm run simulate          # -> out/sim-results.json   (50k sims; override with `npm run simulate 100000`)
npm run narrate -- all    # -> out/narration.json     (AI takes for all featured sims; needs the key)
npm run build             # -> app/data.js + app/data.json
```
Everything is **seeded** (master seed `20260611`), so re-running reproduces identical stats and featured sims. To refresh to a newer FIFA release, drop a new cited file in `pipeline/sources/`, point `rateTeams.js` at it, and re-run.

### View / record
```bash
open app/index.html       # double-click works too — no server, no key, no live calls
```
Pick a featured simulation, hit **Auto-Scroll Journey**, and screen-record the page.

---

## Configuration reference
| Var | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | `.env` | Claude key (offline narration only) |
| `LLM_PROVIDER` | `.env` | `anthropic` (default) or `gemini` |
| `LLM_MODEL` | `.env` | model id, e.g. `claude-haiku-4-5` |
| `SIMS` | CLI/env | Monte Carlo runs (default 50000) |
| `SEED` | env | master seed (default 20260611) |

> The key lives **only** in `.env` and is read only by `/pipeline`. It is never written into `app/`, and the shipped page makes **no** network calls (Chart.js via CDN is the only external asset).

---

## Data & attribution
- `groups.json` / `bracket.json` are the verified real 2026 draw + knockout wiring — **do not** regenerate them from an LLM's memory.
- Ratings are the official FIFA/Coca-Cola points (1 April 2026); sources and verification are documented in [`docs/data-provenance.md`](docs/data-provenance.md).
- Third-place→slot allocation respects each slot's eligibility list (an Annex C approximation; disclosed in the method note).

## License
MIT.
