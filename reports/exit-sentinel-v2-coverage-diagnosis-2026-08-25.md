# Exit-sentinel v2 coverage diagnosis — 2026-08-25

> **Finding:** the published 68.0% live / 69.2% paper completeness is primarily a denominator defect, not public-
> evidence availability. V2 classifies maintenance cycles at or after contract close as unavailable exit-evaluation
> opportunities while waiting for settlement. An exit cannot execute after close, and delayed outcome publication
> can add many such false misses. Published coverage and every `reviewUnlocked` flag remain unchanged pending an
> approved measurement-semantics repair; no exit or funded behavior changes.

## Question and reproducible method

Why did the prospective exit-v2 report remain far below its 90% complete-path requirement, and will simply waiting
produce promotion-grade evidence?

The read-only analyzer added for this diagnosis reruns:

```bash
npm run analyze:exit-sentinel-coverage
```

It replays the immutable v2 snapshot and 6,333 journal events through the store's pure event reducer, checks all
102 durable sentinel/order links, and scopes to the active v22, live-v7, and paper-v6 identities. The fixed read was
generated at **2026-08-25T16:37:09.100Z**. It classifies cycles against each exact UTC `closesAt`; it does not edit
the journal or alter the published report.

The deciding diagnostic is mechanical: recalculate path completeness after excluding only cycles whose timestamp
is at or after exact contract close. Genuine pre-close unavailable cycles and missing paper trigger-time book
evidence remain disqualifying. This counterfactual has no promotion authority.

The caveat that most threatens interpretation is that this diagnosis cannot reconstruct a public quote that was
never returned. It identifies when the evaluator could not possibly execute, not why each genuine pre-close quote
was unavailable.

## 1. Published coverage

| Track | Resolved positions | Published complete | Published coverage |
| --- | ---: | ---: | ---: |
| Live | 50 | 34 | **68.00%** |
| Paper | 52 | 36 | **69.23%** |

There were zero missing order links and zero invalid active sentinels. All incompleteness came from the explicit
cycle-coverage or paper trigger-evidence rules, not identity corruption.

## 2. Most unavailable cycles occurred after execution was impossible

| Cycle class | Live | Paper |
| --- | ---: | ---: |
| All classified cycles | 1,649 | 1,484 |
| Pre-close cycles | 1,529 | 1,393 |
| Pre-close observed | 1,508 | 1,371 |
| Pre-close unavailable | 21 | 22 |
| At/after-close cycles | 120 | 91 |
| At/after-close observed | 0 | 0 |
| At/after-close unavailable | **120** | **91** |
| Aggregate pre-close observation rate | **98.63%** | **98.42%** |

The aggregate observer was therefore above 98% while the position-level report showed roughly 69% completeness.
The disagreement comes from post-close cycles being assigned to individual positions, where one false miss can
push a short late-opened path below 90%.

The implementation explains the pattern. `maintainExitPolicySentinels` first appends an `evaluation-cycle` for
every unresolved sentinel without checking whether `cycle.observedAt < sentinel.closesAt`. It only afterward
identifies due positions, fetches a missing outcome, and appends resolution. `exitSentinelPathComplete` then counts
every cycle in its observed/total ratio without a close bound.

At/after close, the dashboard has generally advanced to the next contract, so no matching lifecycle observation
exists. If settlement is delayed, each maintenance pass adds another unavailable cycle. The maximum observed case
waited 343.204 seconds and accumulated 23 false unavailable cycles. This makes completeness depend on settlement
publication latency and how early the position opened—neither is candidate observation coverage.

## 3. Mechanical correction isolates the genuine gaps

Keeping every pre-close unavailable cycle and every paper trigger-depth requirement, but removing post-close
non-opportunities from the denominator, gives:

| Track | Complete | Coverage | Published incompletes repaired mechanically | Genuine remaining incompletes |
| --- | ---: | ---: | ---: | ---: |
| Live | 48 / 50 | **96.00%** | 14 / 16 | 2 |
| Paper | 47 / 52 | **90.38%** | 11 / 16 | 5 |

This is not a revised official result. It proves that continuing unchanged does not measure the intended gate:
future late fills will predictably fail when one post-close cycle is a large share of their short path, and a slow
settlement can invalidate even a long, fully observed path.

## 4. Genuine incomplete paths remain explicit

### Live

- `DOGE UP 2026-08-25T11:15Z`: 15/17 pre-close cycles observed (88.24%); two internal public-evidence gaps remain.
- `DOGE DOWN 2026-08-25T11:45Z`: zero pre-close evaluator cycles. The position opened at 11:43:06Z, but the
  sentinel was first recorded and resolved at 11:47:32Z, after close. This is a real enrolment/worker-availability
  gap, not repairable history.

### Paper

- `SOL UP 2026-08-24T19:15Z`: 6/7 pre-close cycles observed.
- `BTC UP 2026-08-25T01:45Z`: 9/12 pre-close cycles observed.
- `ETH DOWN 2026-08-25T05:00Z`: 6/8 pre-close cycles observed.
- `BNB DOWN episode 2 2026-08-25T05:00Z`: 2/4 pre-close cycles observed.
- `SOL UP episode 2 2026-08-25T03:30Z`: all 41 pre-close cycles were observed, but the
  `trailing-50-35-v1` trigger lacked complete exact public-book IOC evidence. V2 correctly keeps this path
  incomplete.

The final pre-close quote gaps cluster near contract close and across matching live/paper contracts in several
windows. They are genuine unavailable evidence and should never be converted to observations or fills.

## 5. Effect on economic review

This diagnosis does not score the mechanically recovered positions or recompute candidate economics. Doing so
before approving the correction would let a reporting defect silently change an efficacy cohort after outcomes
were known. The official report remains:

- live: 34 complete positions / 30 windows;
- paper: 36 complete positions / 31 windows;
- every candidate `reviewUnlocked: false`.

Even the mechanical coverage view remains below the separate 60-window and 20-divergent-window requirements, so
correcting this defect would not immediately authorize review or production change.

## 6. Repair options requiring approval

### Option A — correct v2 opportunity semantics

Amend v2 so an evaluation opportunity is classified only when:

```text
positionOpenedAt <= cycle.at < closesAt
```

Implementation would:

1. stop appending future evaluation-cycle events at or after close;
2. defensively filter historical at/after-close cycles from the pure coverage denominator without rewriting the
   append-only journal;
3. retain all pre-close unavailable cycles;
4. retain paper trigger-time missing-book incompleteness;
5. retain late/missing enrolment as incomplete;
6. add tests proving outcome-resolution delay cannot alter coverage; and
7. keep all review and promotion locks unchanged.

This matches the approved design's “actual evaluator opportunities” language and repairs a measurement invariant,
not an economic threshold. Because it raises historical v2 coverage after outcomes are visible, it still requires
an explicit written amendment and review before code.

### Option B — start a new evidence generation

Leave v2 reporting unchanged, implement the same close-bounded semantics as v3, and reset prospective evidence.
This is maximally conservative against retrospective cohort changes but discards 98%+ valid pre-close observation
coverage and delays the 60-window review. Candidate rules would remain frozen.

### Option C — continue unchanged

This preserves implementation history but does not satisfy the intended opportunity semantics: settlement delay
and late entry continue deciding completeness. More rows may numerically raise aggregate coverage, but the cohort
remains selected by non-executable post-close events.

## Decision boundary

The diagnosis is complete. No store, report, candidate, exit, order, capital, control, or runtime behavior changed.
The next step is maintainer agreement on Option A or B, followed by a design amendment before implementation.
Nothing here is financial advice.
