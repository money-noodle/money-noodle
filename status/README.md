# Status index and archive policy

`STATUS.md` is the compact, dated projection of what Money Noodle currently implements and most recently measured.
It is not a live control surface, a specification, a roadmap, or a chronological delivery log.

## Authority and reading order

1. Read [`../SPEC.md`](../SPEC.md) and every relevant canonical `spec/*.md` module for requirements.
2. Read [`../STATUS.md`](../STATUS.md) for current implementation and the latest bounded measurements.
3. Read [`roadmap.md`](roadmap.md) only when planning or evaluating pending work.
4. Read an archive only when the question depends on historical implementation state or superseded measurements.
5. Verify current behavior in code and versioned registries. Verify funded operational state through the authenticated
   Automation surface and `data/trading-control.json`, never through Markdown.

[`../SPEC.md`](../SPEC.md) holds the canonical authority table for every document class; consult it rather than a
restatement. The one rule this index adds: status text cannot create a requirement or authorize an implementation.

## Current files

| File | Purpose |
| --- | --- |
| [`../STATUS.md`](../STATUS.md) | Current implementation projection, active identities, latest bounded evidence, and material caveats |
| [`roadmap.md`](roadmap.md) | Current sequencing and pending work; non-normative and subordinate to canonical specifications |
| [`archive/`](archive/) | Immutable source fragments from the former append-only root status |

## Immutable initial archive

The 2026-08-26 migration split the former 2,905-line `STATUS.md` into three bounded fragments before replacing the
root. Concatenating these files in table order reproduces the original **byte for byte**, SHA-256
`be7d8ed9b721fb9a72f212d0091950c6bbb22c2f6b927c6be8094e8b100afdf0`.

| Archive fragment | Original lines | Words | SHA-256 |
| --- | ---: | ---: | --- |
| [`implementation-record-2026-08-20-to-26.md`](archive/implementation-record-2026-08-20-to-26.md) | 1–1,181 | 14,118 | `bac566b1240235d27b725b4a52c69a2259b3cc927696f0aab0a29b18a4931a0a` |
| [`policy-and-evidence-record-2026-08-17-to-22.md`](archive/policy-and-evidence-record-2026-08-17-to-22.md) | 1,182–2,461 | 14,837 | `8c3d229ec11083df5aede2d4b913ef5e509ca02245ee1cbdbd8ce713f40abb38` |
| [`roadmap-record-through-2026-08-26.md`](archive/roadmap-record-through-2026-08-26.md) | 2,462–2,905 | 5,633 | `73a347f512f6c357fc0ef49edf3b90e506ae1f724ea5bfbc436144c31ecf9a6f` |

The fragments intentionally retain their original heading levels and repository-root-relative links. Resolve links
inside them as if the text still lived at repository root; the verifier applies that rule. Do not repair wording,
links, dates, or stale claims inside these immutable files. Add a correction to current status, a dated report, or a
new archive instead.

## Maintenance rules

- Keep root `STATUS.md` below 3,000 words and 30 KiB. Replace stale projections; do not append a delivery diary.
- Keep its projection-critical source fingerprint current after reviewing changes to the source owners selected by
  `scripts/verify-status-structure.mjs`; the fingerprint detects bounded drift but does not prove all prose current.
- Keep `status/roadmap.md` below 5,000 words and 50 KiB. It describes sequencing, not requirements or acceptance.
- Give every quantitative root-status claim a date, sample size, and material caveat, normally by linking its report.
- Move superseded status prose into a new immutable archive before removing it when its exact historical wording is
  not already preserved elsewhere. Keep each archive below 15,000 words and 120 KiB.
- Never edit an indexed immutable archive. A correction is a new document that names the affected archive.
- Update root status when implementation truth changes. Update the roadmap when sequencing changes. Update the
  canonical spec and decision log when a requirement or accepted decision changes.
- Run `npm run verify:status` after any change under `status/` or to `STATUS.md`.
