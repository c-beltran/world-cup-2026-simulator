# PRD — AI World Cup 2026 Simulator & Journey Tree
*(working title — see §10 for honest video/post titles)*

---

## 1. One-liner
A self-contained, screen-recordable web tool that runs an honest Monte Carlo simulation of the real 2026 World Cup thousands of times, then uses an LLM to narrate the stories inside the results — built as a personal showcase piece for LinkedIn.

---

## 2. Purpose — why we're doing this
This is **not a product**. It is a portfolio/showcase artifact with two audiences and two goals:
1. **Personal:** scratch the itch — combine a genuine love of soccer and the World Cup with something hands-on and fun.
2. **Professional (LinkedIn):** demonstrate judgment to a professional network — specifically, the ability to use AI *appropriately* (the right tool for the right job) rather than slapping "AI" on everything.

The core thesis we are selling, implicitly, through the work: **good engineering means knowing what AI is and isn't good at.** Math goes to a simulation; storytelling goes to an LLM. That split *is* the flex.

---

## 3. What we're looking for — success criteria
The piece succeeds if a soccer-literate AND a tech-literate viewer both come away impressed and **find nothing fake or sloppy**. Concretely:
- It looks visually striking on screen (capturable in one clean take).
- The numbers are credible and the method is defensible if questioned.
- The AI commentary is genuinely good writing, not mad-libs.
- Nothing in it claims to be something it isn't (see §4).
- It produces a short, sharp LinkedIn post where the *method* is the highlight.

Failure mode to avoid at all costs: a viewer who knows football or knows ML looks closely and catches a lie — fake teams, made-up "AI," guessed numbers. On a showcase, scrutiny is invited; the gap between claim and reality is what they'll remember.

---

## 4. Non-negotiable principles (the honesty guardrails)
These are hard requirements, not preferences:

1. **Real AI or don't say AI.** The narrative layer must be actual LLM calls. The probabilities come from an honest simulation. We never label a `Math.random()` phrase bank or a logistic formula as "AI."
2. **The AI narrates; it never invents the result.** Each LLM call is given the real matchup and the simulation's actual outcome and is constrained to narrate *that*. If the sim says Morocco beat Spain on penalties, the take is about that game — the model does not get to write a different one. (Same discipline as verifying tournament data: the artifact must not confidently assert something untrue.)
3. **Real tournament data.** Use the verified `groups.json` (real 48 teams, real groups) and `bracket.json` (real R32→final structure). No fictional team lists.
4. **Sourced ratings, not vibes.** Team strength is derived from the **current FIFA/Coca-Cola World Ranking points, normalized** to the model's scale — so we can state, accurately, "rated from the official FIFA World Ranking."
5. **Honest framing on screen and in the post.** It's a Monte Carlo simulation narrated by an LLM. A goal "in the 78th minute" is explicitly *the AI's story of a simulated universe*, labeled as such — flavor, not a prediction of a real match.

---

## 5. Scope
**In:**
- Offline generation pipeline (sim + pre-baked AI takes).
- One self-contained presentation HTML (data baked in, no live API calls, no dependencies except Chart.js via CDN).
- Stats visualizations, the Journey Tree bracket, auto-scroll capture mode, AI commentary display.

**Out (for v1):**
- Live AI calls in the browser.
- User-editable brackets / interactivity beyond selecting a featured simulation.
- Mobile optimization (this is a desktop screen-recording tool).
- Real-time data / live scores.

---

## 6. Architecture — key decisions

### 6.1 Two artifacts, not one
- **(A) Generation pipeline** (Node script, run once, offline): runs the Monte Carlo, selects featured simulations, calls the LLM to write their takes, and emits a single `data.json`.
- **(B) Presentation layer** (the self-contained HTML): imports the baked `data.json`, renders everything, drives the auto-scroll. Zero runtime API calls.

