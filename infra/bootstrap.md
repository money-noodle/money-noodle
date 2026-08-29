# One-time bootstrap procedure

> **Status:** Proposed procedure. **Nothing in this repository has been applied.**
> No Google Cloud account, project, resource, credential, or billing relationship
> was created, inspected, or authenticated against while writing it.
> **Prepared:** 2026-08-29 by `cc-gcp-delivery-foundation` (harness `claude-code`), GitHub issue #14
> **Decisions implemented:** [`ADR-0004`](../docs/architecture/decisions/ADR-0004-first-remote-hosting-composition.md), [`ADR-0005`](../docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md), [`ADR-0006`](../docs/architecture/decisions/ADR-0006-infrastructure-as-code-and-remote-state.md), [`ADR-0007`](../docs/architecture/decisions/ADR-0007-first-telemetry-backend.md)

Bootstrap exists because of one circularity: the deployer principal and the state
buckets cannot be created by a pipeline that authenticates as the deployer and
stores its state in those buckets. Everything else is created by the pipeline.

The procedure is therefore deliberately small. It runs **once**, by the
maintainer, and then reconciles itself into remote state so that no part of the
platform is held together by something a person did by hand and nobody wrote
down.

## What the maintainer must supply

None of these values are in this repository, and none may be committed. They are
passed as OpenTofu variables and, afterwards, as GitHub **repository variables**
(not secrets — they are identifiers, not credentials).

| Value | Where it comes from | Used for |
| --- | --- | --- |
| `project_id` | The Google Cloud project the maintainer creates | Every resource |
| `project_number` | Same project, numeric form | Budget filter, Cloud Run service agent identity |
| `billing_account_id` | The billing account linked to that project | The USD 30 budget |
| `state_bucket_prefix` | A name the maintainer chooses; bucket names are globally unique | The four state buckets |
| `repository_id` | `gh api repos/phairow/money-noodle --jq .id` | Trust conjunction |
| `repository_owner_id` | `gh api repos/phairow/money-noodle --jq .owner.id` | Trust conjunction |
| `budget_alert_email_addresses` | Where budget alerts should go | Budget notification channels |

Two authorizations are also required, and they are separate on purpose:

1. **Authority to create resources** — the maintainer runs the bootstrap apply
   themselves, from their own account.
2. **Authority for the pipeline to apply** — setting `INFRA_APPLY_AUTHORIZED` to
   `true`. Until then, every provider-touching job in the delivery workflow is
   skipped, and an apply is additionally gated on a protected environment and a
   typed confirmation phrase.

## Before starting

- Confirm the project is in a **maintainer-owned** account with root recovery
  configured, per the accepted decision.
- Confirm the region is `us-west1`. It is one of the three regions carrying the
  Cloud Storage always-free allotment, which the cost model relies on.
- **Do not touch DNS.** `noodle.money` is delegated to Vercel and serves the live
  v1 product. The first remote validation uses default `*.run.app` URLs. The
  domain cutover is a separately reviewed change (ADR-0004), and this repository
  contains no DNS resource at all — `tools/infra-policy.test.mjs` fails if one
  is added.

## Step 1 — create the project and enable billing

Done by the maintainer in the console or with `gcloud`. This is the one
click-or-command step that precedes code, because a project must exist before
anything can be declared inside it.

Record, in a place that is not this repository: the project id, the project
number, and the billing account id.

## Step 2 — apply the bootstrap stack with local state

```sh
cd infra/stacks/bootstrap

# Local state for this apply only. The backend block is empty in code, so
# `-backend=false` runs without one.
tofu init -backend=false

cat > bootstrap.tfvars <<'EOF'
project_id          = "..."
state_bucket_prefix = "..."
repository_id       = "..."
repository_owner_id = "..."
EOF

tofu plan  -var-file=bootstrap.tfvars -out=bootstrap.tfplan
# Read the plan. In particular, read the rendered `attribute_condition`: it is
# the exact conjunction that will decide who can deploy.
tofu apply bootstrap.tfplan
```

