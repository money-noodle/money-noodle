# One-time bootstrap procedure

> **Status:** Proposed procedure. **Nothing in this repository has been applied.**
> The organization-owned `money-noodle/money-noodle` source repository and GitHub
> Actions are public, but no Google Cloud
> repository variable, secret, federation, project resource, credential, or
> Money Noodle deployment exists. No provider was authenticated against while
> writing or validating this procedure.
> **Prepared:** 2026-08-29 by `cc-gcp-delivery-foundation` (harness `claude-code`), GitHub issue #14
> **Decisions implemented:** [`ADR-0004`](../docs/architecture/decisions/ADR-0004-first-remote-hosting-composition.md), [`ADR-0005`](../docs/architecture/decisions/ADR-0005-delivery-trust-and-secret-custody.md), [`ADR-0006`](../docs/architecture/decisions/ADR-0006-infrastructure-as-code-and-remote-state.md), [`ADR-0007`](../docs/architecture/decisions/ADR-0007-first-telemetry-backend.md)

Bootstrap exists because of one circularity: the deployer workload identity and the state
buckets cannot be created by a pipeline that authenticates as the deployer and
stores its state in those buckets. Everything else is created by the pipeline.

The procedure is therefore deliberately small. It runs **once**, by the
maintainer, and then reconciles itself into remote state so that no part of the
platform is held together by something a person did by hand and nobody wrote
down.

## Relationship to the production control plane

[`production-control-plane.md`](../docs/operations/production-control-plane.md)
assesses whether a short-lived agent-operated bootstrap runner can safely reduce
this maintainer procedure. The answer is **not with the current general-purpose
agent shell**: short token lifetime does not prevent arbitrary provider calls or
exposure of private bootstrap inputs. A future constrained runner must execute
only an immutable reviewed plan, receive sealed inputs unavailable to the agent,
allowlist provider actions/resources and outputs, use a non-exportable expiring
credential, emit durable private audit, and destroy itself after independent
verification.

Even such a runner cannot own the provider/billing relationship, accept payment
or legal terms, hold root recovery/MFA custody, or approve production. No such
runner has been built, so the steps below remain the explicit human-only
bootstrap exception. Every created resource still migrates into reviewed remote
state. The maintainer's acceptance of that control-plane design on 2026-09-07
authorized no provider effect and does not authorize this procedure; running it
still requires separate explicit maintainer authorization.

## What the maintainer must supply

None of these values are in this repository, and none may be committed or placed
in a public issue, pull request, workflow input, log, summary, artifact, cache, or
handoff. They are passed as OpenTofu variables and, afterwards, through private
host configuration as GitHub **repository variables**. They are identifiers, not
credentials, but actual billing/account/provider identifiers are still withheld
from public surfaces and from workflow output.

| Value | Where it comes from | Used for |
| --- | --- | --- |
| `project_id` | The Google Cloud project the maintainer creates | Every resource |
| `project_number` | Same project, numeric form | Budget filter, Cloud Run service agent identity |
| `billing_account_id` | The billing account linked to that project | Narrow budget-management grant plus the USD 25 alert budget |
| `state_bucket_prefix` | A name the maintainer chooses; bucket names are globally unique | The four state buckets |
| `repository_id` | `gh api repos/money-noodle/money-noodle --jq .id` | Trust conjunction |
| `repository_owner_id` | `gh api repos/money-noodle/money-noodle --jq .owner.id` | Trust conjunction |
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

Done by the maintainer in the console or with `gcloud`. This explicitly scoped,
one-time account-owner bootstrap is an exception to the rule against routine
console/laptop operation, because a project must exist before anything can be
declared inside it. It grants no permission for later agents or humans to bypass
the reviewed pipeline, and every resulting resource is reconciled below.

Record, in a place that is not this repository: the project id, the project
number, and the billing account id.

## Step 2 — apply the bootstrap stack with local state

```sh
cd infra/stacks/bootstrap

# Local state for this apply only. The backend block is empty in code, so
# `-backend=false` runs without one.
tofu init -backend=false

cat > bootstrap.tfvars <<'EOF'
project_id            = "..."
billing_account_id    = "..."
state_bucket_prefix   = "..."
repository_id         = "..."
repository_owner_id   = "..."
EOF

tofu plan  -var-file=bootstrap.tfvars -out=bootstrap.tfplan
# Read the plan. In particular, read the rendered `attribute_condition`: it is
# the exact conjunction that will decide who can deploy.
tofu apply bootstrap.tfplan
```

