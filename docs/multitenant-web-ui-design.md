# Multi-tenant web identity, profile, and venue-connection UI

> **Document type:** Product design
> **Design status:** Proposed
> **Implementation:** Not started
> **Created:** 2026-08-22
> **Canonical requirements:** None — proposal or exploration only
> **Decision record:** None — no accepted product decision
> **Design index:** [`docs/README.md`](README.md)

> **Status: proposed for maintainer review; not approved or implemented.**
> Written 2026-08-22; revised 2026-08-22 to define local and cloud runtime profiles. This is a UI follow-on to
> [`execution-engine-separation-design.md`](execution-engine-separation-design.md) and
> [`multitenancy-design.md`](multitenancy-design.md). Implementation begins only after the web/engine boundary
> and the required identity, tenant, API, secret-plane, and tenant-cell contracts exist. This document does not
> approve another user, venue, credential, funded account, or live capability.

## 1. Decision proposed

Build one stateless web application whose behavior is the same when run locally and when deployed:

1. Replace the shared dashboard password with OIDC authentication, server-managed revocable sessions,
   MFA/passkey support, and step-up authentication for sensitive actions.
2. Make every UI-visible durable fact database-backed through the versioned application/control API. The web
   artifact never imports engine stores, reads `data/`, detects or calls a local worker, accesses venue
   credentials, receives a database credential, or calls an execution function. Engines publish read models and
   consume durable requests through the approved backend contracts; the UI never synchronizes with an engine at
   request time.
3. Resolve the signed-in user's personal tenant from verified membership and render only tenant-keyed DTOs and
   server-reported capabilities. An `authenticated: boolean` is no longer an authorization model.
4. Replace environment-variable venue setup instructions with a tenant-owned **Connections** workflow supporting
   typed provider authentication methods, secret ingestion, connectivity tests, rotation, disablement, and
   deletion. A connected venue remains paused, live-disabled, and zero-budget until separate controls change it.
5. Add an application account profile with display name, verified identity attributes, security/session links,
   and avatar support. Profile data never enters the research, paper, or execution planes.
6. Replace the current collection of operator dialogs with durable, deep-linkable application routes while
   retaining the public research landing page.
7. Derive every unavailable, read-only, stale, or actionable state from API data and effective capabilities—not
   from `VERCEL`, `MONEY_NOODLE_STATELESS`, localhost detection, environment names, or the presence of a cookie.
8. Support two first-class service-placement profiles behind those same contracts: a local stack whose runtime
   controller starts supervised local research, paper, and tenant-cell engines, and a deployed stack whose
   controller allocates cloud engine resources. Engine placement changes infrastructure and reported capability,
   not frontend authority or API semantics.

The same web build should produce the same UI for the same API/session fixtures. Deployment configuration may
select API/OIDC endpoints and infrastructure namespaces or placement profiles; components may not branch into a
different product or direct-engine path. “Stateless UI” means the web process can be replaced without losing
application, operation, or engine state—not that a local installation must use cloud services.

## 2. Prerequisites and sequencing boundary

This design is intentionally not a way to retrofit multiple users onto the current combined Next.js process.
Its implementation requires:

- the behavior-preserving engine extraction in the engine-separation design;
- a client-neutral application/control API with public and tenant-private DTOs;
- OIDC users, personal tenants, memberships, role grants, revocable sessions, and tenant authorization;
- tenant-keyed database projections, commands, idempotency, audit, operation status, and runtime status;
- a local runtime-controller/supervisor adapter and a cloud runtime backend behind the same lifecycle contract;
- the dedicated venue credential-ingest/secret plane, with an approved local secret backend for standalone use;
- object storage and image processing before the optional avatar phase, not before the UI foundation;
- at least one logical tenant live cell before tenant live controls are exposed.

The UI may be prototyped against synthetic contract fixtures, but it must not gain a production auth bypass,
read current local ledgers, accept real venue credentials, or remotely control the current combined runtime.

## 3. Current behavior to retire

The present UI is correct for one local operator but encodes assumptions that cannot survive this transition:

| Current behavior | Target behavior |
| --- | --- |
| `src/lib/auth.ts` validates one 14-day HMAC cookie with no user identity or revocation. | A maintained OIDC/OAuth library, external identity provider, opaque server session, current user and membership lookup, revocation, and step-up. |
| `src/app/login/page.tsx` accepts `AUTH_PASSWORD`. | Redirect-based OIDC sign-in; Money Noodle never receives or stores an application password. |
| `src/app/page.tsx` passes `authenticated`, `deskAvailable`, and `stateless`. | Public research DTO plus an optional authenticated viewer/tenant capability DTO and independently projected runtime status. |
| `src/components/dashboard.tsx` hides or shows controls from a boolean and changes polling from `stateless`. | Routes and controls derive from API capabilities, projection freshness, and task cadence. Polling semantics do not inspect deployment. |
| Private Route Handlers import account, budget, control, and reconciliation modules directly. | The web BFF calls the application/control API only. |
| `src/components/account-dialog.tsx` tells the operator to add venue variables to `.env`. | Tenant-owned connection setup through typed OAuth, secret upload, wallet proof, or other registered methods. |
| Local Next.js can be the worker; Vercel can only read a paper projection. | Next.js is stateless in every profile. A local application/control stack coordinates supervised local engines; a deployed stack coordinates cloud engines through the same database-backed API, command, projection, and lifecycle contracts. |
| Sign out deletes a cookie that cannot be revoked elsewhere. | Sign out revokes the web session; the security page can revoke other sessions. Ordinary sign-out does not claim to pause a healthy cell. |

Legacy endpoints remain only during a bounded migration. They must not coexist indefinitely as a second local
control path.

## 4. Stateless UI and local/cloud parity contract

### 4.1 One frontend topology

