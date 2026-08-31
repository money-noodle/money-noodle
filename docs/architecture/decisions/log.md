# Decision log

The default home for a decision. One line each: date, what was chosen, and why. No template, no status, no ceremony.

A line here is a real decision and may be relied on. It is also cheap to change: edit or strike the line. Promote an entry to its own record in [`README.md`](README.md) only when the promotion rule in [`../../README.md`](../../README.md) is met — expensive to reverse, a real alternative was weighed, or it constrains money, authorization, tenant isolation, or audit.

Newest first. Keep entries to one or two sentences. If an entry needs a paragraph, it probably belongs in the living design document for its area; if it needs a page, it probably belongs in a record.

## 2026

- **2026-08-30** — Agent coordination uses remote claim isolation, fail-closed planning, remotely verifiable lifecycle and scope evidence, and per-decision durability; see [`ADR-0011`](ADR-0011-agent-coordination-and-isolation-protocol.md).
- **2026-08-30** — Free-tier and quota headroom is a derived figure, computed from Cloud Monitoring usage against the dated limits in `../../operations/deployment-composition.md`, because the provider exposes no clean free-tier-consumption API. Labeled as derived wherever it appears; weaker evidence than reported spend.
- **2026-08-30** — `.gitignore` ignores `.claude/*` rather than `.claude/`, because excluding the directory itself makes any later negation unreachable and a shared project settings file should stay committable.
- **2026-08-30** — Decision weight is tiered and decisions stay editable until proven; see the lifecycle in [`README.md`](README.md). Prompted by reversing an accepted-but-unbuilt provider choice one day after accepting it, which cost more ceremony than the choice itself was worth.
- **2026-08-29** — Credits are excluded from the budget guardrail (`EXCLUDE_ALL_CREDITS`) so a promotional credit cannot mask real spend approaching the ceiling.
- **2026-08-29** — The budget notifies and does not disable billing, because an automatic shutdown would turn a cost surprise into an outage.
- **2026-08-29** — Cloud Run domain mappings are not used; custom domains go through the load balancer with serverless network endpoint groups, because the provider documents domain mappings as preview stage and not production-ready.