`bootstrap.tfvars` and `*.tfplan` are git-ignored.

This creates: the four state buckets (versioned, private, non-force-destroyable),
the deployer service account, the workload identity pool and its GitHub provider,
the impersonation binding, a billing-account `roles/billing.costsManager` binding
for that deployer, and **one runtime service account per deployable service with
its project-level telemetry grants**. The maintainer running bootstrap therefore
needs permission to set billing-account IAM. The grant manages cost visibility and
budgets; it does not administer the billing account or payment instruments.

The runtime identities are here, not in the service stacks, because creating a
service account needs `iam.serviceAccounts.create` and granting it a project role
needs `resourcemanager.projects.setIamPolicy`. Giving the delivery deployer
either would make CI the most powerful identity in the platform, which ADR-0005
refuses. The service stacks read the published emails and manage only Cloud Run
resources and service-level bindings.

### Re-applying bootstrap after the #178 change

A project bootstrapped before this change has the deployer, federation and state
buckets already. Re-applying the stack with the same variables plans exactly this
delta — no destroys, and nothing outside identity and the deployer's own roles:

| Change | Address | Why |
| --- | --- | --- |
| add | `google_service_account.runtime["platform-api"]` | The API runtime identity, previously asked of the pipeline |
| add | `google_service_account.runtime["web"]` | The web runtime identity, previously asked of the pipeline |
| add | `google_project_iam_member.runtime_telemetry["platform-api:roles/cloudtrace.agent"]` and its four siblings | The API's telemetry write grants |
| add | `google_project_iam_member.runtime_telemetry["web:roles/cloudtrace.agent"]` and its four siblings | The web's telemetry write grants |
| add | `google_project_iam_member.deployer["roles/run.admin"]` | Cloud Run administration, so the deployer can set service-level invoker bindings |
| destroy | `google_project_iam_member.deployer["roles/run.developer"]` | Replaced by `roles/run.admin`; `run.developer` cannot bind a service invoker |

Twelve adds and one destroy. The destroy removes a project role binding, not an
identity: the deployer service account itself is unchanged, and the replacement
binding is added in the same apply. Read the plan before applying it, and confirm
it contains no state-bucket, federation or billing change.

Re-apply before the first `api` apply. The service stacks read
`contract_runtime_service_account_emails` from this stack's state, so a service
plan against a bootstrap state that predates this change fails at `init` with a
missing output rather than deploying something unintended.

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

Set as GitHub **repository variables**, never secrets. Configure them directly in
the private host settings; never pass their values through a public issue,
`workflow_dispatch` input, Actions output, or agent handoff:

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | from the output above |
| `GCP_DEPLOYER_SERVICE_ACCOUNT` | from the output above |
| `GCP_PROJECT_ID` | the project id |
| `GCP_PROJECT_NUMBER` | the numeric project number |
| `GCP_STATE_BUCKET_PREFIX` | the prefix chosen in step 2 |
| `GCP_REGISTRY_HOST` | `us-west1-docker.pkg.dev` |
| `GCP_REGISTRY_REPOSITORY` | `platform` |
| `GCP_BILLING_ACCOUNT_ID` | the billing account id |
| `GCP_BUDGET_ALERT_EMAIL_ADDRESSES_JSON` | JSON array of budget notification addresses |
| `INFRA_APPLY_AUTHORIZED` | `false` until both authorization gates below pass |
| `PRODUCTION_ENVIRONMENT_REVIEWERS_VERIFIED` | `false` until required-reviewer protection is observed |

None of these is a credential, but their values remain non-public operational
configuration. The workload identity provider name grants nothing without a
token that satisfies the trust conjunction. **No service account key is created
at any point in this procedure.** If one exists, something has gone wrong.

## Step 5 — verify the trust boundary before granting apply authority

These are negative tests, and they matter more than a successful deploy. A test
proving the pipeline *can* deploy proves nothing about who else can.

1. A workflow run on any branch other than protected `main` fails to obtain credentials; explicitly prove the deleted `v2` ref and a second added ref are rejected as configuration inputs.
2. A pull request run, including one from a public fork, fails to obtain credentials.
3. A different workflow in this repository fails to obtain credentials.
4. An event outside `push`, `workflow_dispatch`, and `schedule` fails to obtain credentials.
5. `gh api /repos/money-noodle/money-noodle/actions/secrets` lists no provider key.

