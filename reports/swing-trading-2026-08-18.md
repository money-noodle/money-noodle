# Trading the swing, 2026-08-18 — the swing is real, capturing it is not

**No policy change is made or authorized by this.** It tests an operator premise directly: prices in a
15-minute contract move away from the 50¢ open, turn, and swing back, and a trader watching the app can buy
the dip and sell the recovery. The operator reports doing this manually with "a good percentage" of
successes.

**The percentage is real.** The swing happens 64–81% of the time. Selling into it still loses money in every
configuration measured, and the reasons are arithmetic rather than bad luck.

Reproduce with `npm run analyze:swing-exit`.

## Method and cohort

1,611 recorded windows of `crypto-15m` contract paths, both sides, sampled every fifteen seconds.
Settlement joined per window to the resolved forecast history. Returns averaged within a settlement window
before being averaged across windows, error over windows (AGENTS §5.1). Entries are the first qualifying
ask in the band with at least ten minutes left, one per contract and side; this is **not** a test of trading
repeatedly within a cycle.

## 1. The swing is real, and selling into it loses

Buy, wait for the owned-side bid to reach entry + X, sell there; otherwise hold to settlement. 2,835
positions:

| entry band | swing | hit rate | sell into swing | just hold | difference |
|---|---|---|---|---|---|
| 20–80¢ | +2¢ | **72.7%** | −0.248 ± 0.010 | −0.093 ± 0.008 | −0.156 |
| 20–80¢ | +5¢ | 67.9% | −0.242 ± 0.011 | −0.093 ± 0.008 | −0.150 |
| 60–80¢ | +2¢ | **81.3%** | −0.195 ± 0.013 | −0.045 ± 0.020 | −0.150 |
| 20–40¢ | +2¢ | 69.7% | −0.312 ± 0.022 | −0.169 ± 0.042 | −0.143 |

**A high hit rate and a negative expectancy are perfectly compatible**, and this is what that looks like: the
gain is capped at a few cents while the entire downside is retained. Four small wins do not pay for the
fifth loss. This is also why the pattern is so convincing to watch — the wins are frequent and the losses
are the ones that get held.

## 2. Trajectory looks predictive, and it is the spread

Forward 60-second move in the **mid**, by quintile of each trajectory feature. Two features show clean
monotone mean reversion — the more efficiently the price has trended, the more it retraces:

| feature | Q1 (low) | Q2 | Q3 | Q4 | Q5 (high) |
|---|---|---|---|---|---|
| slope over 120s | +1.148 | +0.809 | −0.289 | −0.659 | −1.069 |
| slope ÷ range (trend efficiency) | +1.486 | +0.673 | −0.076 | −0.230 | **−1.910** |

That is a ~3.4¢ spread between extremes, monotone across the whole row, on a measure this repo already
computes as `cycleRegime.trendEfficiency`.

**It does not survive contact with the book.** Trading the same signal — buy the side the reversion favours
at the ask, sell at the bid after a fixed hold — produces a *negative* gross move before fees are counted:

| threshold | hold | trades | gross move | net return per $1 |
|---|---|---|---|---|
| 0.7 | 60s | 10,866 | **−1.47¢** | −0.2415 ± 0.0167 |
| 0.9 | 300s | 2,182 | −2.09¢ | −0.2003 ± 0.0302 |

> **Corrected 2026-08-18, hours after publication.** The first version of this section concluded the
> reversion "was never a signal; it was the spread". **That is too strong and is withdrawn.** Measured on a
> single consistent price series rather than the mid, the reversion survives:
>
> | series | Q1−Q5 spread | t |
> |---|---|---|
> | mid | +3.277 ± 1.040 | 3.15 |
> | ask only | +2.893 ± 1.097 | 2.64 |
> | bid only | +3.695 ± 1.050 | 3.52 |
> | the spread itself | +1.473 ± 0.071 | **20.65** |
>
> About 1.5¢ of the mid effect is the spread oscillating — its own reversion is enormous — but **2–3¢ of
> genuine price reversion remains**. There is a real trajectory signal.

