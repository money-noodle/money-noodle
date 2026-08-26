# Noodle Land and whimsical gamification — design direction

> **Document type:** Product design
> **Design status:** Exploratory
> **Implementation:** Not applicable
> **Created:** 2026-08-22
> **Canonical requirements:** None — proposal or exploration only
> **Decision record:** None — no accepted product decision
> **Design index:** [`docs/README.md`](README.md)

> **Direction locked 2026-08-22; refinement required before specification.** The maintainer approved the
> complete direction in this document: one noodle equals one cent; Noodle Land is an ambient layer with
> optional deeper immersion; progression rewards learning and evidence rather than trading activity or
> profit; and funded execution remains restrained. This records product intent, not an implementation-ready
> specification. The open questions in §12 must be resolved in a further design pass before this enters
> `SPEC.md` or authorizes product code.

> **Exploratory prototype:** `docs/prototypes/noodle-land/index.html` demonstrates sample SVG geometry,
> mascot poses, bowl motion, Noodle Party, the research scale, levels, and environmental color. Its current
> visual pass gives Nomi a friendly pearl-onion face while retaining the main app mascot's broken navy
> orbit, green arrow-leaves, and dimensional gold noodles. Each state now reshapes the character's noodles,
> leaves, posture, and orbit instead of placing rigid props over an unchanged icon. Exact-app-mark,
> separate-bowl, and softer first passes remain alongside it for comparison. All use invented paper values and
> have no app imports, network requests, durable state, or trading authority. Their geometry, timing, and
> interactions are review material rather than requirements.

## 1. Product intent

Money Noodle should feel curious, inventive, and alive without making a funded prediction-market desk feel
like a casino. The central metaphor is **noodling**: thinking in public, turning an idea over, testing it,
learning from failure, and changing one's mind when the evidence changes.

The playful layer has three jobs:

1. make research, paper experimentation, and evidence collection inviting;
2. make abstract cents, uncertainty, and progress easier to understand without obscuring exact values; and
3. give Money Noodle a distinctive world, mascot, language, and motion system.

It must not reward deposits, order count, trade frequency, stake, live activation, profit, or loss recovery.
It must not alter a forecast, policy, budget, execution decision, reconciliation result, or order. Existing
financial and safety language remains available wherever precision is load-bearing.

## 2. World model

**Noodle Land** is the colorful visual environment. **The Noodle Lab** is its conceptual center and the
primary place for thinking, research, trial and error, and paper experiments.

| Existing product concern | Noodle Land expression | Grounded meaning |
| --- | --- | --- |
| Research workspace | **The Noodle Lab** | Ask questions, inspect assumptions, and develop testable ideas |
| Paper trading | **The Paper Pot** | Simulated execution with a separate paper bankroll |
| Funded execution | **The Live Stove** | Real money; visually hot, restrained, and explicitly gated |
| Data providers | **The Pantry** | Ingredients and their freshness, provenance, and availability |
| Policy manifest/history | **The Recipe Book** | Versioned rules, rationale, and immutable changes |
| Research and performance reports | **Tasting Notes** | Findings, caveats, null results, and what evidence permits |
| Decision/trade history | **The Noodle Trail** | Auditable, immutable chronology |

These names supplement rather than replace authoritative labels. In particular, **Paper** and **Live** remain
visible on every money surface and may never be combined into one bowl, balance, result, level, or celebration.

## 3. Noodle units

The canonical conversion is locked:

- **1 noodle = 1¢**
- **100 noodles = 1 noodle nest = $1.00**
- **1,000 noodles = 1 bowl = $10.00**

A noodle is a display vocabulary over the existing cent amount, not a new currency, token, spendable reward,
or accounting representation. The durable source remains the existing exact and whole-cent money views. The
UI should pair the metaphor with the ordinary amount, for example:

> **2,086 noodles · $20.86**

The interface must retain the system's exact-versus-whole-cent distinction. A reporting value with legitimate
fractional cents cannot be silently rounded into a noodle control balance, and a decorative noodle count can
never authorize or size an order.

Visible strands in a bowl are symbolic. The exact text value is authoritative; an illustration must not imply
that its rendered strand count is literal.

## 4. Language system

The following balance vocabulary is locked:

- **Noodle Gain** — a verified settled positive change;
- **Noodle Drain** — a verified settled negative change;
- **Noodles Simmering** — open or unresolved value;
- **Noodles Reserved** — money committed to a pending/open order;
- **Noodles Served** — a settled result.

