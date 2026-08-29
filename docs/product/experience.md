# Product experience standard

## Current product direction

Money Noodle helps people pursue wealth and build knowledge about wealth through an entertaining, immersive experience. Funded trading is foundational alongside information, exploration, discovery, learning, simulation, casual play, idle progression, and MMO-style world interaction.

These are continuous user intents, not disconnected product modes. **Capability and risk profiles** determine what a person may do while preserving continuity across web, mobile, desktop, game, and world interfaces.

The platform must not promise wealth or returns. It should be deeply engaging without exploitative or compulsive financial design: no dark patterns, loss chasing, concealed risk, or rewards whose purpose is to push a person toward greater financial exposure.

## Funded, simulated, and age-sensitive access

Funded trading is an architectural core but is not available to every person or interaction. Simulation and funded balances, ledgers, execution authority, presentation, and audit records remain structurally separate and unmistakable.

Minors default to simulation-only. Any future custodial funded capability requires accepted legal, identity, consent, ownership, authorization, loss-control, and reporting design. Adults may choose restrictive capability/risk profiles; eligibility never forces higher risk.

Casual or passive interaction does not weaken authorization, risk, confirmation, stop-control, reconciliation, or audit requirements. Autonomous funded activity requires explicit prior authorization, bounded scope, expiry, budgets and loss limits, revocation, notification, and server-side stop controls.

## Offline experience

Every front end exposes a clear offline state and data freshness. Cached exploration and safe local world interactions may remain available; unavailable capabilities are visibly disabled.

Do not impose one blanket rule on offline commands. Classify each capability by authority, reversibility, staleness sensitivity, and financial risk. An offline-originated funded command requires its own accepted design covering durable local intent, expiration, visible queued state, cancellation, idempotent synchronization, fresh server-side identity/authorization/market/risk revalidation, deterministic conflict behavior, and an unambiguous distinction between queued and executed work. Previously authorized server automation may continue under its own limits and stop controls.

## Whimsy and clarity

Whimsy is a guiding product principle. User-facing experiences should be inviting, lively, concise, family-friendly in presentation, and rewarding to understand—not technical, dull, or tedious. Use progressive disclosure so the lay of the land is immediate and precise detail remains available.

Maintain three vocabulary layers:

1. **Experience language:** playful terms in copy, learning, progression, and game presentation.
2. **Canonical domain language:** precise finance, trading, probability, risk, accounting, resource, and authorization concepts.
3. **Implementation/provider language:** industry-standard engineering terms, with external provider vocabulary isolated in adapters.

Code, APIs, schemas, events, services, jobs, infrastructure, logs, metrics, and tests use canonical industry/domain language consistently across every project. Presentation maps canonical concepts to approved experience language. Money Noodle experience terms span every project plus web, mobile, desktop, game, and MMO interfaces so the same concept does not acquire conflicting names.

Whimsical terms may represent funded activities, but never obscure probability, uncertainty, exposure, fees, liquidity, ownership, constraints, wins, losses, or whether real money is at risk. Administrative surfaces use canonical domain terminology by default; they may use an approved Money Noodle term when it is more accurate in product context and cannot confuse the operation or financial meaning.

[`glossary.md`](glossary.md) is the canonical bridge. Update it in the same change that introduces, changes, deprecates, or removes an experience term. Whether every term needs an immediate inline plain-language definition remains a product-design decision; accurate meaning must always be readily discoverable. Localization guidance is deferred until localization becomes a current requirement.