```text
browser
   |
   | same-origin pages and /api/app/*
   v
stateless Next.js web/BFF
   |  server-held web session / OAuth access token
   v
versioned application/control API
   |-- identity, profile, tenant membership and capabilities
   |-- shared public/research and signed-in paper projections
   |-- tenant private projections, operations, and command inbox
   |-- credential-ingest and avatar orchestration endpoints
   v
application/control/read-model database
```

The browser never receives a database credential, engine address, scheduler credential, venue secret, OAuth
refresh token, or reusable application API service credential. The BFF is not allowed to turn “database-backed”
into direct frontend database access: it calls the client-neutral API. Server Components use the same server-only
API client as Route Handlers without making a loopback HTTP call to their own Next deployment. Client Components
use same-origin BFF routes.

### 4.2 Database-backed display and operation state

Every durable value rendered by the authenticated application comes from a versioned API resource backed by the
application/control database or an approved database projection. This includes viewer/session state, profile,
membership and capabilities, connection metadata, portfolio/history projections, runtime status, command and
lifecycle operations, and their revisions and timestamps. Avatar bytes may live in object storage, but their
identity, ownership, processing state, and version are database-backed.

A page request never opens an engine ledger, waits for an engine RPC, or computes authority from process memory.
Engines and runtime controllers asynchronously publish projections and consume durable inbox/desired-state
records. DTOs identify source generation time, database observation time, revision, runtime target, and
freshness so eventual consistency is explicit. This requirement does not silently promote a read projection to
cash/order authority: venue state and the owning execution ledger remain authoritative as defined by the backend
designs until a separately approved money-store migration.

The UI has a bounded API-unavailable/protocol-incompatible state and diagnostics reference. It does not search
localhost ports, inspect processes, fall back to files, or discover an engine when its configured API is absent.
The installer or deployment manifest configures the API and supporting services before the web process starts.

### 4.3 Supported service-placement profiles

The canonical protocols support these profiles:

```text
Local standalone/development                   Deployed

browser                                        browser
  -> local stateless web/BFF                     -> deployed stateless web/BFF
  -> local application/control API               -> cloud application/control API
  -> local Postgres/control DB                    -> managed Postgres/control DB
       <-> local runtime controller                    <-> cloud runtime controller
       <-> supervised local engines                    <-> cloud engine allocations
       <-> local secret/object backends                <-> managed secret/object backends
```

The local runtime controller uses the placement-neutral lifecycle contract from `multitenancy-design.md` to
provision, start, observe, safe-stop, and restart supervised local engine services. It—not the UI—may interact
with `launchd`, `systemd`, containers, or another approved local supervisor. Local engines use the same target,
fence, durable command, projection, operation, capability, and reconciliation protocols as cloud allocations.
A local web restart leaves their boot IDs and work unchanged.

A deployed installation selects an approved cloud backend for shared research, paper, and tenant live cells.
Cloud scheduler identifiers and credentials remain behind the runtime controller. A deployment may report a
sanitized placement class and availability characteristics for diagnostics, but those values do not establish
trading readiness.

Development/testing is a local profile using synthetic tenants, demo venue accounts, and isolated databases.
A local standalone production installation is different: it may hold the operator's real data and credentials
only in its approved persistent database and local secret backend under all ordinary funded gates. Production
data must never be copied into a development/test profile.

### 4.4 Permitted configuration and local identity

Local, preview, and production deployments may differ only in configured infrastructure:

- application API origin and audience;
- OIDC issuer/client credentials and registered callback/logout URLs;
- database, object-storage, KMS/secret, and runtime-backend namespaces;
- cookie domain and HTTPS origin;
- release/environment and placement labels used in a non-authoritative diagnostics view.

Local development may use either a real non-production OIDC tenant or an approved standards-compatible local
OIDC provider with synthetic accounts. A standalone funded installation must use an approved identity provider
and recovery/step-up policy; whether that provider is separately operated locally or hosted is a deployment
choice, not an application password fallback. There is no `DEV_USER`, password fallback, localhost superuser,
filesystem credential form, direct-engine URL, or “if Vercel” component branch. Test-only session injection is
confined to automated test harnesses and cannot be built into a production artifact.

### 4.5 Server-advertised capability, not deployment detection

The UI may display that a tenant runtime is local or cloud placed, unprovisioned, stopped, stale, blocked, or
read-only because a versioned API DTO says so. It must not infer those states from:

- hostname, port, `NODE_ENV`, `VERCEL`, or `MONEY_NOODLE_STATELESS`;
- failure to find a local file, process, or environment credential;
- a successful login;
- a successful compute `start` request;
- the absence of a current heartbeat.

An absent heartbeat means **cell unobserved**. A connected account means **credentials tested**, not live enabled.
A started allocation means **compute observed**, not reconciled or trading active. A `local` placement label is
informational; only independently reported cell, intent, reconciliation, drain, and risk facts can enable a
control.

### 4.6 Public and private resources stay separate

Do not continue the current pattern where one dashboard route returns a larger shape when it sees a cookie.
Use separate contracts:

- public research and bounded shared-paper resources are identity-free and safely cacheable under their own
  policy;
- signed-in shared-paper resources require a session but contain no tenant live data;
- tenant resources require current membership/ownership and return `Cache-Control: private, no-store`;
- command, profile, avatar, connection, and session resources are private and never enter a shared Next cache.

The public page can progressively add a signed-in user menu, but private financial data is fetched only after
server authorization and is never embedded in an anonymous response or public cache key.

## 5. Real application authentication

### 5.1 Protocol and session

Use authorization-code OIDC with PKCE through a maintained authentication library and a separately operated
identity provider that supports immutable issuer/subject identity, MFA or passkeys, recovery, session
revocation, and recent reauthentication. The provider may be hosted or, for an approved standalone profile,
locally operated; the Money Noodle web/API code does not implement password storage or account recovery.

For the web client:

1. The user selects **Sign in** or **Create account**.
2. The BFF creates state, nonce, PKCE verifier, and an allowlisted relative return target in a short-lived
   server-side transaction.
3. The browser authenticates at the identity provider.
4. The callback validates issuer, audience, state, nonce, PKCE, code lifetime, and provider errors.
5. The identity service resolves `(issuer, subject)` to one immutable local user and creates or loads the V1
   personal tenant according to the approved enrollment policy.
6. The BFF stores only an opaque session identifier in an `HttpOnly`, `Secure`, `SameSite` cookie. Refresh and
   provider tokens remain server-side, encrypted, revocable, and client-bound.
7. The browser returns to an allowlisted application route. Absolute or cross-origin `returnTo` values are
   rejected.

Sensitive requests reload current session, membership, role grants, resource ownership, client scope, and
step-up state. Long-lived role or tenant claims in a browser token are not authority.

### 5.2 Authentication UI

The sign-in page contains product context and provider actions, not credential fields. Required states are:

- sign in / create account;
- callback in progress;
- invalid or expired authorization transaction;
- account disabled or enrollment not allowed;
- identity provider unavailable;
- session expired;
- step-up required;
- signed out from this device;
- global session revocation confirmation.

Errors are bounded and do not reveal whether an email, identity subject, tenant, or role exists. Recovery and
MFA-management links go to the identity provider. The UI must not promise that logging out, disabling a user, or
closing a browser has paused trading; security recovery follows the non-expiring pause-and-drain behavior in the
multitenancy design and reports acknowledgement separately.

### 5.3 Step-up authentication

Resume, live provider enablement, material budget changes, credential rotation/deletion, runtime retirement, and
other actions identified by the application API require recent step-up. The UI:

- explains why reauthentication is required;
- preserves only non-secret draft state;
- returns through a single-use server transaction;
- retries no money or credential mutation automatically after step-up;
- requires the user to review and submit the action again against fresh revisions.

The API decides whether step-up is fresh. A client timestamp or hidden field cannot satisfy it.

### 5.4 Sessions and devices

`/app/settings/security` lists sanitized active sessions: current-device marker, client type, approximate last
activity, creation time, and revocation status. Raw tokens, complete IP addresses, provider subject IDs, and
unbounded user agents are not returned. Users may revoke one other session or all other sessions. Revocation is
audited and takes effect on the next server verification; it does not mutate tenant trading intent unless the
approved security-event policy separately requests pause-and-drain.

## 6. Tenant integration and authorization presentation

### 6.1 Viewer bootstrap

The authenticated shell begins with a bounded `ViewerDTO`, conceptually:

```ts
interface ViewerDTO {
  session: { id: string; expiresAt: string; stepUpExpiresAt?: string };
  user: {
    id: string;
    displayName: string;
    verifiedEmail?: string;
    avatar?: AvatarDTO;
  };
  tenant: {
    ref: string;            // opaque browser-safe reference, not execution authority
    kind: 'personal';
    displayName: string;
    status: 'provisioning' | 'active' | 'suspended' | 'retiring';
  };
  capabilities: CapabilityDTO;
}
```

Exact fields belong to the client-neutral API schema. Do not pass database records, OIDC claims, role-grant
rows, primary tenant IDs, cell IDs, secret references, or provider tokens to Client Components.

V1 has exactly one personal tenant per user, so it does not display a decorative tenant switcher. The opaque
`tenant.ref` scopes client cache/query keys and stale-response rejection. If organization/shared memberships are
later approved, tenant selection needs a server-authorized membership switch and explicit cross-tab/cache
semantics; it must not be improvised from a header or URL slug.

### 6.2 Capabilities, roles, and resource state

The API returns effective presentation capabilities such as read tenant portfolio, manage profile, manage venue
connections, request tenant lifecycle, request tenant control commands, and manage shared paper. The UI may hide
irrelevant navigation and disable temporarily unsafe actions, but every read and mutation is reauthorized at the
API.

The two initial application roles retain their separate scope:

- a `basic_user` sees their personal tenant and can request only the tenant actions allowed by the
  multitenancy design and current safety state;
- a `paper_manager` sees shared paper controls but gains no tenant visibility from that grant;
- a user with both sees both sections, still backed by different targets, resources, and command envelopes.

Do not send the engine a role list or profile. Do not let a Client Component construct permission by combining
several booleans. The server's effective capability DTO is display guidance only; command authorization remains
server-side.

### 6.3 Tenant-safe client state

- Every private request carries the opaque web session; the BFF resolves tenant ownership server-side.
- Query/cache keys include session and tenant context. On logout, session replacement, or tenant-context change,
  cancel in-flight requests and destroy all private client cache entries before rendering another principal.
- Responses carry tenant context and revision; a late response from an old context is discarded.
- Private financial DTOs are not persisted in `localStorage`, IndexedDB, service-worker caches, or offline HTML.
- Theme and non-sensitive device preferences may remain local, but they cannot carry tenant identity or trading
  state.
- One tenant's `401`, `404`, stale heartbeat, or blocked connection never changes shared paper or another
  tenant's presentation state.

## 7. Information architecture

The current modal-heavy dashboard should become a stable shell with routes that can be refreshed, linked,
bookmarked, and audited independently.

| Route | Audience | Purpose |
| --- | --- | --- |
| `/` | Public | Public research, market overview, bounded shared-paper summary, sign-in entry. |
| `/app` | Signed in | Redirect to the signed-in research/overview route after viewer bootstrap. |
| `/app/markets` | Signed in | Shared research/decision projection; no tenant credential or money authority. |
| `/app/paper` | Signed in | Shared paper performance and history; management controls only with `paper_manager`. |
| `/app/portfolio` | Tenant member | Tenant balances, positions, orders, fills, P&L, and account freshness. |
| `/app/automation` | Tenant member | Cell lifecycle, operator intent, budget, reconciliation, drain, risk, and asynchronous commands. |
| `/app/connections` | Tenant member | Venue connection setup, testing, rotation, disablement, and sanitized account metadata. |
| `/app/research` | Signed in | Advisory research workspace; never receives secret or order authority. |
| `/app/settings/profile` | Signed in | Display name, verified identity attributes, avatar, and personal-tenant label. |
| `/app/settings/security` | Signed in | MFA-provider link, sessions/devices, connected clients, and security events. |