**Noodle Up** and **Noodle Down** are reserved for market direction because `UP` and `DOWN` already have exact
contract meanings. They are not synonyms for balance gain and drain. On an authoritative market surface the
ordinary `UP` or `DOWN` label remains adjacent; whimsical language may not redefine the contract.

Language should make a null result or failed idea feel worthwhile without softening a financial loss. “Null
result, full bowl” can celebrate learning; a negative funded P&L must still say that money was lost.

## 5. The animated noodle bowl

A read-only bowl may visualize one explicitly selected balance at a time. Paper and live require separate,
clearly labelled bowls; there is no consolidated celebratory bowl.

Proposed visual states:

- a Noodle Gain curls one or more strands into the bowl;
- a Noodle Drain has chopsticks quietly lift strands out;
- reserved noodles sit in a side basket;
- unresolved positions produce subtle steam;
- settlement returns the illustration to the current authoritative value;
- unavailable or stale source data stops the animation and shows an explicit unavailable/stale state.

The animation represents a newly verified transition, not optimistic client state. Placing an order is not a
gain, an open position is not winnings, and refreshing or reopening the page must not manufacture a repeated
celebration.

### Celebration boundaries

- Small gain: one looping strand.
- Larger gain: several strands with restrained ingredient sparkles.
- Drain: calm removal, with no shame, alarm, or comic punishment.
- **Noodle Party:** learning/evidence milestones only, never a funded win, deposit, increased stake, resumed
  automation, or streak of trades. Its visual language is a field of curled, wobbling noodle ribbons—not
  rectangular confetti—in broth gold, scallion green, chili coral, splash aqua, dumpling lilac, porcelain
  cream, orange, and pink. The current prototype stages 72 ribbons in three layers: a center burst, an orbital
  curl around Nomi, and a softer noodle rain. Nomi may briefly move into Eureka and then return to the prior
  state. Outlined strands and theme-aware highlights keep every color legible on light and dark surfaces.
- No loss-recovery prompt, near-miss treatment, variable reward schedule, or urgency mechanic.

Motion must honor `prefers-reduced-motion`, pause in hidden tabs, avoid blocking controls, and have a user-facing
off switch. Critical live state must never be communicated only through animation.

## 6. Mascot direction: Nomi the Noodler

The working mascot name is **Nomi the Noodler**. Nomi should remain visibly related to the existing circular
noodle-arrow mark, not become an unrelated bowl character. The current preferred prototype adds a pearl onion
as Nomi's face rather than treating the mark's black negative space as a face. It aims for a warm, endearing,
comforting character that can communicate trust and understanding. This remains a refinement candidate, not
yet a specification lock.

The proposed dependency-free SVG anatomy is:

- the broken navy orbit remains Nomi's stable frame;
- the green upward arrow becomes both momentum and living onion leaves;
- dimensional gold ribbons remain Nomi's flowing noodle body;
- a warm cream pearl onion carries large navy eyes, highlights, cheeks, brows, and a small mouth; and
- the noodles, leaves, posture, and orbit all change with the state rather than relying on detached props.

The bowl remains the separate balance illustration; it is not Nomi's body. Component paths permit CSS
transforms and `stroke-dashoffset` animation, remain crisp at icon and hero sizes, and support a static
reduced-motion rendering.

Proposed Nomi states:

| State | Pose | Product use |
| --- | --- | --- |
| **Curious** | Onion leans in while a noodle tip curls forward | Empty research prompt or new idea |
| **Noodling** | Arrow bends and a noodle becomes a soft question curl | Research or calculation in progress |
| **Comparing** | Noodles and leaves form a balanced, symmetrical body | Reviewing evidence for and against an idea |
| **Eureka** | Sprout and upward arrow rise together as the noodle body opens | A learning milestone, not a predicted win |
| **Cautious** | Noodles tuck inward and a leaf becomes a protective shield | Stale, unavailable, blocked, or unresolved state |
| **Resting** | Onion nestles into a noodle coil beneath a leaf blanket | No action warranted |
| **Party** | Gold noodles and green leaves open into a gentle orbit celebration | Completed evidence milestone only |

Nomi may react to freshness, evidence state, and system availability. Nomi must not pressure the operator to
trade, taunt a loss, celebrate funded risk, or imply that a safety block should be bypassed.

## 7. Noodle types, levels, and titles

Progression is noncompetitive and rewards evidence discipline. Each noodle type is a **category**, not one
atomic level. Every category has sublevels represented by increasingly saturated variations of that category's
color. The current naming pass gives each broth an alliterative family so its four steps read as one category;
puns appear only where they remain immediately understandable, such as **Udon Know Yet**, **Bayesically
Brilliant**, and **Noodlini & Beyond**. Exact names and unlock conditions remain part of the pre-specification
refinement.