Then prove the one scheduled exception: `schedule` authenticates only for protected `main` and the exact `.github/workflows/delivery.yml` job workflow reference, allowing its read-only drift plan. The scheduled job receives no apply path and no issue-write permission.

Then verify the `production` GitHub environment actually has a required-reviewer
rule; naming an environment in YAML does not create that rule:

```sh
gh api repos/money-noodle/money-noodle/environments/production \
  --jq '.protection_rules'
```

Record the dated API evidence in the authorized apply issue. Set
`PRODUCTION_ENVIRONMENT_REVIEWERS_VERIFIED=true` only when the response contains
the intended required reviewer and self-review policy. If the repository host
cannot enforce that protection, leave the variable false: apply and rollback
remain mechanically blocked until the maintainer changes the hosting control or
explicitly revises the accepted gate.

Only after the negative federation tests and environment check pass should
`INFRA_APPLY_AUTHORIZED` be set to `true`.

## Step 6 — apply the remaining stacks through the pipeline

In order: `platform`, then `api`, then `web`. The API deploys before the web
because the web reads the API's published origin, and a compatible API must exist
first.

Each is first a `workflow_dispatch` plan and then an apply with the stack named
and, for apply, the confirmation phrase typed. A first `api` plan contains Cloud
Run resources and service-level IAM bindings only — one
`google_cloud_run_v2_service` and one `google_cloud_run_v2_service_iam_member`
per authorised invoker. If it contains a `google_service_account` or a
`google_project_iam_member`, the bootstrap re-apply above has not happened and
the apply will fail on `iam.serviceAccounts.create`. The web and API additionally
require an `image_digest` and full `source_commit` from the same completed
publish run. Delivery verifies the digest's signed provenance against that exact
source commit and signer workflow; the commit is also the artifact version
reported by this first slice.

### Enabling the projection secret

