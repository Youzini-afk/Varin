# Native credential-broker boundary

This is an implementation contract for replacing the environment-only model binding. It does not
claim that the existing user credential store or OAuth flows have migrated.

## Existing authority and invariants

The locked Pi SDK 1.0.4 defines one typed credential per provider and delegates persistent storage to
the application. `CredentialStore.modify` is the sole serialized read-modify-write path. The current
Host composes its provider runtime from its agent-directory `auth.json` and `models.json`; background
inference excludes project overrides. Interactive authentication is routed by `ProviderAuthBridge`.
Do not introduce a second reader/writer of the existing credential file alongside that authority.

Stored credentials own their connection. An expired OAuth credential must not silently become an
ambient API-key request when refresh fails or the stored type lacks a matching handler. Refresh is
rechecked under the store's identity-specific lock, and the new credential is persisted before the
lock is released. Once the remote refresh starts, a cancellation may not discard a rotated token.
The caller can stop waiting immediately; the bounded refresh/persistence operation must still settle.

## Implemented native seam and remaining integration

- Keep `CredentialResolver::headers` as the model adapter's dispatch-only boundary
- A native broker consumes a trusted credential reference and expected credential/config version
- Inject an authoritative credential store with serialized per-reference transactions and durable
  persistence semantics; the backing store owns cross-process locking
- Inject provider-specific OAuth refresh and auth-header derivation handlers, keyed by a trusted
  provider registration; do not accept an arbitrary token URL from model history
- Maintain single-flight refresh by credential identity, with no global connection lock; unrelated
  providers and already-valid credentials remain independent
- Cancellation before refresh prevents dispatch; cancellation during refresh stops only the waiter
- Refresh failure, missing entry, type mismatch, revoked account and persistence failure remain
  separate typed failures; none fall through to environment credentials
- Secrets and header values are transient and non-serializable/non-Debug; UI and histories contain
  only references, stable account/connection identity and generation, never bearer/refresh material
- `auth.rs` implements `CredentialBroker`, `CredentialScope`, transactional store/refresh traits
  and a bounded HTTPS refresh client. The production factory needs an injected-resolver binding path
  and trusted reference/version fields. The Host store/IPC integration is now present as described
  below; additional platform stores and live provider authorization remain separate acceptance gates

## Codex-specific contract discovered

Locked `api/openai-codex-responses.js` uses `/codex/responses`, `store:false`, a separate top-level
`instructions` field, encrypted reasoning inclusion, optional reasoning/service tier, and session cache
identity. SSE headers include Bearer authorization, `chatgpt-account-id`, `OpenAI-Beta:
responses=experimental`, an originator and session/request identifiers. The account ID is currently
extracted from the token claim, but such decoding is routing metadata rather than signature validation.
An authoritative broker should provide the verified account identity with the token. Do not persist the
JWT payload or infer an account from a model-controlled request field.

A native SSE implementation can reuse Responses event parsing under a separate family and connection
identity. WebSocket incremental continuations, account-keyed socket pooling, compression, and full
Codex-specific capability compatibility remain separate acceptance gates. Merely sending an OpenAI
Responses body to a different URL does not implement this contract.

## Sources inspected

- Locked Pi SDK: `auth/types`, `auth/resolve`, `auth/credential-store`, `auth/oauth/openai-codex`
- Locked Pi SDK: `api/openai-codex-responses`
- Host: `packages/pi-host/src/provider-auth-bridge.ts`
- Host: `packages/pi-host/src/provider-configuration.ts` (`inferenceRuntime` and trust composition)

Only source code was inspected. No user credential files or token values were read.

## Integrated Host authority (current source)

The Application Host now owns `sharedHostCredentialAuthority(agentDir)`. Brokered Pi session,
compaction and inference runtimes inject `RemoteCredentialStore`; private child-process messages are
handled before public protocol validation and never appear in public event/results. The existing
`FileAuthStorageBackend` pathname lock remains the authority; the Host writes one credential JSON
with local binding metadata by temp-file sync and atomic rename under that lock. There is no journal
or second credential database. Existing mode/ownership is preserved where supported; full Windows
and extended-ACL parity is not claimed by the current checks.

The reserved per-credential metadata contains an owner-issued local handle and relink generation.
It is not an invented external account ID. Refresh preserves it; explicit replacement and verified
account change advance it in the same credential write. Verified provider account metadata is separate
and Codex requires it. Native model selection comes from the trusted Host catalog; endpoints cannot be
supplied by the renderer. Durable launch selection pins the scope used when rebinding after restart.

The native kernel rendezvous carries scope and, for body-signed requests, the SHA-256 digest of the
exact serialized request bytes outward and transient header replies inward; neither body nor credentials
enter public events or credential request frames. Host HTTP credential writes and utility OAuth refresh also use the shared owner. Standalone
Pi launches retain their existing owner because they have no parent Application Host channel.
Credential helper/env keys preserve existing Pi resolution in the child. Literal `models.json`
keys use the same Host authority and the existing configuration lock/JSONC writer. Their provider
record receives a durable local handle; the scope combines it with a nonsecret filesystem revision
(device/inode/size/mtime/ctime), never a key digest. An edit anywhere in that file invalidates its
configured-key bindings, including unrelated provider edits. Stored `auth.json` bindings are unaffected
and retain SDK precedence. Per-provider revision precision is a future optimization. Dispatch refreshes
the catalog and checks scope again before returning transient headers; a changed source cannot reuse
a prior opaque-history identity.