Responsive navigation uses the same destinations and capability checks at every width. Mobile is not a reduced
permission model. Dialogs remain appropriate for bounded confirmations and details, but not as the only route to
Portfolio, Connections, Automation, or Profile.

The header contains:

- product navigation appropriate to effective capabilities;
- independent shared-paper and tenant-cell status indicators;
- theme control;
- a user button showing the avatar or initials, display name, tenant label, Profile, Security, Connections, and
  Sign out.

Do not collapse research-plane freshness, paper runtime state, tenant compute state, tenant cell state, and
operator intent into one green/red badge.

## 8. Account profile model and UI

“Account” is overloaded, so the UI and API use three separate terms:

1. **Profile** — the human user's application display name, verified identity attributes, avatar, and
   preferences.
2. **Personal tenant** — the user's private live workspace and financial isolation boundary.
3. **Venue connection** — one tenant's provider/environment/account binding and credential status.

The profile does not contain venue credentials, balances, roles, budgets, or engine state. A venue connection is
not an application login. A personal tenant is not a public social profile.

### 8.1 Profile fields

Recommended V1 editable fields:

- display name;
- avatar;
- personal-tenant display label;
- preferred display timezone and locale, if product-wide formatting is implemented consistently.

UTC remains authoritative for keys, calculations, API timestamps, and audit. A profile timezone changes labels
only. The verified email is read-only identity-provider data and is never the local identity key. Email change,
MFA, passkeys, and recovery happen at the identity provider.

A profile update uses an optimistic revision and returns a minimal sanitized DTO. Display names are Unicode
text with explicit normalized length bounds, rendered as text only, and never used as a URL, storage key, log
label, tenant key, or venue identity. Profile updates are synchronous application-data mutations; they do not
become engine commands or pause/resume trading.

### 8.2 Identity synchronization

On first login, the identity service may seed display name and avatar from verified OIDC claims. Later logins do
not silently overwrite user-edited application profile fields. Provider email verification/status may update the
read-only identity view. OIDC issuer/subject, token claims, and administrative identity metadata stay outside the
profile DTO.

### 8.3 Account lifecycle

The profile page links to, but does not pretend to complete, account export or deletion. Deletion first revokes
sessions as approved, requests tenant pause-and-drain, resolves open financial lifecycle, handles venue-secret
revocation, and applies the approved retention policy. The UI distinguishes **requested**, **awaiting cell
acknowledgement**, **blocked**, and **eligible for retention/deletion processing**. It never deletes a live ledger
because a profile row was removed.

## 9. Avatar support

### 9.1 Sources and display

Avatar precedence is:

1. current user-uploaded avatar;
2. validated copy imported from the configured identity provider at enrollment;
3. deterministic initials derived from the current display name;
4. generic user icon when no safe initials exist.

Avatars are private profile data by default. They are shown only to the owning user in V1; there is no public
profile, leaderboard, social sharing, or cross-tenant directory. Alt text uses the display name where useful;
decorative header instances use an empty alt value beside visible text.

### 9.2 Upload pipeline

The ordinary Next.js filesystem is never avatar storage. The recommended flow is:

1. A recently authenticated user requests an upload transaction against the current profile revision.
2. The API returns a short-lived, single-purpose staging upload target with an opaque object key. The key
   contains no email, display name, user ID, or tenant ID.
3. The browser optionally crops the image and uploads directly to staging. Client processing is convenience,
   never validation.
4. A trusted image worker decodes the bytes under strict byte, pixel, frame, timeout, and memory limits; rejects
   malformed/polyglot content; strips metadata; applies orientation; center-crops the approved square; and
   re-encodes fixed application variants.
5. Finalization atomically advances the profile avatar version only after processed objects exist. Unfinalized
   staging objects expire automatically.
6. The API returns a private, bounded avatar DTO. Old versions age out under the profile-retention policy and
   are never addressed by user-supplied object keys.

Recommended V1 input bounds are JPEG, PNG, or WebP only; no SVG, animated image, remote arbitrary URL, or active
content. Exact byte/pixel limits and output dimensions are constants fixed during approval and covered by image
bomb and malformed-file tests. Identity-provider images are copied through the same validation pipeline from an
allowlisted provider response; the browser does not hotlink an arbitrary `picture` URL.

Avatar reads use an authorized same-origin resource or short-lived scoped object URL. They never depend on a
local `public/avatars` directory. CSP `img-src` is limited to the application and approved avatar storage. A
failed image load immediately falls back to initials without exposing an object-store diagnostic.

### 9.3 Delete and privacy behavior

Removing an avatar advances the profile revision to the initials fallback and schedules stored variants for
retention-compliant deletion. It does not delete identity-provider data or change the OIDC account. Avatar URLs
are not written into execution evidence, notifications, analytics, audit messages, or engine projections.

## 10. Venue account authentication and Connections UI

### 10.1 Registered setup methods

Provider authentication is not one generic username/password form. The application API exposes a versioned,
compiled setup descriptor for each implemented provider/environment connection method. Supported descriptor
kinds may include:

- OAuth authorization-code connection;
- API key plus secret/passphrase fields;
- key ID plus asymmetric private-key material;
- wallet address plus wallet-signature challenge;
- public address/account monitoring with no trade authentication.

