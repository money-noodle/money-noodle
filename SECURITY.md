# Security policy

## Report privately

GitHub private vulnerability reporting is enabled. Report vulnerabilities and accidental secret disclosure through the [private advisory form](https://github.com/money-noodle/money-noodle/security/advisories/new). **Never put a vulnerability, exploit, credential, secret payload, customer data, or recovery material in a public issue, pull request, discussion, commit, or Actions log.**

If the private form is temporarily unavailable, do not open a public issue. Use the repository owner's GitHub profile to request a private reporting channel without including the sensitive payload.

Include only what is needed to reproduce and assess the issue: affected revision or component, impact, safe reproduction steps, and suggested mitigation. Keep exploit code and sensitive evidence inside the private report.

## Accidental secret disclosure

Treat an exposed secret as copied, even if it appeared briefly.

1. Revoke or rotate the credential at its authority source first, and contain any resulting access.
2. Preserve necessary incident evidence in an approved private location.
3. Only then coordinate history cleanup and replacement commits. Rewriting or deleting Git history does not revoke a credential and cannot erase existing clones, caches, logs, or forks.
4. Verify revocation independently and inspect the relevant audit evidence.

Do not submit a public cleanup pull request before revocation; the diff can disclose the payload again.

## Public-repository boundary

Repository source, issues, pull requests, commit metadata, Actions logs and summaries, artifacts, and caches are public or potentially externally observable. They must not contain secret payloads, customer or production data, billing/account identifiers, private recovery material, production snapshots, or durable provider credentials. Use synthetic fixtures and redacted evidence.

External contribution code is untrusted. Pull-request checks are read-only and receive no provider identity or deployment authority. Money Noodle does not use `pull_request_target` to execute contributor-controlled source.

[`docs/current-status.md`](docs/current-status.md) owns current deployment and real-money-authority status. Security reports about the source and automation are welcome regardless of deployment state; do not infer production impact beyond the current status evidence.
