# ADR-0003 — Current status projection and immutable archives

> **Status:** Accepted · **Date:** 2026-08-26
> **Decision index:** [`../decision-log.md`](../decision-log.md)
> **Specification root:** [`../../SPEC.md`](../../SPEC.md)
> **Status index:** [`../../status/README.md`](../../status/README.md)

## Context

`STATUS.md` had grown to 34,588 words and 258,612 bytes across 2,905 lines. It mixed the latest operational
snapshot, current implementation, dated delivery entries, superseded measurements, a current priority list, and a
long historical roadmap. Agents had to load historical implementation detail to answer a current-state question,
and the same file acted as status projection, roadmap, and archive.

The history remains useful. In particular, it exposes when a claim was measured, when an implementation changed,
and which conclusions were later withdrawn. Deleting it or relying only on Git history would make those corrections
harder to discover. Leaving it in the always-read root would continue to increase context cost and stale-state risk.

## Decision

Keep [`STATUS.md`](../../STATUS.md) as a compact, dated **current implementation projection**. It contains current
capabilities and identities, latest bounded measurements with dates/sample sizes/caveats, held boundaries, and a
prominent warning that authenticated runtime control—not Markdown—owns funded operational state.

Separate the other concerns:

- [`../../status/roadmap.md`](../../status/roadmap.md) owns non-normative sequencing and pending work;
- [`../../status/README.md`](../../status/README.md) owns reading order, maintenance rules, and archive discovery;
- `status/archive/*.md` preserves superseded status and roadmap text in immutable bounded fragments.

The initial archive was created before replacing the root. Its three fragments concatenate to the former
`STATUS.md` byte for byte. Their individual hashes, sizes, line counts, word counts, order, and combined hash are
checked by `npm run verify:status`. Archive text is never edited to fix a stale claim or link; corrections are new
current status, reports, decisions, or archives.

Root status is capped at 3,000 words / 30 KiB. The current roadmap is capped at 5,000 words / 50 KiB. Each archive
is capped at 15,000 words / 120 KiB. Agents read archives only for a historical question, not as part of ordinary
orientation.

Authority remains separated:

- specifications define what must be true;
- code and versioned registries define current behavior;
- root status projects what is implemented and most recently measured;
- the roadmap orders pending work without authorizing it;
- reports own dated quantitative methods and conclusions; and
- authenticated control state owns present funded operation.

## Consequences

- Current orientation drops from 34,588 status words to a bounded projection.
- Historical claims, corrections, and delivery records remain discoverable and cryptographically pinned.
- Roadmap edits no longer make historical implementation prose appear current.
- A stale status snapshot cannot be mistaken for live permission, cash, exposure, reconciliation readiness, or
  restart safety.
- Maintainers must replace stale root text instead of appending a diary and must create a new archive before
  removing unique historical wording.
- Original relative links in the immutable initial fragments are resolved from repository root by policy and the
  verifier because changing them would break byte preservation.

## Alternatives considered

### Delete historical status and rely on Git

Rejected because withdrawn findings and dated operational evidence would become difficult for agents and operators
to discover without knowing the relevant commit.

### Keep one append-only `STATUS.md`

Rejected because current state, roadmap, and history have different authority and reading frequency. The file had
already exceeded a practical agent-context boundary.

### Rewrite history into summaries

Rejected as the only archive because condensation can accidentally erase caveats, disagreements, and explicit
non-changes. Compact current status is useful only when the exact historical source remains available.

### Archive one 258 KiB snapshot

Rejected because bounded fragments are cheaper to inspect and verify while still reproducing the complete source.