A descriptor states field labels, secret/public classification, accepted file/text shape, official help link,
connection capabilities, and whether the method is implemented for that provider/environment. It cannot grant a
capability absent from the provider/market registries. Unknown descriptor kinds fail closed rather than rendering
a generic JSON editor.

Provider-specific adapter code still owns signing, environment, account identity, and capability verification.
The UI never infers that two providers share credential mechanics because their forms look similar.

### 10.2 Connection workflow

1. **Choose provider and environment.** Show compiled read/paper/live capability separately. An unavailable method
   is explanatory and not selectable.
2. **Create a tenant-owned draft.** The API verifies membership, effective capability, step-up where required,
   and one-active-account constraints.
3. **Authenticate.** OAuth uses server-bound state/nonce/PKCE. Secret material uses the dedicated no-log
   credential-ingest service and preferably client-side envelope encryption to a single-use tenant/cell
   ingestion key. Wallet methods sign a nonce scoped to provider, environment, tenant connection, origin, and
   expiry.
4. **Test asynchronously.** A runtime with only the required scoped secret version performs authoritative signed
   reads and publishes sanitized connectivity, environment, capability, account-fingerprint, and error codes.
5. **Confirm account identity.** The duplicate-account fingerprint rule rejects the same authoritative venue
   account in another active tenant. The browser never receives the raw account ID merely to perform this check.
6. **Finish disconnected from trading authority.** A successful connection is `connected`/`tested`; it starts
   live-disabled, paused, with no budget and no Resume side effect.
7. **Configure separately.** Provider permission, budget, mode, reconciliation, and Resume remain tenant-cell
   commands with all existing asynchronous and safety semantics.

The credential form loads no third-party scripts, analytics, session replay, support widget, or remote image.
Secrets are never copied into React query caches, browser storage, URL/search params, Server Action closures,
command payloads, logs, traces, error trackers, profile rows, or ordinary application database records. After
submission or session failure, secret inputs are cleared rather than restored.

### 10.3 Connection states

The connection card keeps these facts separate:

- setup: absent, draft, credential received, testing, connected, test failed, rotation required, revoked;
- account access: public read, authenticated read, trade authenticated;
- provider permission: research visible, paper eligible, live disabled/enabled;
- cell readiness: runtime unobserved, reconciling, ready, blocked;
- environment: demo/test/production from verified connector metadata;
- freshness: last successful signed test and last reconciliation;
- budget/control: configured separately and never implied by connection.

A single “Connected” badge is insufficient. Errors use stable sanitized codes and setup guidance; raw venue
responses, key IDs, key paths, account IDs, and signatures are not rendered.

### 10.4 Rotation, disablement, and deletion

- **Retest** makes no permission or budget change.
- **Rotate** creates a secret version, blocks new exposure, verifies unchanged account identity, and switches only
  after the cell's quiescent/reconciliation rules pass.
- **Disable new entries** preserves enough credential access for cancellation, reduce-only management,
  reconciliation, and settlement.
- **Disconnect/delete** requires step-up, typed confirmation, paused/quiescent state, no unresolved credential
  lifecycle, and explicit venue-revocation guidance. Local deletion is not described as revocation at the venue.
- Secret values are write-only: there is no Reveal, Download, Copy existing key, or return-to-form operation.

A connection may have a user-editable nickname, but its authoritative provider/environment/account fingerprint
is separate and immutable. A nickname cannot select a ledger or execution account.

## 11. UI/API contract and mutation semantics

### 11.1 Server-only API client

This follows the installed Next.js guidance in `node_modules/next/dist/docs/01-app/02-guides/authentication.md`
and `data-security.md`: use a server-only data-access layer, return minimal DTOs, and recheck authentication,
authorization, ownership, and input at each Route Handler or Server Action rather than trusting a layout or
hidden control.

Create one server-only web data layer that:

- verifies the opaque web session;
- obtains/refreshes the correct application API credential server-side;
- calls versioned resources with bounded timeouts;
- preserves request, session, tenant-context, idempotency, and trace identities without logging secrets;
- maps only explicit DTO schemas into React props;
- disables caching for private resources;
- rejects unknown API/protocol versions rather than rendering guessed fields.

Client Components call thin same-origin BFF endpoints or Server Actions that delegate to this layer. Route
Handlers and Server Actions remain public entry points and repeat authentication, authorization, ownership,
Origin/CSRF, input-schema, body-size, revision, idempotency, and rate-limit checks. A page or layout check is
never considered sufficient.

### 11.2 Error semantics

The UI handles stable classes consistently:

| Result | UI behavior |
| --- | --- |
| `401` session invalid | Clear private cache, preserve only a safe relative return target, and request sign-in. |
| step-up required | Start a single-use reauthentication transaction; do not auto-submit afterward. |
| `403` capability missing | Hide future attempts and show a bounded permission message. |
| `404` absent/not owned | Same bounded not-found state; do not reveal cross-tenant existence. |
| revision conflict | Reload the resource and require user review; never merge a money or credential change silently. |
| rate limited | Respect server retry time and do not fan out retries from several components. |
| runtime stale/unobserved | Keep read history where authorized, disable unsafe commands, and retain offline Pause if the command DB accepts it. |
| API/protocol incompatible | Block affected private controls and show upgrade-required; do not fall back to a legacy direct route. |

### 11.3 Asynchronous operations

Trading commands, credential tests/rotations requiring a cell, and runtime lifecycle requests return `202` plus
an operation ID. The UI follows that exact operation through requested, applying, succeeded, rejected, expired,
or recovery-required states. Closing a dialog, refreshing, navigating, or timing out does not cancel it.

Profile edits and finalized avatar changes may complete synchronously because they mutate application profile
data only. They still use optimistic revision, idempotency where applicable, and sanitized return DTOs.

### 11.4 Database read-model guarantees