The read-only paper projection the platform API reads (ADR-0012) needs three
things a routine deploy cannot produce — the secret container, its access grant,
and its value — and they arrive in the order below. The order is not a preference:
Cloud Run refuses a revision whose referenced secret does not exist, and the
deployer identity that a merge deploys as **can mutate nothing in Secret Manager**,
so none of the three is inside what a merge can do (#217). Step 5 adds the one
thing that identity does need, and it needs it only to *plan*: metadata read on the
containers this stack declares (#224).

1. **Merge the change** — done by #217. It declares the container and its single
   accessor grant in the platform stack, declares the API's intent to read it in the
   api stack, and left `projection_secret_binding_enabled = false` so the api deploy
   that followed the merge referenced no secret and succeeded.
2. **Apply the platform stack**, which creates the empty container and grants
   `roles/secretmanager.secretAccessor` on exactly that secret to exactly the API's
   own runtime identity:

   ```sh
   gh workflow run delivery.yml --ref main \
     -f action=apply \
     -f stack=platform \
     -f confirmation=APPLY-TO-PRODUCTION
   ```

   No `image_digest` or `source_commit` is passed: those are required for a service
   stack, not for `platform`. The run waits for the `production` environment
   approval. Read the plan before approving: it must contain one
   `google_secret_manager_secret` and one `google_secret_manager_secret_iam_member`
   and no secret **version**.

   **Authority precondition.** That apply authenticates as the federated deployer,
   whose enumerated roles include no Secret Manager mutation at all — it can neither
   create the container nor set IAM on it. Until that is resolved the apply fails on
   `secretmanager.secrets.create`. Two ways to resolve it, and the choice is the
   maintainer's:

   - apply these two resources themselves, from their own account against the same
     remote state, as the explicitly scoped human-only exception this document
     already uses for the bootstrap stack, leaving the pipeline owning everything
     else; or
   - give the deployer a **narrow custom role** carrying only
     `secretmanager.secrets.{create,get,update,setIamPolicy}` and no
     `secretmanager.versions.access`, so it manages containers and still cannot read
     a value. That is an ADR-0005 amendment and a bootstrap change, not a step in
     this procedure.

   The maintainer chose the first route on 2026-10-05. A plan of this stack run
   with a person's own credentials needs a quota project for the budget API, which
   the pipeline's service account supplies implicitly and a user login does not:
   without it the refresh of the existing budget is refused before any plan exists.
   Set the provider's two standard switches first, naming this project:

   ```sh
   export USER_PROJECT_OVERRIDE=true
   export GOOGLE_BILLING_PROJECT="$(gh variable get GCP_PROJECT_ID -R money-noodle/money-noodle)"
   ```

   Initialise against the platform state exactly as the workflow does
   (`-backend-config="bucket=<state-bucket-prefix>-platform"`,
   `-backend-config="prefix=stacks/platform"`), supply the stack's required
   variables from the repository variables, and apply only a saved plan that reads
   `2 to add, 0 to change, 0 to destroy`.

3. **Add the secret version out of band**, in the provider's protected secret
   interface. This is the audited payload-ingress exception recorded in
   [`../docs/operations/delivery.md`](../docs/operations/delivery.md): the value must
   not pass through this repository, an OpenTofu variable, a plan, state, a workflow
   input, or a job log. Nothing here holds or can reconstruct it. The SELECT-only
   database role it names is created at the database provider, not here.
4. **Flip the binding on** — done by #219, merged once steps 2 and 3 were confirmed,
   which was the whole reason it was a separate change: merging it while the container
   had no version, or no container existed, would make Cloud Run refuse every revision
   the api deploy creates.

   **That merge did not deploy it,** and the earlier wording here said it would.
   What actually happened: #219 changed only `infra/stacks/api/**`, the release vector
   was computed from the workspace project graph alone, every path under `infra/`
   belongs to the one `infra` project, so the vector was empty, the deploy was skipped
   and the binding sat unapplied — waiting for some later application commit to carry
   it. The step-5 plan failure then blocked even that. Since #227 a service's stack is
   an input of that service's deployment unit, so from this change on a merge like
   #219's is itself a routine deploy of `api` and the flip takes effect on its own
   merge.

   Either way the proof is the same: the first api revision that renders the reference
   must pass its readiness probe, and a revision whose projection is unreachable, or
   whose role holds more than SELECT, never serves traffic.

5. **Let the pipeline plan what now exists** — carried by #224, and the last
   maintainer apply in this sequence. The moment step 2 created the container, every
   pipeline plan of this stack began refreshing it as the deployer and being refused:
   `403 Permission 'secretmanager.secrets.get' denied` in `plan platform`, with the
   deploy skipped, so no routine deploy could run and the scheduled drift plan was
   blind the same way. #224 declares `roles/secretmanager.viewer` for the deployer,
   bound to each declared container: it reads the container and its IAM policy,
   carries no `secretmanager.versions.access` and nothing that mutates (ADR-0005,
   2026-10-05 amendment).

   Apply it the same way as step 2, with the same quota-project switches, and read
   the plan before approving. It must be **additions only** — one
   `google_secret_manager_secret_iam_member` per declared container, which today is
   one:

   ```text
   Plan: 1 to add, 0 to change, 0 to destroy.
   ```

   If the plan proposes anything against `module.secret_store.google_secret_manager_secret.secret`
   or against the existing `…secret_iam_member.accessor`, stop: this change must not
   touch the container or the accessor grant, and a change there means something else
   drifted. After the apply, the next pipeline plan of this stack succeeds, and the
   failed Delivery run can be re-run.

Steps 2, 3 and 5 are the maintainer's. Steps 2 and 3 leave no trace in this
repository, so the dated evidence that they happened is the first api revision that
passes readiness with the binding rendered. Step 5 is visible as its own effect: a
pipeline plan of this stack that completes.

The ordering trap this sequence fell into is worth keeping in mind for the next
secret: a reviewed change that lives entirely in a service stack used to reach
production only when something else happened to be merged. It now deploys on its own
(#227), so "merged" and "applied" are the same event again for a service stack — and
still deliberately different for `platform` and `bootstrap`, which no routine deploy
touches.

Rotation and revocation need none of this again: the grant and the reference pin
`latest`, so adding a version takes effect on the next instance start without a
deployment. Taking the reference back out is the same one-line change in reverse,
and is how a projection incident is contained without reverting the port.

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
- It does not create a secret **value**. Secret containers are declared empty, and
  the one value this platform now needs is entered out of band by the maintainer in
  the order above.
- It does not grant the deployer owner, editor, or any secret-reading role, and
  it grants no identity-administration role: the deployer may *act as* the
  runtime identities (`roles/iam.serviceAccountUser`) but may not create, delete
  or re-grant them.
- It does not enable any funded authority, because none exists in the current platform.

## Reconciliation

Anything created outside this procedure or outside the pipeline is an exception
requiring reconciliation back into code. The scheduled drift job is how such a
change becomes visible; it reports and never silently corrects.