The playful category colors return here without changing financial semantics: Fresh Somen is aqua, Tinker
Udon green, Signal Soba gold, Evidelli coral, Calibramen lilac, Bayes-Biang orange, and Infinite Noodlini pink.
A lighter or darker category shade indicates progression only; it must never indicate gain, loss, readiness,
paper/live identity, or permission to trade.

The approved creative ladder is:

| Level | Noodle type | Title | Meaning |
| --- | --- | --- | --- |
| 1 | **Fresh Somen** | Somen Seeker | Begins asking questions |
| 2 | **Tinker Udon** | Udon Unraveler | Opens factors and explores assumptions |
| 3 | **Signal Soba** | Soba Signal Scout | Compares model probability with market price |
| 4 | **Evidelli** | Evidence Explorer | Tests an idea against resolved evidence |
| 5 | **Calibramen** | Calibration Cook | Waits for independent windows and updates beliefs |
| 6 | **Bayes-Biang** | Belief Balancer | Separates uncertainty, evidence, and action |
| 7 | **Infinite Noodlini** | Null Navigator | Completes repeated documented experiments without hiding null results |

The prototype currently explores these category-specific sublevel labels:

| Category | S1 | S2 | S3 | S4 |
| --- | --- | --- | --- | --- |
| Fresh Somen | Somen Starter | Somen Sifter | Somen Solver | Somen Sage |
| Tinker Udon | Udon Know Yet | Udon Unraveler | Udon Updater | Ultimate Udon |
| Signal Soba | Soba Spotter | Soba Sorter | Soba Synthesizer | Soba Seer |
| Evidelli | Evidelli Explorer | Evidelli Examiner | Evidelli Evaluator | Evidelli Expert |
| Calibramen | Calibramen Collector | Calibramen Counter | Calibramen Corrector | Calibramen Connoisseur |
| Bayes-Biang | Bayes Beginner | Broth Bayesian | Belief Balancer | Bayesically Brilliant |
| Infinite Noodlini | Null Noodler | Noodlini Noticer | Null Navigator | Noodlini & Beyond |

Candidate accomplishments include:

- **No Secret Ingredient** — inspect the complete factor stack for a thesis;
- **Against the Grain** — examine evidence contrary to the initial idea;
- **Let It Simmer** — wait for sufficient independent settlement windows;
- **Drain Brain** — document why an idea failed;
- **Null Result, Full Bowl** — complete an experiment that found no advantage;
- **Fresh Noodles Only** — refuse stale evidence rather than filling a gap;
- **Two-Bowl Discipline** — keep paper and live results separate.

The exact unlock rules are not yet specified. They must use meaningful, non-spammable evidence events and
must not be functions of P&L, balance, stake, deposits, order count, live arming, or trade frequency. A user
must be able to hide levels and accomplishments without losing access to any product capability.

A later brainstorm expanded the naming space to four ten-level groups: real noodles with origin notes,
invented real-adjacent puns, an extended next-level combination, and a boundary-pushing mythic menu. Those
options are preserved in [noodle-progression-naming-options.md](noodle-progression-naming-options.md) for a
future naming pass. No group is selected and the seven-category prototype remains unchanged for now.

## 8. The Great Noodle Scale

The **Noodle / Don’t Noodle** scale belongs in the research workspace, not the execution path. It is a way to
organize an idea, not a buy/sell recommendation or a new policy score.

Evidence cards can be placed on either side:

- **Noodle this** — reasons the idea deserves further exploration;
- **Don’t noodle this** — weak assumptions, stale sources, contrary evidence, or unbounded uncertainty;
- **Keep noodling** — the honest center when the question remains unresolved.

The scale can conclude:

1. **Don’t Noodle** — contradicted or insufficient;
2. **Keep Noodling** — unresolved;
3. **Ready to Test** — suitable for a paper experiment; or
4. **Evidence Served** — experiment completed and documented.

The current visual candidate uses friendly onion Nomi as the pivot, a rounded gold noodle as the beam, and two
cream bowls with green leaf rims. **Don't Noodle** and **Noodle This** live low inside those bowls rather than on
the beam. Each pan moves vertically with its end of the tipping beam while its label remains horizontal, so the
beam can never cover or rotate the text. The center conclusion stays in a separate pill below the apparatus.
This construction remains prototype detail pending the wider interaction refinement.