Each API resource must name its database owner/projector, tenant/public key, schema version, source revision,
database revision, generated/observed timestamps, freshness deadline, retention, and bounded pagination policy.
A successful projection write is atomic at that resource boundary. A page that combines resources either uses a
published consistency token/snapshot or displays their independent source times; the BFF must not imply that
separately aged portfolio, runtime, and connection rows are one atomic engine observation.

Operation states are monotonic and committed before a `202` is returned. Operation lookup is read-your-write for
the authorized principal, while engine/cell application remains asynchronous. Paginated financial history uses
stable snapshot cursors so inserts cannot duplicate or omit rows while a client advances. Projection rebuilds
publish a newer complete revision rather than exposing a partially rebuilt current view.

Every API query is bounded and fails explicitly when its schema, consistency token, or freshness contract cannot
be met. It never falls through to an engine call or filesystem read. Exact freshness budgets and retention periods
belong to the resource schemas and must be fixed before implementing each page; “database-backed” alone is not a
freshness or completeness guarantee.

## 12. Security and privacy requirements

- Treat tenant balances, budgets, positions, orders, fills, P&L, connection metadata, and activity as restricted
  private financial information on every route and in every client state container.
- Use a strict CSP. Credential pages permit no third-party script or frame. Profile names and connection
  nicknames render as text only.
- Enforce same-origin/CSRF protections on cookie-authenticated mutations, including logout and profile/avatar
  finalization. OIDC state/nonce/PKCE does not replace ordinary application CSRF protection.
- Keep access/refresh tokens, secret references, OIDC subject, role rows, raw API errors, and complete provider
  account identifiers out of Client Component props and RSC payloads.
- Keep private endpoints `private, no-store`; verify no public CDN or Next cache can reuse an authenticated
  response. Avatars use their separately approved private cache policy and immutable version identity.
- Do not place P&L, venue, position, connection, user email, or tenant identity in browser notifications,
  analytics events, lock-screen push payloads, document titles, or URLs.
- Add `server-only` boundaries to the web API/session layer and import-boundary tests preventing web code from
  reaching engine, secret-broker internals, scheduler SDKs, or database drivers.
- Use React/Next taint protection only as defense in depth; DTO minimization and authorization remain required.
- Production data and credentials are never used in the local development/test profile. Synthetic fixtures and
  demo venue environments are required there. A local standalone production profile may use the owner's real
  data only through its approved database, secret plane, tenant cell, and funded safety gates.

## 13. Accessibility and responsive behavior

- All authentication, profile, avatar, connection, and confirmation workflows are keyboard operable and have
  visible focus, programmatic labels, error summaries, and announced asynchronous status changes.
- Provider status is conveyed by text and icon as well as color. “Connected,” “live enabled,” “ready,” and
  “active” use distinct language.
- Avatar crop has a no-crop accessible fallback; initials remain legible at supported sizes and do not rely on
  color alone.
- Sensitive confirmations do not use hover-only help or mobile-inaccessible dialogs.
- The desktop navigation and mobile menu expose the same authorized destinations. Responsive hiding never
  changes permissions or makes Pause unreachable.
- Loading skeletons do not imply a safe or active state. Stale/unobserved facts remain visible until replaced by
  a newer source timestamp.

## 14. Proposed code boundaries

Exact names may change, but dependency direction may not:

```text
src/app/(public)/*                         public research and auth entry
src/app/(app)/app/*                       authenticated route shell and pages
src/app/api/app/*                         thin same-origin BFF endpoints
src/components/app-shell/*                navigation, user menu, capability-aware presentation
src/components/profile/*                  profile and avatar UI
src/components/connections/*              typed provider setup UI
src/components/tenant/*                   private portfolio/control read models
src/lib/app-contracts/*                    client-neutral DTO/operation schemas and generated client types
src/lib/app-client/*                       transport-neutral fetch/query/state helpers; no Next or engine imports
src/lib/web-auth/*                         server-only OIDC/session adapter
src/lib/web-api/*                          server-only application API client and DTO validation
src/lib/web-capabilities/*                 pure presentation helpers over server-issued capabilities
```

Shared components receive DTOs, capabilities, clocks, navigation callbacks, and mutation interfaces as inputs;
they do not import Next server modules or assume a cookie transport. Next-specific route loading, RSC composition,
same-origin BFF calls, image delivery, and browser navigation stay in the web adapter.

An Electron wrapper is explicitly deferred and would be a separate client application, not a mode hidden inside
the Next build. It may reuse the client-neutral contracts, pure state helpers, design tokens, and components that
avoid web-server assumptions. Its renderer remains an untrusted frontend: no database, engine, scheduler, venue,
or secret credential is bundled into it. Desktop OIDC uses the system browser with PKCE and OS-secure token
storage under a separately registered client; a main-process API bridge must be narrow, typed, and unable to turn
renderer input into direct engine access.

Forbidden imports are:

- Client Components or shared frontend packages to `process.env`, database clients, auth tokens, secret code,
  engine code, scheduler adapters, or stores;
- web auth/API modules to execution, venue signing, reconciliation, worker bootstrap, or scheduler SDKs;
- profile/avatar modules to tenant budget, policy, forecast, or order code;
- connection components to provider private SDKs or secret-store SDKs;
- engine/research/paper code to React, Next routes, profile, avatar, or OIDC UI modules.

Do not make the existing `DashboardData` the canonical application API. Public research, shared paper, viewer,
profile, connection, tenant portfolio, tenant control, and operation status are separately bounded resources.

## 15. Delivery plan

### Phase U0 — approve UX, identity, and privacy decisions

- Select the OIDC provider and maintained web auth library.
- Approve enrollment, step-up, session, profile, avatar, connection, retention, and route decisions below.
- Approve the local Postgres/application-API stack, local supervisor/secret backends, and cloud placement backend.
- Freeze initial client-neutral DTOs, database projection contracts, and public/private cache boundaries.