### 6.2 Pre-bake the AI — do NOT call it live
The presentation tool must ship with all AI output already generated and stored as data. Rationale: no latency pauses on camera, no flaky mid-record failures, fully controllable quality (regenerate any take you don't love), and **no API key in the shipped file**. The key lives only in the offline pipeline's environment (env var, gitignored) and never reaches the HTML.

### 6.3 Aggregate over everything, deep-store only what you'll show
Run 10,000+ sims for the **aggregate stats** (champion frequencies, finalist rates, Cinderella counts). Store the **full bracket path + generate AI takes only for a handful of featured sims** chosen for the video (e.g. the modal/most-common champion run, the best Cinderella run, a chalk final, a chaos bracket). This keeps memory sane and bounds AI cost (you narrate ~31 matches × a few sims, not 10,000 × 31).

---

## 7. Components

### 7.1 Data layer
- Load `groups.json` and `bracket.json` (the verified files).
- Attach a `strength` rating to each team, derived from the **current FIFA/Coca-Cola World Ranking points**, normalized to the model's scale (e.g. mapped to an Elo-like range). Record the ranking snapshot date in the method note so the source is reproducible.

### 7.2 Simulation engine (honest Monte Carlo)
- **Match model:** win probability from a rating difference, e.g. `P(A) = 1 / (1 + 10^(-(Rᴀ−Rʙ)/400))` (standard Elo) — call it what it is.
- **Group stage:** real round-robin within each real group; **model draws** (a draw band when ratings are close) since group standings depend on them; 3/1/0 points; apply real tiebreakers (points → GD → goals) at least approximately.
- **Qualification:** top 2 per group + 8 best third-place teams (by points, then rating). 
- **Knockout:** use the **real `bracket.json` wiring** (group winners/runners-up into their actual R32 slots). For the third-place→slot allocation, two options:
  - *Preferred:* implement FIFA Annex C (495-combination lookup) for full fidelity.
  - *Acceptable if disclosed:* assign the qualifying third-place teams to their eligible slots by rank; note the approximation in the method note.
- Knockouts are win-or-go-home (the model resolves extra-time/penalties).
- **Track:** champion counts, finalist counts, per-round survival, and "Cinderella" runs (teams below a strength threshold reaching SF+). Persist full detail for featured sims only.
- **Performance:** 10k+ sims must complete in ~1s; log progress to console.

### 7.3 AI narrative layer (pre-baked)
For each **featured** simulation, generate:
- **Per-knockout-match takes:** why the winner advanced, the tactical/story angle, an imagined key moment/scorer/minute — explicitly framed as the story of *that simulated game*.
- **Tournament storylines:** the Cinderella narrative, a final preview, and a "what 10,000 simulations revealed" summary tied to the aggregate stats.
- **Prompt contract (per call):** input = real teams + the sim's actual result + relevant context (ratings, round); instruction = narrate only this outcome, do not change the winner/score; output = tight, broadcast-style prose. Store outputs keyed to match IDs in `data.json`.

### 7.4 Visualizer (presentation HTML)
- **Stats panel:** Chart.js bar chart of top-10 most frequent champions; a "most common finals" list; a "Cinderella stories" list (team, sim #, round reached).
- **Simulation selector:** dropdown to load a featured sim into the Journey Tree.
- **Journey Tree:** the real 32-team knockout as a vertical branching tree (R32 at the bottom → champion crowned at top). SVG/positioned nodes; champion's path glows gold; eliminated teams dim. Reuse the dark-pitch aesthetic but make it genuinely crafted, not default (see the design bar from the main project).
- **AI commentary:** displayed per match, surfacing as overlays synced to the auto-scroll.

### 7.5 Video-production features
- **Auto-Scroll Journey:** a button that smoothly scrolls bottom→top over ~15s, pausing ~1s at each match on the winning path, with the matching AI take overlaid. This is the primary capture shot.
- **Frame/thumbnail mode:** a toggle that composes a clean static "hero" frame (full tree + champion) for the thumbnail.
- **Workflow note in the UI:** "Screen-record this page" — no heavy export dependency.

---

## 8. Execution plan (phased)

**Phase 0 — Setup**
- Repo with two halves: `/pipeline` (Node) and `/app` (the HTML). Add `groups.json`, `bracket.json`. Put the API key in `.env`, gitignore it.

**Phase 1 — Ratings**
- Pull the **current FIFA/Coca-Cola World Ranking points** for all 48 teams, normalize them to the model's scale, and write into `teams.json`. Record the ranking's snapshot date so the numbers are reproducible.

**Phase 2 — Simulation**
- Build the Monte Carlo over the real groups + real bracket wiring. Validate: champion distribution looks sane (favorites win most, upsets exist), no impossible matchups, third-place allocation respects eligibility. Run 10k+, emit aggregate stats.

**Phase 3 — Featured selection**
- Auto-select 3–5 featured sims (modal champion, best Cinderella, chalk final, chaos bracket) and persist their full bracket paths.

**Phase 4 — AI generation**
- For featured sims only, call the LLM under the prompt contract in §7.3. Review/regenerate weak takes. Bake everything into `data.json`.

**Phase 5 — Presentation build**
- Build the self-contained HTML: stats panel, Journey Tree, commentary, selector. Import `data.json`. Confirm zero runtime API calls and no key present.

**Phase 6 — Capture features**
- Implement auto-scroll + pauses + synced overlays, and thumbnail mode. Tune timing for a clean one-take recording.

**Phase 7 — Polish & QA**
- Visual polish to showcase grade. Final honesty pass against §4 (every on-screen claim is true). Test the full screen-record run.

---

## 9. Risks & things to get right
- **The "it's not really AI" trap** — mitigated by §4.1/4.5; the post must state the split plainly.
- **Hallucinated narration** — mitigated by the §7.3 prompt contract; spot-check that takes match the stored results.
- **Fictional/old data** — mitigated by using the verified files; do not let any agent "improve" the team list from memory.
- **API key leakage** — mitigated by pre-baking; verify the shipped HTML contains no key and no fetch to the LLM.
- **Scope creep** — this is a showcase, not a product; resist interactivity and mobile.

---

## 10. The LinkedIn deliverable
The post is part of the build, not an afterthought. The method is the highlight:
- Suggested honest titles: *"I simulated the 2026 World Cup 10,000 times — here's what the data said,"* or *"I split a World Cup predictor in two: Monte Carlo for the odds, an LLM for the stories. Here's why."*
- Post structure: the hook (a surprising stat from the aggregate), the method (the two-engine split and *why*), one great AI-written storyline, the clip, and a one-line reflection on using AI for what it's actually good at.

---

## 11. Acceptance criteria
- Uses the real 48 teams, real groups, real bracket structure.
- Ratings are the normalized FIFA/Coca-Cola World Ranking points, with the snapshot date documented in-tool.
- 10,000+ sims; aggregate stats render correctly in Chart.js.
- AI takes are real LLM output, baked in, and faithful to each sim's stored result.
- Shipped HTML has no API key and makes no live calls.
- Auto-scroll produces a clean, narrated one-take capture.
- Every on-screen claim passes the §4 honesty check.
