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
- `auth.rs` implements `NativeCredentialBroker`, `CredentialScope`, transactional store/refresh traits
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

The native kernel rendezvous carries only scope/request metadata outward and transient header replies
inward. Host HTTP credential writes and utility OAuth refresh also use the shared owner. Standalone
Pi launches retain their existing owner because they have no parent Application Host channel.
Credential helper/env keys preserve existing Pi resolution in the child; native bindings to dynamic
or separately configured models.json key sources remain explicitly gated pending source-owned identity.

Reviewer evidence includes temporary fake-store refresh/relink/reopen, a real Pi worker through the
production parent client proving the worker's decoy credential file is untouched, and native private
IPC with fake credentials and real loopback model HTTP. These checks do not use real login tokens or
prove every cloud auth flow, external SDK variant, or platform filesystem behavior.