**Gate:** this design and the required backend designs are approved; no implementation against the current
combined engine.

### Phase U1 — API-only web foundation

- Add the server-only API client, DTO validators, route shell, error semantics, and synthetic contract fixtures.
- Build the public and authenticated shells without private controls.
- Run the same production build against a local API/Postgres fixture stack and a preview cloud API.

**Gate:** no component or BFF imports database drivers, engine/store modules, or runtime backends; identical
fixtures render identically in local and deployed profiles; no deployment flag changes UI semantics.

### Phase U2 — OIDC and tenant viewer bootstrap

- Implement sign-in/callback/sign-out, revocable opaque web sessions, viewer bootstrap, personal-tenant context,
  capability navigation, and security/session page.
- Remove the shared password route after a bounded migration of the existing operator.

**Gate:** OIDC state/nonce/PKCE, CSRF, return-target, revocation, role, stale-session, and cross-tenant tests pass;
there is no runtime auth bypass.

### Phase U3 — profile and avatars

- Add profile revisions, identity synchronization, private avatar staging/processing/finalization, fallbacks, and
  account-lifecycle status.

**Gate:** malformed/image-bomb/privacy/cache tests pass; no avatar/profile field reaches engine, paper, research
  evidence, or another user.

### Phase U4 — venue Connections

- Implement setup-descriptor rendering, OAuth/secret/wallet flows as actually supported, async connectivity
  tests, account uniqueness, rotation, disablement, and deletion.
- Migrate the original operator's credentials only through the paused secret-plane procedure in the
  multitenancy design.

**Gate:** canary secrets never appear in browser persistence, DB payloads, commands, logs, traces, errors,
exports, or read models; a successful connection cannot enable live, allocate budget, or Resume.

### Phase U5 — tenant portfolio and asynchronous controls

- Replace direct account/control dialogs with tenant projection pages and operation-following UX.
- Add paper-manager controls against the separate paper target.
- Exercise the same pages against one supervised local runtime backend and the selected cloud backend.
- Preserve every engine-separation status distinction and typed confirmation.

**Gate:** wrong-tenant, wrong-role, stale-heartbeat, stale-boot, stale-revision, step-up, duplicate, retry, browser
refresh, operation-recovery, and local-supervisor/cloud-scheduler failure cases fail closed; all existing money
and invariant tests pass unchanged.

### Phase U6 — remove legacy direct and deployment-branched paths

- Delete the shared password UI, direct-store Route Handlers, environment credential instructions, component
  deployment checks, combined-runtime controls, and authenticated expansion of public dashboard payloads.
- Run local-standalone, local-development, preview, and production parity checks and document operator recovery.

**Gate:** the web artifact contains no worker startup, database credential, venue secret, direct money-store
access, or local-only engine-control path. Local and cloud remain supported service-placement profiles through the
same API. A web deploy/restart does not change any engine or cell boot ID.

## 16. Acceptance tests

Before this UI can accept a second person's identity or credential:

1. **Frontend parity:** one production web build rendered against the same recorded API fixtures produces the
   same routes, capabilities, polling, command states, and accessibility tree locally and when deployed. A static
   boundary test rejects `VERCEL`, `MONEY_NOODLE_STATELESS`, database-driver, worker-store, execution, and
   scheduler imports in UI/BFF modules.
2. **Database-backed UI:** restart/replace the web process during every page and operation; viewer, profile,
   projections, revisions, commands, and operation follow-up reload from the API/database without reading an
   engine or losing acknowledged state. API outage never triggers file/process/localhost fallback. Torn
   projection rebuilds, mixed resource ages, and inserts during pagination preserve the declared snapshot or
   display independent freshness without duplicate/omitted financial rows.
3. **Placement conformance:** run the same lifecycle and status suite against a supervised local engine backend
   and the selected cloud backend. Both use durable target/fence/command/projection protocols; Start never means
   Resume, web restart never changes an engine boot ID, and backend status never asserts reconciliation safety.
4. **Authentication matrix:** sign-in, sign-up/enrollment, callback replay, bad state/nonce/PKCE, expired code,
   logout, global revocation, disabled user, provider outage, session expiry, and step-up pass end to end.
5. **Tenant/role matrix:** every route, loader, BFF endpoint, action, cache, operation lookup, and late response is
   tested as owner, another tenant, `basic_user`, `paper_manager`, both, revoked, and unauthenticated.
6. **Cache isolation:** private DTOs never enter public HTML/CDN/Next caches, service workers, browser persistence,
   or another session after logout/login or context replacement.
7. **Connection isolation:** unknown setup descriptors fail closed; OAuth callback swapping, wallet challenge
   replay, duplicate account, wrong environment, secret rotation crash, and connection deletion cannot cross
   tenant or imply live readiness.
8. **Secret non-disclosure:** seeded canary credentials do not appear in client props/RSC payloads, browser
   history/storage, ordinary DB rows, command payloads, logs, traces, errors, analytics, exports, or screenshots
   produced by automated failure reporting.
9. **Avatar safety:** wrong tenant, oversized file, pixel bomb, malformed metadata, polyglot, SVG, animation,
   stale revision, abandoned upload, and object-key guessing fail without serving unvalidated bytes.
10. **Operation UX:** refresh, navigation, multiple tabs, network loss, `202` timeout, conflict, rejection, and
   recovery-required states follow one durable operation and never show requested as succeeded.
11. **Status semantics:** tests separately pin control-plane reachability, runtime allocation and placement, cell heartbeat,
   lifecycle, intent, automation, reconciliation, drain, and command state. No UI label infers safety from a
   missing heartbeat or stopped task.
12. **Accessibility/responsiveness:** automated and manual keyboard/screen-reader tests cover auth, user menu,
    profile, avatar, connections, typed confirmation, Pause, errors, and mobile navigation.