No conclusion can place, preview, arm, size, recommend, or authorize a live order. Generated research text and
user-arranged evidence remain terminal and advisory under the existing LLM boundary.

## 9. Visual system

The existing typography and semantic text colors remain the foundation. Noodle Land adds environmental color
to illustrations, backgrounds, containers, and moments of discovery:

- broth gold;
- scallion green;
- chili coral;
- splash aqua;
- dumpling lilac;
- porcelain cream; and
- soy ink.

The existing `gain`, `loss`, `warn`, `live`, and `data` tokens retain their exact semantic meanings. Decorative
colors cannot recolor outcome, readiness, safety, or execution state. The Live Stove should remain quieter and
more operational than the Noodle Lab or Paper Pot.

Noodle Land is ambient by default: brand, hero, mascot, bowl, section illustrations, and restrained motion.
Deeper immersion is optional. Light and dark themes receive equal treatment: hero text, tags, event console,
research scale, category cards, sublevels, outlines, and motion contrast must all use theme-aware surface and
ink tokens rather than assuming a navy canvas. Decorative dark brand-anchor art may remain intentionally dark.
The core information architecture, dense evidence tables, and authenticated controls remain usable without
the whimsical layer.

## 10. Safety and authority boundaries

This design is presentation and learning scaffolding only. It changes none of the following:

- forecast probabilities or factors;
- buy, exit, switch, or execution policy;
- paper/live mirror behavior;
- bankroll or funded budget arithmetic;
- order sizing, placement, cancellation, or reconciliation;
- loss limits, rate limits, pause, kill switch, or arming;
- immutable evidence, report, policy, and ledger history; or
- the separation between LLM research output and trading decisions.

Every financial surface continues to show ordinary dollars, track identity, status, and exact authoritative
labels. Whimsy may add comprehension, never remove precision.

## 11. Intended delivery order after specification

The current preferred sequence, subject to the refinement pass, is:

1. create the static and animated SVG Nomi state system;
2. introduce the ambient Noodle Land hero and environmental palette;
3. add one read-only, explicitly scoped paper bowl with exact noodles and USD;
4. add deduplicated Gain/Drain transitions from verified settled summaries;
5. introduce Noodle Lab, Pantry, Recipe Book, Tasting Notes, and Noodle Trail language while preserving
   authoritative labels;
6. prototype optional evidence-based levels and accomplishments; and
7. keep the Live Stove restrained and functionally unchanged until the complete presentation has been
   reviewed against a funded desk.

No phase begins from this document alone.

## 12. Refinement required before `SPEC.md`

The direction is agreed, but these details remain deliberately open:

1. **Surface map:** exact placement and hierarchy on desktop, mobile, public, signed, paper, and live views.
2. **Bowl scale:** how symbolic fullness maps to a changing bankroll without implying a false literal strand
   count, including zero, depletion, reset, and fractional-cent reporting states.
3. **Transition identity:** the verified event and deduplication rule that prevents replayed Gain/Drain
   animations after refresh, remount, reconnect, projection lag, or ledger correction.
4. **Progression owner:** whether levels describe the operator's exploration, the Noodle Lab's collective
   evidence maturity, or two explicitly separate systems.
5. **Unlock definitions:** exact auditable, non-spammable events and whether progress is browser-local,
   account-scoped, or derived from existing immutable evidence. No new store is approved yet.
6. **Public/private scope:** which levels, bowls, titles, and milestones may appear on the public paper page
   versus the authenticated desk.
7. **Mascot production sheet:** final name confirmation, geometry, poses, expressions, sizes, dark/light
   treatment, and static fallbacks.
8. **Copy matrix:** authoritative label plus whimsical companion copy for every open, reserved, settled,
   corrected, stale, unavailable, blocked, depleted, paper, and live state.
9. **Motion specification:** durations, easing, batching of large deltas, interruption behavior, reduced-motion
   behavior, sound prohibition/default, and performance budget.
10. **Noodle Party thresholds:** the exact learning milestones that permit celebration and tests proving funded
    outcomes cannot trigger it.
11. **Noodle Scale interaction:** evidence-card provenance, saved drafts, accessibility, and the hard terminal
    boundary before any paper experiment workflow.
12. **Evaluation:** accessibility review, comprehension testing, and a specific check that users do not confuse
    noodles with rewards, symbolic bowl fullness with exact money, paper with live, or research readiness with
    permission to trade.

After these are resolved and approved in prose, this design can be translated into product requirements in
`SPEC.md`, including a decision-log entry. Only then should implementation begin.
