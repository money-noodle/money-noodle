# XRP exclusion review — 2026-08-20

> **Finding:** the evidence that originally created the XRP blocker reproduces exactly, but it belongs to
> retired entry policies and execution. Under the current v21 signal rule, XRP is approximately flat rather
> than severely negative, with uncertainty too wide to establish either harm or value. Removing the blocker
> is therefore not evidence-promoted; keeping it is also an extrapolation from a retired cohort.
>
> **Policy decision:** none. XRP remains withheld from the edge policy at this read.

## Inputs and method

Recalculated at **2026-08-20T00:01:37Z** from **2,730 order rows and 65,854 resolved forecast rows** with:

```bash
npm run analyze:xrp-exclusion
```

The script measures three different questions and does not blend them:

1. exact realized and held-to-settlement return for historical filled XRP orders;
2. current-v21 first-to-fire XRP signals reconstructed under two qualifying snapshots over 15 seconds,
   priced at the recorded ask and held to exact venue settlement; and
3. exact XRP candidates prospectively captured in `portfolio-choice-set-v1` records.

Returns are averaged inside settlement timestamps before standard errors. The current-v21 reconstruction
scores every first-to-fire position, not fills. A gap above 30 seconds resets reconstructed persistence.

The largest caveat is execution transfer: v21 XRP has **no executed cohort**, because the blocker prevents
one. Its current result is ask-priced and omits portfolio capacity, maker selection, v5 requalification,
and exits. Forecast history keeps every qualified snapshot but only bounded nonqualifying snapshots, so an
omitted failure within 30 seconds could falsely preserve a reconstructed streak. The v21 read spans only
**2026-08-19T00:42Z–23:57Z**, less than one day despite crossing two UTC dates.

## 1. The original blocker evidence reproduces

| historical track | realized rows / windows | clustered realized return | exact stake | exact/whole-cent P&L | aggregate ROI |
| --- | ---: | ---: | ---: | ---: | ---: |
| live | 41 / 41 | **−45.7% ±21.5** | 531.93¢ | −93.34¢ | −17.5% |
| paper | 85 / 81 | **−35.1% ±13.0** | 2,270¢ | −235.35¢ | −10.4% |

These are the figures embedded in `src/lib/asset-exclusion.ts`; both means remain more than two standard errors
below zero. Equal-window return and aggregate ROI answer different questions, so their levels should not be
made to agree.

The fully held subset is worse: live **−69.0% ±17.6 over 37 resolved positions/windows** and paper
**−61.8% ±11.4 over 71**. Exits helped rather than manufactured the original negative finding.

But all of these fills ran from 2026-08-09 through 2026-08-13 under legacy through v13/v14 rules. They do not
contain v21's wider edge admission, two-snapshot persistence, 30¢ ordinary ticket, high-edge route, or v5
entry episodes. The result establishes what happened; it does not establish what current XRP execution
would do.

## 2. Current v21 XRP does not reproduce the severe loss

First-to-fire, ask-priced, held-to-settlement results:

| cohort | decisions / settlement windows | wins | clustered return |
| --- | ---: | ---: | ---: |
| XRP | 59 / 59 | 33 | **+1.0% ±12.5** |
| non-XRP | 364 / 83 | — | **+9.7% ±5.9** |
| XRP minus same-window non-XRP mean | 58 / 58 | — | **−12.1pp ±12.8** |

XRP is not significantly negative and its paired underperformance is less than one standard error. It is
also not established as profitable. The current model claimed a mean 3.6pp net edge on these XRP decisions,
but realized ask return was approximately zero.

Sizing limits the first-generation capital consequence: **58 of 59** current XRP decisions were below 30pp
and would receive the 30% ticket; those returned **+2.7% ±12.6**. The only 30pp+ XRP decision lost. One row
cannot evaluate the fresh-quote taker route.

A materially different, longer-history formulation points the other way. Re-running `npm run
analyze:edge-gates` at 2026-08-20T00:00:57Z found retired-v17-style XRP signals at **+17.1%**, with a 95%
clustered interval of **+7.7% to +26.5% over 1,545 rows / 391 windows**. That replay uses the retired 5–35pp
gate, does not reproduce current persistence or portfolio selection, and is fill-optimistic. It shows that
XRP's model signal has not been uniformly bad; it does not overturn the executed loss.

## 3. Prospective decision-time evidence is too small and shows no blocked order

`portfolio-choice-set-v1` contained **17 issued-order records**, with four XRP rows representing **three
unique resolved XRP candidates**. One candidate had completed persistence; it lost at the ask, but the
production portfolio had independently blocked it for **−8.32¢ correlation-adjusted expected
contribution**. The other two had only one of two persistence snapshots.

Therefore removing only the asset gate would have changed **zero recorded portfolio selections** in this
sample. This is useful wiring evidence, not an economic estimate: the journal is conditional on another
production order causing a choice set to be recorded and has only one eligible XRP candidate.

## 4. Assessment and options

Findings:

- The blocker was not based on a calculation error; its old live and paper evidence reproduces.
- The old evidence is not current-policy evidence.
- Current v21 signal evidence rejects the description “XRP remains a demonstrated severe loser,” but does
  not show positive return or executable value.
- The exact prospective record has not yet observed an XRP order that asset admission alone prevented.
- Removing XRP would change the shared buy policy for live and paper, require a new buy-policy version and
  immutable manifest history, and restart policy-scoped adaptive-regime warm-up.

Options:

1. **Keep the blocker:** strongest continuity with executed evidence, but explicitly acknowledge that it is
   extrapolated from retired policies.
2. **Collect a current execution candidate:** add a prospective XRP managed-maker simulation/sentinel that
   cannot reserve money, then review actual current-rule opportunities by independent window.
3. **Operator-directed bounded removal:** admit XRP on both tracks under a new buy-policy version, retain
   0.3× sizing below 30pp and every existing account cap, and record that the deployment is an experiment on
   null current evidence rather than a promotion.

The analysis does not authorize one option automatically. If the maintainer directs removal despite the
uncertainty, the honest basis is option 3—not a claim that XRP is now proven profitable.