**It is real and smaller than the cost of taking it**, and the spread reversion above is why: the spread is
widest exactly when trend efficiency is extreme, so a taker enters at the worst moment available. A ~2¢
signal cannot cover a ~3.5¢ entry. That is a different conclusion from "no signal", and it points at
execution rather than at prediction — a cost you do not pay is a signal you might keep.

Any trajectory feature must still be reported in its traded form beside its observed one: the gap between
+3.3¢ observed and −1.5¢ traded is the entire practical content.

## 3. A stop helps, substantially, and does not rescue it

Buy, then walk the path and exit at whichever comes **first** — a target on the owned-side bid, or a stop.
Path order matters here and a peak/trough summary cannot supply it, so this reads the raw paths.

| target | stop | hit target | stopped | settled | return per $1 |
|---|---|---|---|---|---|
| +3¢ | none | 71% | 0% | 29% | −0.2018 ± 0.0102 |
| +3¢ | −3¢ | 30% | 66% | 4% | −0.0869 ± 0.0024 |
| +8¢ | −3¢ | 23% | 72% | 5% | **−0.0699 ± 0.0034** |
| +8¢ | none | 64% | 0% | 36% | −0.1934 ± 0.0113 |

**Selling when the swing reverses cuts the loss by roughly two thirds.** The operator's instinct was right,
and it corrects an earlier reading in §15b, where stops on a near-money hold appeared to *hurt*: that
measurement used the lowest bid of the whole remaining window with no ordering, so it fired the stop on
positions that had already reached their target. This one takes whichever came first.

**The spread makes a symmetric rule asymmetric.** At ±3¢ the target is hit 30% of the time and the stop 66%.
That is not variance: entry pays the ask and the position is marked against the bid, so a −3¢ stop sits
about 1.5¢ from the mark while a +3¢ target sits about 4.5¢ away. **The stop is roughly three times closer
before the market moves at all.** Any target/stop pair quoted against the entry price is tilted against the
trader by construction.

And every configuration still loses. The best is −0.0699 ± 0.0034 — twenty standard errors from zero.

## Why it loses, stated once

The direction is unpredictable (eighteen signal variants, all 48–50%, reported in
[maker-fill-adverse-selection-2026-08-18.md](maker-fill-adverse-selection-2026-08-18.md)),
and every round trip pays a toll of roughly 4¢ at mid prices even at a large ticket, 8¢ at the current
one. A bet with no edge, played against a toll, loses at the rate of the toll. Better exits change how fast.

## What this authorizes

Nothing. Three specific things are closed off:

- **Selling into the swing** loses to holding in every band and at every target size.
- **Trajectory as a directional signal** is bid-ask bounce and inverts when traded.
- **Target-and-stop pairs quoted against the entry price** are structurally tilted by the spread.

One thing is explicitly *not* closed: the toll is only a cost to the party who crosses the spread. The
bounded maker-fill experiment (§17, running since 2026-08-18) is testing whether it can be earned instead
of paid, which is the only avenue here whose arithmetic is not already against it.

## Caveats, worst first

- **Observations overlap** in the trajectory quintiles — the stride is shorter than the forward horizon, so
  neighbouring rows share outcomes. Window clustering absorbs some of that and not all, so those errors are
  optimistic. The monotonicity of a whole row is better evidence than any single cell.
- **Exits are priced optimistically**: a target or stop is assumed to fill exactly at its price, and
  fifteen-second sampling cannot see a touch between samples. Both flatter the exit rules, so the real
  results are worse than reported.
- One entry per contract and side. Trading repeatedly within a cycle would multiply the toll, not amortise
  it, but that is an inference from the fee model rather than a measurement here.
- Three days of one venue's `crypto-15m` market. No regime variety.
