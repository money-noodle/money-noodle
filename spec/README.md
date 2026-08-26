# Money Noodle specification modules

Start with [`../SPEC.md`](../SPEC.md). It is the stable entry point and the only authoritative specification
index. This folder contains detailed normative modules; this README deliberately does not duplicate that index.

## Module rules

- Each requirement has one canonical home. Link instead of copying it into another module.
- Read a relevant module completely before changing the behavior it governs.
- Keep current implementation and latest bounded measurements in [`../STATUS.md`](../STATUS.md), planning in
  [`../status/roadmap.md`](../status/roadmap.md), and immutable status history under [`../status/archive/`](../status/archive/), not here.
- Keep pre-implementation designs indexed by lifecycle in [`../docs/README.md`](../docs/README.md) and dated
  measurement reports in [`../reports/`](../reports/).
- Cite stable `req-<domain>-<name>` requirement IDs when available, otherwise named sections; never source lines.
  IDs are permanent and never reused even when wording moves.
- Keep dated implementation progress in `STATUS.md`, sequencing in `status/roadmap.md`, measurements in reports,
  and implementation rationale in designs/decisions. Canonical modules state durable required behavior.
- If canonical modules conflict, stop and resolve the conflict; do not guess which requirement wins.
- Record accepted requirement changes in [`decision-log.md`](decision-log.md). Cite ordinary decisions by their
  permanent `DEC-YYYYMMDD-NN` ID and use an ADR for a load-bearing, cross-domain decision without rewriting its
  historical ledger row.
- Run `npm run verify:spec` after changing the root, a module, a decision archive, or an ADR.
