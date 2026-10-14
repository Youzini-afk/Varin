# Model credential ownership

The Application Host supplies one credential authority to the Agent runtime and brokered Pi
sessions, compaction and inference. The production integration is present; it is not an environment-only
prototype. Model adapters consume transient dispatch headers and never open a second credential file.

## Owners and entry points

- [HostCredentialAuthority](../../../../../packages/pi-host/src/credential-authority.ts) exposes
  `sharedHostCredentialAuthority(agentDir)` over the existing Pi SDK `CredentialStore` and
  `FileAuthStorageBackend` pathname lock. Interactive auth remains with
  [ProviderAuthBridge](../../../../../packages/pi-host/src/provider-auth-bridge.ts).
- [Provider configuration](../../../../../packages/pi-host/src/provider-configuration.ts) owns trusted
  `models.json` composition; background inference excludes project overrides.
- [Model authority](../../../../../packages/web/application-host/lib/kernel/model-authority.ts) resolves
  registered provider/model IDs, routing and nonsecret binding identity. The renderer cannot supply
  endpoints, token URLs or credentials through a model-history field.
- [Host credential owner](../../../../../packages/web/application-host/lib/kernel/credential-owner.ts)
  and [bridge](../../../../../packages/web/application-host/lib/kernel/credential-bridge.ts) supply the
  private kernel rendezvous. [host_auth.rs](host_auth.rs) is the adapter-side resolver.
- [auth.rs](auth.rs) also defines the injectable transactional `CredentialBroker`, `CredentialScope`,
  store/refresh traits and bounded HTTPS public-client refresh implementation.

Brokered Pi workers inject `RemoteCredentialStore`; private auth messages are handled outside public
protocol events/results. Standalone Pi launches retain their own existing owner when no Application
Host channel exists. Neither path writes an additional credential journal/database.

## Identity and persistence invariants

A `CredentialScope` contains only reference, authority, account/source identity and relink generation.
Its owner-issued local handle is not an external account ID or token digest. Verified provider account
metadata is separate; Codex requires that metadata with its token. Do not decode an arbitrary JWT in
the adapter and treat its claims as verified authorization.

Ordinary same-account refresh preserves the scope. Explicit replacement or a verified account change
advances generation in the same credential-store transaction. Dispatch checks the pinned scope before
resolution/refresh and again before returning headers. Rebinding a durable launch restores the original
scope instead of silently adopting the current account. Connection identity scopes opaque model history.

The Host serializes read-modify-write using the original store lock, persists successful refresh and
binding metadata together by temporary-file sync/atomic rename, then releases the lock. Existing
mode/ownership is retained where supported; this is not a claim of complete Windows/extended-ACL parity.
A failed write cannot be reported as a successfully rotated durable credential.

An expired stored OAuth credential remains its selected credential source. Refresh failure, missing
entry, type mismatch, revoked account and persistence failure are explicit errors; none falls through
to an ambient API key or configured header. Credentials/header values are transient and excluded from
history, public events, debug formatting and credential-control request bodies.

Cancellation before refresh prevents dispatch. Once refresh starts, the caller may stop waiting, but
the bounded refresh/persistence transaction must finish: abandoning it could lose the only valid
rotated refresh token. The injectable broker uses per-reference transactions, not a global provider
lock, and its worker can settle after its waiting caller disappears. Registered refresh endpoints have
bounded responses/timeouts with redirects and automatic retries disabled. This module does not perform
login, broaden scopes, create client secrets or discover accounts on its own.

## Configured and dynamic credential sources

Literal `models.json` keys use the original configuration lock/JSONC writer and owner-issued handle.
Their nonsecret filesystem revision participates in scope; editing that file invalidates its configured
bindings, including unrelated-provider edits. Stored `auth.json` bindings keep their SDK precedence and
are unaffected. Per-provider revision granularity is a possible optimization, not current behavior.

Environment values, configured key helpers and ambient bearer/API keys use random owner-local leases.
Values are compared only in memory; no token hash or resolved helper output is persisted. Model listing
does not execute helpers. Key commands retain the locked SDK's process-lifetime command cache, and
Agent dispatch passes the pinned value through the SDK override instead of executing a helper twice.

Configured provider/model headers are part of the same source binding. Header helpers retain their
uncached SDK semantics: changed output invalidates the pinned selection instead of sending another
account under old continuation identity. Header-only connections use those pinned headers directly;
stored OAuth failure still cannot fall through. Dynamic/ambient source leases require fresh trusted
selection after value changes or Host restart.

## Cloud and subscription paths

### Google Vertex

[The Google owner](../../../../../packages/pi-host/src/native-google-auth.ts) loads the locked SDK's
Google Auth dependency for ADC. An explicit/default ADC file's nonsecret filesystem identity is pinned;
metadata-service credentials use an owner-local identity. Google's client owns token refresh/cache,
with no second credential file. ADC routes through selected project/location. Explicit Cloud API keys
use `x-goog-api-key` and express-mode routing; custom collection endpoints preserve their registered
path. Metadata-only dynamic identity requires fresh selection after Host restart.

### AWS Bedrock

[The AWS owner](../../../../../packages/pi-host/src/native-aws-auth.ts) uses the locked SDK's Bedrock
credential provider and Smithy SigV4 signer for IAM/profile/default-chain sources; bearer-key mode
remains separate. The original source identity is pinned independently of rotated temporary credentials.
Dynamic source scope requires fresh selection after Host restart. Model ARN region precedes standard
endpoint/owner defaults.

Private dispatch supplies method, the registered endpoint and lowercase 64-character `payloadSha256`.
The Host checks endpoint/digest shape and sets the canonical payload hash, overriding configured case
variants of `x-amz-content-sha256`. Rust freezes one body allocation for both this digest and outbound
HTTP. No JSON rewriting can occur after hashing. Auth frames contain no request body; the bounded
bridge preflights frames before queueing so one preparation error cannot kill the shared writer.

### Anthropic

[The federation owner](../../../../../packages/pi-host/src/native-anthropic-auth.ts) uses the locked
SDK's JWT-bearer exchange and TokenCache. Source identity binds the configured target plus assertion
issuer/subject/audience equality in memory. Unverified claims only identify an owner-local source lease;
the exchange service validates signature and authorization. Same-principal expiry/JTI/token-file
rotation preserves scope; changed principal/target does not. Refresh rechecks the principal before
exchange. Assertions, claims and exchanged tokens are not persisted, and no SDK disk cache is enabled.
Stored OAuth, API keys and explicit bearer headers preserve precedence. Failed auth never falls through.

Subscription tokens select a distinct `anthropicOauth` configuration, rechecked around refresh.
The SDK owner still handles refresh/persistence; the Rust adapter supplies the matching identity
system block, canonical tool-name mapping and subscription header/body contract. Workload federation
and API-key mode do not receive that contract. Configured beta headers are preserved while mandatory
mode-specific beta values are included.

### Codex

Codex dispatch requires a Bearer token and the authoritative account header for the pinned connection.
Its SSE-specific protocol is documented in [README.md](README.md). Opaque response history cannot be
reused after relink merely because the provider/model display names stayed the same.

## Evidence boundary

Relevant tests exercise temporary stores, refresh/relink/reopen, real Pi worker private IPC, native
loopback model requests and locked Google/AWS/Anthropic helper integrations with controlled credentials.
They establish local ownership and dispatch behavior, not access to a real account. Live IAM/ADC,
subscription accounts, Entra flows, proxies and platform-specific credential chains require their own
acceptance. No user credential values are required to review these contracts.
