# Adverse selection on resting quotes, 2026-08-18 — not detectable, and this cannot settle it

**No policy change is made or authorized by this.** It answers one question raised while assessing a
proposed volatility-trading strategy: when a patient order fills, is it an ordinary trade, or one about to
go against you?

Reproduce with `npm run analyze:maker-fills`.

## Why this is the question

Kalshi charges nothing on a resting fill and roughly `7% × p × (1−p)` on a taking one. That difference is
the entire economics of any frequent-trading strategy on this venue:

| ticket | round-trip movement needed to break even, taking, at 70¢ |
|---|---|
| 20¢ (current) | **8.14¢** (11.6%) |
| 100¢ | 5.23¢ |
| 500¢ | 4.08¢ |
| 2500¢ | 3.97¢ |

The floor never falls below about 4¢ because most of it is proportional, not a flat fee. Fees peak at 50¢,
so trading near the middle is the most expensive place on the board. Posting instead of taking removes the
fee entirely and collects the spread rather than paying it — so the only thing that can make patience
unprofitable is being filled *selectively*.

## Method and cohort

**1,611 recorded windows.** For every sampled moment on both sides, a hypothetical resting buy `d` cents
below the prevailing ask, `d ∈ {1, 2, 3}`, restricted to 15–85¢ where a maker would actually quote. A post
is treated as filled at the first later sample whose ask reaches it. Measured after the fill: the change in
mid over 15/30/60/120 seconds.

Observations are thinned to one per 60 seconds per side, so a single sustained move cannot contribute
dozens of near-identical rows, and drift is averaged within a settlement window before being averaged
across windows, with the standard error over windows (AGENTS §5.1).

**The control is the unconditional drift** over the same horizon from every observed sample. It is
deliberately *not* "orders that failed to fill": a resting buy fails to fill exactly when the price rises
and never comes back, so that group is selected on the outcome and reads about **+20¢** of drift at two
minutes. That was this file's first control and it was wrong; the artefact is recorded here because it is
an easy and convincing mistake.

## Result

| depth | horizon | fills | fill% | drift after fill | unconditional | adverse |
|---|---|---|---|---|---|---|
| 1¢ | 15s | 16,804 | 79% | +0.098 ± 0.161 | −0.005 ± 0.014 | +0.104 |
| 1¢ | 30s | 16,553 | 79% | −0.042 ± 0.234 | +0.034 ± 0.036 | −0.076 |
| 1¢ | 60s | 16,161 | 79% | +0.210 ± 0.478 | −0.036 ± 0.022 | +0.247 |
| 1¢ | 120s | 15,420 | 79% | −0.082 ± 0.539 | −0.030 ± 0.023 | −0.051 |
| 2¢ | 30s | 16,109 | 77% | −0.080 ± 0.239 | +0.034 ± 0.036 | −0.114 |
| 3¢ | 60s | 15,273 | 75% | +0.276 ± 0.508 | −0.036 ± 0.022 | +0.312 |

**Every drift figure is indistinguishable from zero**, across three depths and four horizons on 15,000–17,000
fills. The mid does not systematically move against a resting buy after it fills, and the unconditional
control sits at zero as a price series should.

Fill rates are high — 75–79% of posts are reached within the window.

## What this does and does not establish

**It does not establish that market making works here, and it cannot.** The mechanism that produces adverse
selection is queue position: a resting order at the back of the queue fills on a sweep through the price and
is passed over on a brief touch, and sweeps are exactly the adverse case. This measurement treats a post as
filled the moment the ask *touches* it, which cannot distinguish a one-tick touch from a sweep. **At
fifteen-second sampling that distinction is invisible in principle**, not merely unmeasured.

So the honest reading is **"no evidence of adverse selection"**, not "evidence of no adverse selection" —
and the optimistic fill model biases toward the former.

Two further limits:

- **A round trip needs two fills.** This measures entry only. Whether a resting *exit* fills before the
  price leaves is a separate question, and the earlier long-shot measurement is a warning: a resting bid
  below the entry mark filled 92% of the time while the touch rate collapsed from 8.2% to 2.2%. That
  cohort was cheap sides in free-fall, which is not this cohort, but it is the same failure mode.
- **Fifteen-second sampling cannot see a fill and reversion inside one interval.** The 1s dense windows are
  not a usable check: dense recording only begins once a side has already fallen below the long-shot entry
  mark, so that sample is conditioned on the very move being measured.

## What would settle it

Recording **depth at and around the posted price over time**, which the contract-path recorder does not
carry. Order-level observations already capture `bestBidDepth`, `bestAskDepth`, and `depthImbalance`, so
the venue exposes what is needed; it is a collection change, not a data-availability problem. With queue
depth, a fill can be classified as touch or sweep and the question becomes directly answerable.

Until then, a market-making strategy on this venue rests on an untested assumption, and the assumption is
the one that decides it.

## What prompted this, recorded so the bias is on the record

An operator proposal to trade intra-cycle volatility: enter on a direction change far from the 50¢ open,
exit on a profitable excursion, several times per cycle. Two findings preceded this one and both bear on it:

- **The direction-change signal is a coin flip.** Eighteen configurations of the rule on the unbiased
  fifteen-second data, 1,200–2,000 signals each, all land between 48.3% and 50.5% with intervals of
  ±2.2–2.8pp. Every interval includes 50%.
- A dramatic-looking result on the 1s data (19–47%) was **discarded**, not reported as a finding: dense
  sampling begins only after a side collapses below the entry mark, so the sample is conditioned on a large
  directional move having already happened, and overlapping signals narrow the interval falsely.

The taking economics above and the coin-flip signal together mean the proposal as described cannot work.
The patient-execution variant is the part that survives, and this report is why it is not yet dismissible.
