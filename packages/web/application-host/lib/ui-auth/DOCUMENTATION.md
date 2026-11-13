# UI Auth Module Documentation

## Purpose
This module owns Varin UI authentication for browser access, including password session auth, WebAuthn passkeys, and trusted-device session handling.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/application-host/lib/client-auth/remote-clients.ts`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer varin_client_...`.

Pairing v2 is implemented by `packages/web/application-host/lib/client-auth/pairing.ts`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

Browser-owned URLs are a separate presentation of the same authenticated authority. Elements such as
iframes, downloads, SSE, and WebSocket upgrades cannot attach the normal `Authorization` header, so
`ui-auth.ts` can mint short-lived `varin_url_token` credentials scoped to explicit readable or
realtime paths. Callers obtain them through the shared runtime auth/URL helpers; long-lived client
bearer tokens are never placed in URLs. Unknown paths and legacy token query parameters are rejected
rather than becoming a compatibility write path. Session-derived grants retain session
authority. Client-derived grants revalidate the original bearer on each use,
including current capabilities, directory limits, and revocation; the bearer
remains only in the short-lived in-memory grant and is never returned in a URL.
A saved-connection proxy prefix does not expand the inner read/realtime path
allowlist, and the proxy additionally requires Host-wide full-control authority.
The packaged desktop UI authenticates application-Host fetches (including profile
selection, extension management and plugin-center requests) with the desktop-local
bearer obtained from its IPC bridge. This credential stays bound to the local
origin independently of the selected remote runtime's bearer and proxy headers;
browser cookies alone cannot authenticate cross-origin requests after the user
enables a desktop UI password. URL credentials remain for browser-owned URLs and
WebSocket handshakes; the observation transport waits for the local grant before
opening a cross-origin socket. A failed initial extension catalog read exposes
the workspace recovery screen instead of keeping the splash covered.
When client authentication is required without a UI password, arbitrary session
cookies are not trusted and missing credentials cannot mint a session.

WebSocket URL-token paths are enumerated by `isUrlAuthWebSocketPath`. Relay reachability has its own
independent allowlist in `packages/web/application-host/lib/relay/tunnel-host.ts`; adding a realtime endpoint
requires both gates while leaving the normal origin and server authentication checks intact.

## Entrypoints and structure
- `packages/web/application-host/lib/ui-auth/ui-auth.ts`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/application-host/lib/ui-auth/ui-passkeys.ts`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/application-host/lib/client-auth/remote-clients.ts`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/application-host/lib/client-auth/pairing.ts`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDisk })`: creates UI auth controller with methods:
  - `enabled`
  - `requireAuth(req, res, next)`
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `resolveWebSocketAuthContext(req)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDisk, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`

## Stable authentication subjects

`principals.ts` persists the authentication owner's subject independently of JWT secrets,
passkeys, bearer IDs and device rotation. Existing password and trusted-local bootstrap flows
issue that subject; passkeys and pairing retain the issuing subject. Legacy authenticated
credentials migrate to the existing owner, while arbitrary cookies on an unauthenticated Host
remain unattributed. The subject store is not a plugin account directory or a new user enrollment
API. Additional subjects must come from a trusted authentication owner, not request bodies.

The authenticated request context supplies Thread creation ownership. Rust Catalog persists it
on Threads and Runs and preserves it for child/summary work. Its first initialization records
whether existing single-owner history is claimed; enabling authentication later never silently
reassigns previously public work. Plugin credential capability calls borrow a subject only from
an authenticated Surface service lease or an actual retained Run tool invocation. Service
arguments, routing labels and copied invocation IDs cannot establish identity.

## Read-path authority and lifecycle

The principal store initializes once, using a transaction only to persist the first
owner. Its parsed document remains immutable for the Host lifetime. Subject changes
are not a runtime API; a trusted update is loaded at the next startup. Existing
malformed stores fail initialization without being replaced.

The remote-client runtime is shared by resolved credential-store path. Its first
consumer loads and normalizes records; construction alone performs no I/O or
identity creation before the Host's offline-restore startup fence. Concurrent
consumers share initialization, then bearer authentication uses a token-hash index without
file reads or transactions. Creation, rotation, revocation and purge publish a new
index only after the file transaction succeeds. Returned capability/directory arrays
are copies, not mutable grants. Last-used and transport telemetry updates immediately
in memory and flushes asynchronously on the existing throttle; sticky relay demand
survives direct/relay switching. Pending telemetry merges into credential mutations
without reviving revoked or rotated tokens. Shutdown flushes it and releases the
shared runtime so a subsequent Host can reload persisted state.

`resolveRequestAuth` memoizes in-flight authentication by request identity, including
session verification and bearer resolution. Session-only and URL-token-disabled
callers retain their narrower policies. Auth middleware, principal access checks,
route contexts and WebSocket authorization share these results, not a credential
cache spanning requests. Secret rotation invalidates request caches as well as URL
grants.

Thread middleware establishes principal/Host-owner context and gates explicit Host
sources. It does not scan arbitrary JSON or read Catalog records. Routes explicitly
declare read/write intent and authorize the exact Thread, Run, Operation and Input
selectors they consume, including nested family/message/media/follow-up selectors
and handoff background references. Public reads remain visible; authenticated public
writes require the Host owner. Export, attachment query routes and interactive UI
use the same boundary. The shared ownership resolver batches misses and retains
only immutable positive Catalog mappings after principal initialization. Missing
IDs fail closed and are not negative-cached.
