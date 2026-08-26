# ADR-0004 — Verified agent guidance and module-qualified citation

> **Status:** Accepted · **Date:** 2026-08-26
> **Decision index:** [`../decision-log.md`](../decision-log.md)
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)
> **Agent guide:** [`../../AGENTS.md`](../../AGENTS.md)

## Context

Three verifiers already guarded the specification, design index, and status records, and CI ran them ahead of
typecheck, lint, and test. None of them read [`../../AGENTS.md`](../../AGENTS.md), which is loaded into every
session, and both `verify:spec` and `verify:docs` skipped `README.md` by name.

The gap produced a real defect. The `§0` orientation table pointed at `lib/target-exit-policy.ts` for reduce-only
IOC exits. That module was deleted when the long-shot strategy was retired, so every session since had been told
to look for a file that does not exist, in the one table whose purpose is to stop an agent hunting through
`lib/`. A hand audit of the rest of the file found its other 27 paths and 25 symbols accurate, which is the
argument for a machine check rather than for periodic re-reading.

`README.md` had a second, quieter version of the same problem. It carried roughly 1,900 words of present-tense
implementation claims — policy constants, reconciliation cadence, exit mechanics, switching thresholds — while
appearing in neither authority table and under no size cap or gate. It was the only implementation-truth surface
in the repository with no stated rank, competing with `STATUS.md` for the same job.

Section numbering carried a related hazard. Numbers were inherited from the pre-modularization monolith and are
not unique across modules: three modules open at §3, `trading-risk-and-budget` runs §3 then §7, and §3.6 and
§3.6a are in different files. Every citation in the corpus already named its module, so the convention existed
but was unenforced and undocumented.

A fourth issue surfaced while wiring the gate. Four documents linked targets by absolute filesystem path. Those
resolve against the authoring machine, so they passed locally and failed in CI — the worst failure shape, because
the person who introduced the link never sees it break.

## Decision

Add `npm run verify:agents` (`scripts/verify-agents-guide.mjs`), run in CI beside the existing three. It governs
`AGENTS.md`, `README.md`, and `reports/README.md`, and checks that:

- every backticked repository path resolves, skipping globs and `<angle-bracket>` templates;
- every identifier cited beside a module path is **bound by that module** — exported, private, or imported. A
  pointer claims "look here", not "import this", so a module-private helper counts while a symbol that has moved
  to another file still fails;
- `AGENTS.md` stays under its 3,000-word cap, which was previously a request;
- local links and anchors resolve, and every report's own links resolve; and
- `reports/README.md` indexes every report exactly once.

Adopt module-qualified citation as a rule: a `spec/*.md` section number must name its module. The verifier rejects
an unqualified `§N` in the guidance it governs, checked per paragraph because the corpus hard-wraps.
[`../../SPEC.md`](../../SPEC.md) carries the legacy number-to-module redirect.

Reject absolute-path links in all four verifiers. The immutable `status/archive/` fragments keep their existing
exemption, which already skipped them.

Rank `README.md` explicitly as human orientation and setup — never requirement, implementation, or operational
authority — in both authority tables, and remove the current-behavior detail that duplicated `STATUS.md`.

Make `SPEC.md` canonical for document authority. `AGENTS.md` keeps a compressed restatement because it is always
loaded, and loses to `SPEC.md` on divergence; `status/README.md` drops its third copy and keeps only its
status-specific reading order.

Give every entry in [`../open-decisions.md`](../open-decisions.md) a permanent `OD-<n>` identifier, verified
unique and sequential, so a question can be cited and closed by name.

## Consequences

- A deleted or moved module cited by the always-loaded guide fails CI instead of misleading every later session.
- `AGENTS.md`'s word cap and `README.md`'s authority are enforced rather than requested.
- An absolute link fails on the author's machine, where it can be fixed, rather than only in CI.
- `reports/` gained a discovery index and link coverage; the index deliberately states what each report answers
  rather than restating results, because a measurement must travel with its date, sample size, and caveat.
- Section numbers stay as they are. They cannot be reassigned: 157 preserved decisions and the immutable status
  archives cite them and by rule cannot be edited.
- The verifier reads only explicit citation forms, so a bare identifier mentioned with no module is unverified,
  and the `§` rule is a per-paragraph heuristic rather than a parser. Both limits are recorded in the script.

## Alternatives considered

### Re-audit `AGENTS.md` by hand periodically

Rejected. The hand audit that found the defect also confirmed 52 other references were correct, so the failure
rate is low and the detection cost is high — exactly the profile a cheap machine check suits.

### Renumber each module from §1

Rejected. The 157 archived decisions and the immutable status fragments cite the current numbers and cannot be
updated, so renumbering would strand them citing a scheme that no longer exists. Qualification costs nothing
historically.

### Collapse the authority tables into `AGENTS.md`

Rejected because it inverts the stated hierarchy. `AGENTS.md` is explicitly "never alternate requirement
authority", so the canonical specification cannot depend on it to define authority. Consolidation went the other
way.

### Delete `README.md`'s "What works" entirely

Rejected. The durable product shape is genuine orientation for a human arriving at the repository. Only the
parameter-level claims that `STATUS.md` owns and that drift were removed.

### Require every open decision to state what would settle it

Rejected for now. Supplying missing settlement criteria is normative authoring and belongs to the maintainer;
inventing them under a documentation change would create requirements nobody agreed to. The identifiers and the
gap are recorded instead.