`bootstrap.tfvars` and `*.tfplan` are git-ignored.

This creates: the four state buckets (versioned, private, non-force-destroyable),
the deployer service account, the workload identity pool and its GitHub provider,
and the impersonation binding. Nothing else.

## Step 3 — migrate bootstrap's own state into the bucket it created

This is what stops the bootstrap from being a special case that lives on a
laptop.

```sh
cp backend.gcs.tfbackend.example backend.gcs.tfbackend
# Set `bucket` to "<state_bucket_prefix>-bootstrap".

tofu init -migrate-state -backend-config=backend.gcs.tfbackend

# Confirm the local state file is gone and the remote one is authoritative.
tofu state list

shred -u terraform.tfstate terraform.tfstate.backup 2>/dev/null || \
  rm -f terraform.tfstate terraform.tfstate.backup
rm -f bootstrap.tfplan
```

From here the bootstrap stack is an ordinary stack: reviewed, remote, locked, and
versioned like the other three.

## Step 4 — record the federation identifiers as repository variables

```sh
tofu output -raw contract_workload_identity_provider   # → GCP_WORKLOAD_IDENTITY_PROVIDER
tofu output -raw contract_deployer_service_account_email # → GCP_DEPLOYER_SERVICE_ACCOUNT
```

Set as GitHub **repository variables**, never secrets:

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | from the output above |
| `GCP_DEPLOYER_SERVICE_ACCOUNT` | from the output above |
| `GCP_PROJECT_ID` | the project id |
| `GCP_STATE_BUCKET_PREFIX` | the prefix chosen in step 2 |
| `GCP_REGISTRY_HOST` | `us-west1-docker.pkg.dev` |
| `GCP_REGISTRY_REPOSITORY` | `platform` |

None of these is a credential. The workload identity provider name is an
identifier; holding it grants nothing without a token that satisfies the trust
conjunction. **No service account key is created at any point in this procedure.**
If one exists, something has gone wrong.

## Step 5 — verify the trust boundary before granting apply authority

These are negative tests, and they matter more than a successful deploy. A test
proving the pipeline *can* deploy proves nothing about who else can.

1. A workflow run on a branch other than `v2` fails to obtain credentials.
2. A pull request run, including one from a fork, fails to obtain credentials.
3. A different workflow in this repository fails to obtain credentials.
4. `gh api /repos/phairow/money-noodle/actions/secrets` lists no provider key.

Only after these pass should `INFRA_APPLY_AUTHORIZED` be set to `true`.

## Step 6 — apply the remaining stacks through the pipeline

In order: `platform`, then `api`, then `web`. The API deploys before the web
because the web reads the API's published origin, and a compatible API must exist
first.

Each is a `workflow_dispatch` run of the delivery workflow with `action: apply`,
the stack named, and the confirmation phrase typed. The web and API additionally
require an `image_digest` and `artifact_version` from a completed publish run.

## Step 7 — prove state is recoverable

ADR-0006 requires a **tested** restore, exercised at least once before the first
production apply is trusted — not a restore that is assumed to work because
versioning is enabled.

```sh
gcloud storage ls --all-versions gs://<prefix>-platform/stacks/platform/
# Restore a prior generation into a scratch path and confirm `tofu show` reads it.
```

Record the date, what was restored, and how it was verified.

## What this procedure deliberately does not do

- It does not create DNS records, a load balancer, or a custom domain mapping.
- It does not create a secret **value**. The secret store is declared empty; the
  first slice needs no operational secret.
- It does not grant the deployer owner, editor, or any secret-reading role.
- It does not enable any funded authority, because none exists in v2.

## Reconciliation

Anything created outside this procedure or outside the pipeline is an exception
requiring reconciliation back into code. The scheduled drift job is how such a
change becomes visible; it reports and never silently corrects.