Native command/env key sources use an owner-local resolved-value lease. The scope includes a random
local handle, never a token hash; values are compared only in memory. Environment changes create a new
lease. Commands use the locked SDK resolver's process-lifetime command cache. Native dispatch passes
that pinned value through the SDK's explicit API-key override, avoiding a second uncached configured
helper execution. Model enumeration does not run helpers. After owner restart, dynamic scopes require
a fresh trusted selection/new run; the current same-scope resume cannot silently adopt another lease.
No resolved helper output or environment secret is persisted in native history or credential metadata.
Configured provider/model headers are resolved by the same owner and included in the source binding.
Stored credentials retain precedence; configured header sources add the models-file revision and,
for dynamic values, an owner-local value lease. Native dispatch requests model-specific SDK auth and
checks resolved configured headers before returning them. Header helpers retain the SDK's uncached
semantics: changed output invalidates the pinned native selection instead of sending another account
under an old opaque identity. Header-only configured connections use these pinned headers directly;
failed stored OAuth never falls through to them. Enumeration inspects configured expressions without
executing helpers or writing binding metadata.

Ambient SDK API keys and explicit bearer headers likewise receive owner-local leases, including
Bedrock's ambient bearer-token mode. They require fresh selection after token change or Host restart.
Native Vertex explicit Cloud API keys use `x-goog-api-key` and Vertex express-mode routing; configured
collection endpoints retain their registered path. Bedrock stored/configured bearer keys route to
ConverseStream, with model ARN region preceding explicit owner region for standard catalog endpoints.

Vertex ADC now uses the locked SDK's Google Auth dependency through the existing Host owner. An
explicit/default ADC file's nonsecret filesystem identity is pinned; metadata-service credentials use
an owner-local identity. Google's client owns token refresh/cache and no second credential file is
written. ADC selects project/location routing while explicit Cloud keys retain express routing.
Independent review used a temporary fake ADC file and loopback token endpoint to verify real library
loading, refresh, stable scope, sanitized invalid-grant failure and no bearer persistence.

Bedrock IAM/profile/default-chain credentials now use the locked SDK's Bedrock client credential
provider and Smithy SigV4 signer. The private request carries method, registered endpoint and a
64-character lowercase hexadecimal `payloadSha256`, never the serialized body. The Host checks the
frozen endpoint and digest shape before signing. One Rust serializer supplies both the hashed bytes
and outbound HTTP bytes from the same immutable request; the native transport sends those bytes
without JSON rewriting. The existing Smithy signer uses `x-amz-content-sha256` as its canonical payload
hash. The Host overrides configured case variants of that header with the dispatch digest, keeping
SigV4 bound to the native request without copying content across the credential control channel.
The credential bridge preflights its envelope through the existing bounded frame encoder before
queueing it. A preparation failure returns to that request rather than terminating the shared stdout
writer. Durable `ModelDispatched` ordering and conservative interrupted-dispatch recovery are unchanged.
The Host source identity is pinned independently of SDK-refreshed temporary credentials, and ARN region
precedes endpoint/owner region. Headers and signatures are transient. No standalone AWS credential
store, new grant, user token or paid request is needed for this integration.

Anthropic workload-identity federation now uses the locked SDK's jwt-bearer exchange and TokenCache
under the same Host owner. The source binds configured organization/workspace/federation rule/service
account plus assertion issuer/subject/audience equality in memory. Unverified JWT claims identify only
an owner-local source lease; the exchange service still validates signature and authorization. Expiry,
JTI and projected-token file rotation for the same principal do not change scope; changing the source
principal or target creates another opaque scope. Each refresh rechecks the assertion principal before
sending it to the configured first-party Anthropic endpoint. No assertion, exchanged access token or
claims are persisted, and no SDK credentials_path/disk cache is configured. SDK single-flight and
advisory/mandatory refresh behavior is retained. Native request headers preserve configured beta values
and append the SDK-required OAuth beta. Stored OAuth, API keys and explicit bearer headers retain
precedence, and failed auth never falls through to federation. Independent review exercised the real
locked SDK against a loopback token endpoint: concurrent single-flight, expiry and same-principal
assertion rotation, changed-principal rejection before exchange, target changes, sanitized failures,
configured beta preservation and no persisted bearer. This does not claim real organization access.

Anthropic subscription tokens (`sk-ant-oat`, matching the locked SDK) select an explicit
`anthropicOauth` model configuration. The mode participates in model generation and is rechecked around
credential refresh. The existing SDK OAuth owner still owns refresh/persistence. Native auth uses
Bearer, the locked Claude CLI identity headers and default Claude/OAuth betas, with configured header
precedence. The native serializer prepends the SDK's Claude identity system block and translates known
Claude tool names to canonical casing. Parsed client-tool calls map back to the registered native names;
raw provider blocks, signatures and canonical wire names are preserved unchanged for continuation.
API-key and workload-federation models do not receive the subscription body contract. Independent
subscription fixture acceptance remains pending; no live subscription credential has been used. Dynamic environment/helper, metadata ADC and AWS source scopes
require fresh selection after Host restart rather than silently adopting another identity. Real IAM,
ADC, subscription accounts, proxies and platform-specific credential chains still need live acceptance;
fixture evidence does not establish live-provider parity.


Reviewer evidence includes temporary fake-store refresh/relink/reopen, a real Pi worker through the
production parent client proving the worker's decoy credential file is untouched, and native private
IPC with fake credentials and real loopback model HTTP. These checks do not use real login tokens or
prove every cloud auth flow, external SDK variant, or platform filesystem behavior.
