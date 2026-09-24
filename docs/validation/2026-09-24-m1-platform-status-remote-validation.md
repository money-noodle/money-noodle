# Validation report: M1 platform status slice, remote validation

> **Status:** Dated validation evidence, not policy or acceptance authority
> **Collected:** 2026-09-24T05:30Z to 2026-09-24T06:40Z
> **Source revision on `main` during collection:** `287faedd6340f6fb3a190237e6fc3d9a1bbf5483`
> **Deployed revisions observed:** platform-api `git-b5146ad79fad947c1ad39b0f80a13507552483aa`, web `git-9feb14ba063e11a203cffb2b22cc430060ae577c`
> **Owning ticket:** #8. Acceptance is #77's decision.

## Method

Read-only observation only. No provider mutation, deployment, rollback, or forced failure was performed for this report. Sources:

- GitHub Actions run metadata for `.github/workflows/delivery.yml` (job and step conclusions).
- Google Cloud read-backs with the maintainer's credentials: Cloud Run service list and IAM policy, Artifact Registry repository list, state-bucket object versions, workload-identity provider condition, service-account key list.
- 32 HTTPS `GET`/`HEAD` requests to the public `platform-api` and `web` Cloud Run services in `us-west1`, with `curl --max-time 20`, on 2026-09-24 between 06:33Z and 06:36Z.
- The API's OpenAPI document (`services/platform-api/openapi/platform-api.v1.yaml`) and the web runtime-rendering contract (`apps/web/src/adapters/config/runtime-rendering.contract.ts`) as the checked contracts.

Service hostnames, project identifiers, and billing identifiers are withheld. Git SHAs and run ids are public.

## Evidence

### E1. Delivery chain to the observed deployments

Dispatched operations (`workflow_dispatch`, all under the `production` environment gate, in order):

| UTC | Run | Job | Result |
| --- | --- | --- | --- |
| 2026-09-19 09:23 | 35434557210 | `plan platform` | success |
| 2026-09-19 09:26 | 35434704518 | `apply platform` | **failure** at `Apply`: Artifact Registry returned 403 `artifactregistry.repositories.create` denied for the deployer. Nothing was created; the run stopped. Remediated by #175 / #176 (deployer administers the registry). |
| 2026-09-19 18:23 | 35461030758 | `plan platform` | success |
| 2026-09-19 18:25 | 35461162537 | `apply platform` | success |
| 2026-09-19 23:45 | 35476996861 | `plan api` | success |
| 2026-09-19 23:50 | 35477198056 | `apply api` (private) | success |
| 2026-09-19 23:59 | 35477559920 | `plan web` | success |
| 2026-09-20 00:03 | 35477748434 | `apply web` (private) | success |
| 2026-09-20 05:20 | 35491421335 | `apply api`, reviewed access change | success: `Load the configured artifact for a reviewed access change`, `Apply the reviewed access change`, `Verify health and the public contract` |
| 2026-09-20 06:56 | 35495534231 | `apply web`, reviewed access change | success: same steps |

Automatic merge-to-`main` deliveries after exposure (`push` event). Each run's `publish` jobs completed `Build the release candidate with provenance and SBOM`, `Prove the candidate digest serves its runtime contract`, `Scan the candidate digest before publication`, `Publish the tested digest and prove it is the one in the registry`, and `Attest build provenance` for both images:

| UTC | Head | `deploy release vector` |
| --- | --- | --- |
| 2026-09-20 07:08 | `37a2c92` | `Deploy web`, `Verify web health` |
| 2026-09-20 08:43 | `9882526` | `Deploy web`, `Verify web health` |
| 2026-09-21 08:37 | `b5146ad` | `Deploy api`, `Verify api health and the published contract`, `Deploy web`, `Verify web health` |
| 2026-09-23 00:08 | `9feb14b` | `Deploy web`, `Verify web health` |
| 2026-09-23 00:19 to 2026-09-24 03:08 | `c8c5e0e`, `bcc8799`, `e21074c` | skipped: release vector empty (no affected service) |

The observed running versions (`b5146ad` for the API, `9feb14b` for the web) are exactly the last heads whose vector deployed each service. Every `deploy` job ran `Resolve and verify the artifacts this commit published` before deploying.

No `rollback` job, dispatched or automatic, has ever run.

### E2. Foundation read-back (2026-09-24, also recorded on #76)

- Bootstrap stack: `tofu plan` against remote state reports no changes at `e21074c`; 42 resources in state.
- Four state buckets hold versioned remote state; a prior generation of the `platform` state (serial 2, 15 resource instances) was restored into a scratch path and parsed.
- Workload-identity provider condition binds repository owner id, repository id, repository name, `ref_type == branch`, `refs/heads/main`, `push`/`schedule`/`workflow_dispatch`, and the exact `delivery.yml@refs/heads/main` job workflow reference.
- Repository Actions secrets: 0. Deployer user-managed keys: 0.
- `production` environment: required reviewer is the maintainer only, `prevent_self_review=true`, protected-branches deployment policy.
- Both Cloud Run services carry one `allUsers` `roles/run.invoker` binding each, applied by the two reviewed access-change runs above.

### E3. Public status contract (`GET /v1/platform/status`)