13. Existing `mirror-invariant`, `strategy-isolation`, `venue-target-integrity`, `budget-ledger`, and
    `policy-manifest` tests pass unchanged. UI work adds no execution mode, tenant, profile, or avatar input to a
    production rule.

## 17. Alternatives considered

### A. Keep the password locally and use OIDC only on Vercel

Rejected. It creates two auth products, leaves the highest-authority local path without user identity,
revocation, MFA, or role enforcement, and violates the parity requirement.

### B. Let local UI call a local engine directly while deployed UI calls the application API

Rejected. The local path would continue exercising direct stores or synchronous engine controls that the cloud
path never uses. Local engines are supported, but they consume commands and publish projections through the
local application/control/database stack. Both web profiles consume the same API.

### C. Put venue credentials in user profile rows

Rejected. Profile data is ordinary application/PII data and may be returned to the browser. Venue secrets require
a write-only secret plane, scoped delegation, separate lifecycle, and cell reconciliation.

### D. One generic JSON credential form for every provider

Rejected. It hides provider-specific signing and account semantics, makes secret classification unauditable, and
can imply unimplemented capability. Use compiled discriminated setup descriptors and provider-specific adapters.

### E. Public avatar URLs

Rejected for V1. There is no public profile or social surface, and stable public URLs create unnecessary PII and
cross-site correlation. Use private versioned delivery and initials fallback.

### F. Tenant selection from a request header or local storage

Rejected. A client-selected tenant is input, not authority, and stale browser state creates cross-tenant cache
risk. V1 resolves the sole personal tenant from current membership server-side.

### G. Keep all application surfaces in dashboard dialogs

Rejected. Profile, security, connection, portfolio, and command workflows require durable URLs, independent data
loading, refresh recovery, accessibility, and mobile parity. Dialogs remain for bounded confirmation only.

### H. Require cloud engines whenever the web UI runs locally

Rejected. It makes local development depend on cloud availability, prevents a self-contained standalone
installation, and fails to exercise the local runtime backend. Local and cloud engines are placement profiles
behind one API and lifecycle contract; neither creates a frontend-to-engine path.

### I. Make Electron another deployment mode of the Next server

Rejected. A desktop shell has different authentication, update, secure-storage, navigation, and process trust
boundaries. If built, it is a separate API client that reuses client-neutral contracts and safe components; it
never bundles the web BFF, engine, or database authority into its renderer.

## 18. Decisions requested in review

1. **Identity provider/library:** which OIDC provider and maintained Next-compatible library should supply MFA,
   passkeys, recovery, session revocation, and step-up? The recommendation is not to build passwords or raw OIDC
   token handling in application code.
2. **Enrollment:** invite-only initially (recommended before multi-user credential intake), approved-email
   allowlist, or open registration?
3. **Local identity:** for development, approve a real non-production OIDC tenant, an isolated local OIDC
   provider with synthetic users, or both? For standalone funded use, must the approved provider be hosted, or
   may a separately operated local provider supply passkeys/MFA, recovery, revocation, and step-up? There is no
   developer user/password bypass in any case.
4. **Routes:** approve the route-based application shell and replacement of Portfolio, Automation, Connections,
   and Profile dialogs?
5. **Profile scope:** approve display name, avatar, personal-tenant label, and optional display timezone/locale as
   the complete editable V1 profile? Confirm there is no public profile.
6. **Avatar policy:** approve private avatars, validated JPEG/PNG/WebP input, fixed re-encoded variants, initials
   fallback, and no SVG/animation/arbitrary remote URL? Exact size/pixel/output limits must be fixed here before
   implementation.
7. **Venue setup:** approve compiled typed setup descriptors and write-only secret ingestion rather than
   environment variables or generic credential JSON? Which provider connection is the first V1 vertical slice?
8. **Connection naming:** should users be allowed a private connection nickname while authoritative account
   identity remains immutable and hidden?
9. **Session behavior:** choose ordinary session lifetime, inactivity policy, and recent-step-up window. Confirm
   that ordinary sign-out does not pause a healthy tenant cell, while approved takeover/recovery events do
   request pause-and-drain.
10. **Private avatar delivery:** approve authorized same-origin delivery (simpler privacy) or short-lived scoped
    object URLs (lower BFF load), with no public stable URL?
11. **Account lifecycle:** approve the export/deletion presentation only after retention, venue revocation, and
    paused/restart-safe lifecycle policies are settled?
12. **Parity gate:** approve removal of every `stateless`/Vercel/local-worker UI branch and require both local
    and deployed profiles to use the same database-backed API/session/command/projection/lifecycle protocols?
13. **Local stack:** approve local Postgres plus a local application API, runtime-controller/supervisor adapter,
    secret backend, and object backend as the reference standalone profile? Which supervisor and packaging model
    should be prototyped first?
14. **Cloud stack:** which cloud runtime backend and managed database/secret/object services should be the first
    deployed profile? The choice must remain behind the placement-neutral contracts.
15. **Desktop reuse:** approve Electron, if pursued, as a separate client application reusing client-neutral
    contracts/design-system components rather than as a privileged wrapper around local engines?
16. **Standalone connectivity:** must a local standalone installation remain usable for sign-in and existing
    database-backed history when the public Internet or hosted identity provider is unavailable? This decides
    whether a local OIDC provider and offline-read policy are required; it does not permit stale data to authorize
    trading.
17. **Projection service levels:** what freshness, retention, pagination-snapshot, and cross-resource consistency
    guarantees are required for public research, shared paper, portfolio/history, connection, and runtime
    resources before the UI may call them current or complete?

Until these decisions and the prerequisite backend phases are approved, implementation stops at design and
synthetic UI contract fixtures. In particular, do not add a second login path, copy venue keys into profile or
Postgres rows, add avatar files to the Next deployment filesystem, or wire a new interface to the current local
engine stores.
