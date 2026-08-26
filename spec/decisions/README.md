# Specification decisions

Start with [`../decision-log.md`](../decision-log.md). It indexes the current decision ledger, immutable archives,
and architecture decision records. Detailed requirements remain in the canonical domain modules selected through
[`../../SPEC.md`](../../SPEC.md).

## Conventions

- `ADR-NNNN-<slug>.md` records one load-bearing cross-domain decision: context, decision, consequences, and
  alternatives.
- Every ordinary decision has a permanent `DEC-YYYYMMDD-NN` identifier. Current rows publish it directly.
  [`decision-id-map.json`](decision-id-map.json) binds immutable archived rows to IDs by source, ordinal, and
  SHA-256 without rewriting history. Search the map by ID to locate the exact row.
- `YYYY-MM-DD-to-DD.md` files are immutable chronological archives. They preserve historical decision text and
  order; a new decision supersedes an old one.
- An ADR explains why. It does not replace or silently override the canonical requirement module.
- Archive entries may cite superseded behavior. Consult current requirements and `STATUS.md` before acting.