| Item | Observed |
| --- | --- |
| HTTP status, content type | 200, `application/json; charset=utf-8` |
| Body keys | exactly `state`, `asOf`, `service`, `schemaVersion`, `requestId` (`additionalProperties: false` holds) |
| `state` | `available` |
| `asOf` | RFC 3339 timestamp, fresh per request |
| `service` | `{ name: "platform-api", version: "git-b5146ad…" }` |
| `schemaVersion` | `"1"` |
| `requestId` | UUID, equal to the `x-request-id` response header |

Verdict: conforms to the `PlatformStatus` schema.

### E4. Liveness and readiness

`GET /health/live` and `GET /health/ready` on the API both return 200 with `{ service, status, version }` and nothing else; no hostnames, addresses, environment names, or upstream topology. The web serves the same two paths, 200, `{ service: "web", status, version }`.

### E5. Error behaviour (RFC 9457)

`GET /v1/platform/does-not-exist` returns 404 `application/problem+json` with `type`, `title`, `status`, `errorCode` (`MN-ROUTE-NOT-FOUND`), `instance`, and `requestId` equal to `x-request-id`. Conforms to the `Problem` schema. `HEAD /v1/platform/status` returns 200 with the announced length and no body. No unsafe methods were sent, so 405 handling was not exercised.

### E6. Web rendering

`GET /` on the web service returns 200 HTML containing the availability card: eyebrow "Platform availability", heading "Available", the sentence "The platform API reports normal availability.", a `<time dateTime="…">` observed-at value that changes per request, and the API version string equal to the API's own `service.version`. The word "unknown" is absent. The web state therefore matches the API state at collection time. The read is made server-side: the web's warm latency includes its request to the API on every page load.

Historical note: on 2026-09-20T21:07Z the same page rendered "Status unknown" while the API was healthy (#193). That observation predates the `b5146ad` API and `9feb14b` web deployments and is not reproducible today; it is real evidence that the unknown path renders without a stale or healthy fallback, and #193 owns the root cause.

### E7. Trace correlation

With `traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`, the API response carries `x-cloud-trace-context: 4bf92f3577b34da6a3ce929d0e0e4736;o=1`, set by the Cloud Run frontend, so the supplied trace id reaches the service's edge. Neither service returns `traceparent` or `server-timing`; the web returns no trace header. Client-visible correlation rests on `x-request-id`, which the API sets on every response and the web does not set on its 200 responses.

### E8. Latency and cold start (sequential, 10 samples each, `curl %{time_total}`)

| Target | Cold first hit | Warm min / median / max |
| --- | --- | --- |
| API `GET /v1/platform/status` | 3642 ms | 51 / 56 / 67 ms |
| Web `GET /` | 3625 ms | 76 / 83 / 95 ms |

Raw API warm samples (ms): 84, 53, 67, 54, 60, 62, 56, 60, 53, 51. Raw web (ms): 112, 93, 95, 93, 76, 81, 86, 82, 77, 83. Error rate across all 32 requests: 0.

**Sample and exclusions.** One client, one location, one minute, `min_instances = 0`. Excludes concurrent load, other regions, browsers, and any request that is not a `GET`. **Largest validity threat:** the cold-start figure is a single observation per service on a client that had just been idle; it bounds the user-visible penalty of scale-to-zero but does not characterise its distribution.

### E9. Response headers

| Header | API | Web |
| --- | --- | --- |
| `cache-control` | absent | `private, no-cache, no-store, max-age=0, must-revalidate` |
| `strict-transport-security` | absent | absent |
| `content-security-policy` | absent | absent |
| `x-powered-by` | absent | `Next.js` |
| `server` | `Google Frontend` | `Google Frontend` |

## Limitations

1. **Not exercised: forced failure, rollback, or authorization rejection.** No run has ever executed a `rollback` job, and no exercise has shown the release path rejecting an invalid, replayed, or stale authorization or failing closed on unavailable audit. Each of those is a provider-affecting operation that needs its own approved grant; none was granted for this report.
2. **Private audit chain not reconstructed here.** The request, approval, grant, attempt, effect, verification chain above is the public half (issue approvals, run metadata, observed state). The private half is the maintainer's.
3. **Trace correlation** is edge-provided on the API and absent on the web (E7).
4. **Negative federation runs** (`infra/bootstrap.md` step 5) were not re-executed; the provider condition was read back only.
5. Single-client, single-minute latency sample (E8).

## Observations for owning lanes (not defects of this report)

- `x-powered-by: Next.js` is emitted by the web; `poweredByHeader: false` would remove it.
- Neither service sets `strict-transport-security`; the web sets no `content-security-policy`.
- The API sets no `cache-control` on `/v1/platform/status`; the value is a fresh observation and an explicit `no-store` would prevent intermediary caching.
- Public `version` strings are full `git-<40-hex>` commit SHAs in both services' bodies and in the web HTML.
- The web's 200 health responses carry no `x-request-id`; the API's do.
- `infra/bootstrap.md` re-apply table says "twelve adds" but lists thirteen and omits the #176 registry-role swap.

## Conclusion

The platform status slice is deployed through the reviewed pipeline as two separately attested artifacts, is publicly reachable, and its public contract, health endpoints, error shape, and server-side web rendering behave as specified at collection time. Delivery, exposure, and health verification are proven by run evidence. Recovery and authorization-rejection behaviour are **not** proven: they have never been exercised remotely and require separately approved operations before #77 can accept the milestone.
