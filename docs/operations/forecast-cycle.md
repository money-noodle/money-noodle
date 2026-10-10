# Forecast-only cycle lane

Stage 2 of #243 adds the forecast lane to the existing [engine-cycle frame](engine-cycle.md). This is code availability, not activation. The schedule remains paused and committed mode remains dry. Paper execution and deployed staged-start evidence remain stages 3–4.

The lane requires schema-owner migration 0005; no runtime applies it. Later explicitly authorized activation must reconcile the restored seed, apply the migration through the schema-owner path, raise both control epochs for the schema event, and establish fresh persisted paper intent. This PR performs none of those effects.

Each tick reads persisted paper provider permissions, obtains public inputs, records qualified 15-second or unqualified minute observations, then resolves a bounded set of due rows. Production probability never reads performance, candidates, promotions or venue prices. Asks influence entry research only. Resolution uses the issuance venue and contract; unavailable, mismatched or unsupported results cannot substitute another venue.

The applied reason is forecast-run. Dry-run is unchanged and paper remains mode-not-implemented. An expired writer cannot mutate forecasts; an opened run stays spent for retry/recovery evidence.

## Store topology

```mermaid
flowchart LR
  Intent["budget:paper intent + epoch"] --> Gate["cycle lease / run gate"]
  Gate --> Tick["bounded forecast tick"]
  Public["fixed-origin public feeds"] --> Tick
  Seed["restored open rows + provenance"] --> Tick
  Tick --> Overlay["cycle rows / samples / events"]
  Overlay --> Run["job run provenance"]
  Seed -. "no mutation" .-> Frozen["restore origin retained"]
```

The unique asset/close cycle groups all observation identities. Overlay reads suppress the corresponding seed, preserving restoration without duplicate visible identities. New rows carry cycle-run origin; seeded overlays retain restore origin plus current mutation provenance.

See [stage-2 qualification](../validation/2026-10-10-forecast-stage2.md) for test boundaries, retention/diagnostic limitations and exact-head acceptance requirements.

## Authority and explicitly versioned adaptations

The current API's `services/platform-api/src/domain/budget-control.ts` documents provider-enable as an inert audited request until a funded-authority design exists. Its configure payload validates bounded scalar syntax, not a forecast provider/research policy schema. ADR-0013 fixes reading persisted pause/resume and epoch at the start of the run; it does not define a new forecast-config materializer. This lane therefore does not interpret configure/provider-enable scalars as provider execution or research authority. Restored paper provider flags only narrow which public-data observational targets are acquired after the current run gate; they do not grant authority to run, execute, or promote a model. No zero-budget research prohibition or live flag is inferred.

New forecast recording requires a valid current Polymarket 15-minute target and remains anchored to its close/slug/market identity. Kalshi-only acquisition cannot create a new forecast; existing restored Kalshi rows still resolve on their issuance venue. This is historical recording compatibility, not funded capability.

Candidate probability-family math retains the historical model-spec identities. Prospective candidate entries use a pure Kalshi observational compatibility allowlist intersected with enabled valid quotes. No execution capability, live flag or credential is imported. All available candidate probabilities remain recorded even when no eligible candidate entry exists. The DTO distinguishes the unconstrained best quote option from an admissible selected entry; probability and production paper qualification retain their original quote set and are never narrowed by candidate metadata. Archived promotions remain inert.

Issuance calibration uses compatible `calibration-replay-v1` fields, finite raw basis inputs and independently recomputed confidence/probability errors. Historical reconstruction never fabricates missing raw or confidence inputs. Non-control research candidates require issuance-exact probability and confidence replay errors at most 1e-12. Archived promotions remain inert.
