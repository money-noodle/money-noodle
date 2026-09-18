# Provider-disabled delivery control adapters

These modules implement the M1 delivery identity and evidence contracts as
executable, testable code. **Nothing here is enabled.** There is no provider
call, no host change, no journal ref, no witness issue and no credential. The
`operation-journal-v1` branch and the designated witness issue named in the
catalog do not exist and are not created by this code.

What these adapters give the repository today is the ability to fail a test when
the rules are broken, instead of only the ability to read that they exist.

| Module | Responsibility |
| --- | --- |
| [`canonical-json.mjs`](canonical-json.mjs) | RFC 8785 canonicalisation and the SHA-256 digests every identity is derived from. Refuses values it cannot encode exactly. |
| [`catalog-v2.mjs`](catalog-v2.mjs) | The typed transcription of the accepted catalog: rows, classes, slots, bounds, event vocabulary and the federation conjunction. |
| [`refusals.mjs`](refusals.mjs) | Stable refusal codes, each naming the owning document and section that refuses. |
| [`grant.mjs`](grant.mjs) | The grant check. Denies missing, expired, replayed, self-issued and wrong-scope requests before any token exchange. |
| [`journal.mjs`](journal.mjs) | The append-only sanitised evidence record: immutable events, strictly increasing sequence, sole-parent fast-forward, atomic snapshots, owner exclusion. |
| [`witness.mjs`](witness.mjs) | The separately permissioned corroboration writer and the nonrecursive intent/acknowledgment transition. |
| [`sanitize.mjs`](sanitize.mjs) | Output allowlisting. Refuses tokens, provider payloads and digests of low-entropy identifiers, including on the refusal path. |
| [`execution-identities.mjs`](execution-identities.mjs) | The named execution identity that owns each declared `infra/**` resource operation, with its permission justification. |

## Why they cannot reach a provider

Not by convention, by construction. No module here imports `node:http`,
`node:https`, `node:net`, `node:child_process` or calls `fetch`, and
[`../delivery-control-policy.test.mjs`](../delivery-control-policy.test.mjs)
asserts that. `grant.mjs` returns a verdict; it has nothing to return a
credential from. A `Witness` holds no journal and exposes no append method, so
the `contents:read` + `issues:write` ceiling is a property of the type rather
than of the caller's discipline.

No module prints. Evidence is returned to a caller that decides what to do with
it, which is what keeps a payload out of a public Actions log.

## Owning documents

These adapters implement, and do not extend, the following. Where this code and
those documents disagree, the documents win and the code is wrong.

- [Catalog v2](../../docs/operations/production-control-plane.md#m1-catalog-v2--selected-not-enabled) — effects, slots, consent binding, journal schema, witness transitions, faults and custody.
- [ADR-0005](../../docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md) — federation conjunction, identity separation, artifact trust and secret custody.
- [ADR-0006](../../docs/architecture/decisions/ADR-0006-infrastructure-as-code-and-remote-state.md) — stack separation and state ownership.
- [Delivery](../../docs/operations/delivery.md#current-to-target-activation) — staged activation and first-release exposure order.

## Running the checks

```sh
node --test tools/delivery-control-policy.test.mjs   # adapter behaviour
node --test tools/infra-delivery-policy.test.mjs     # identity ownership over infra/**
```

Both also run inside `pnpm check` through `pnpm verify:foundation`, and the
delivery workflow runs them in its credential-free `checks` job.

## What is deliberately not here

- Any provider call, token exchange or credential.
- The `source-publication.yml` publisher, which is separate work.
- Journal or witness creation. Genesis is a once-only human bootstrap; no
  uncreated journal authorises its own creation.
- A generic drain or replay engine. An ambiguous mutation is never automatically
  repeated, so there is nothing to build one for.
