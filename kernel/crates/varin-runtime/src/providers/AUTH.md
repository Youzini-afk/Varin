# Model credential ownership

Native model adapters receive transient dispatch headers through the Application Host's private
credential bridge. The Host [model service](../../../../../packages/web/application-host/lib/models/DOCUMENTATION.md)
owns account configuration, login, refresh and credential-source selection. The native product does
not load Pi's SDK or import its account store. Historical credentials and other user assets remain
untouched; they cannot authorize native dispatch.

## Owners and entry points

- [ModelsService](../../../../../packages/web/application-host/lib/models/service.ts) captures the
  selected channel, model, connection and account. Its `credentials.ts`, `oauth.ts`, `google-auth.ts`
  and `aws-auth.ts` supply native authentication implementations.
- [Model authority](../../../../../packages/web/application-host/lib/kernel/model-authority.ts)
  prepares the non-secret native configuration and its retained implementation. Renderer/history
  fields cannot supply an alternate endpoint or account.
- [Host credential owner](../../../../../packages/web/application-host/lib/kernel/credential-owner.ts)
  checks scope, target and resolution, while the [bridge](../../../../../packages/web/application-host/lib/kernel/credential-bridge.ts)
  registers original Run/operation lifetimes and handles private replies.
- [host_auth.rs](host_auth.rs) implements the epoch-bound Rust resolver. [auth.rs](auth.rs) defines
  shared scope/refresh traits and an injectable transactional `CredentialBroker`; that broker is
  not a second production credential store.

Storage, revisioned settings and OAuth interactions are documented with the model service. This file
covers the private native dispatch boundary.

## Frozen identity and lifetime

`CredentialScope` contains reference, authority, account/source identity and generation. Its local
account handle is not a token digest or an external provider account ID. Provider account metadata
is carried separately. Normal same-account refresh preserves the scope; explicit replacement,
relink, sign-out and changed dynamic sources invalidate affected bindings.

Model preparation fixes the configuration and captures its authentication implementation. Accepted
Runs, queued selections, continuations and inherited child selections retain that original owner and
its implementation dependencies. `CredentialBridge.findOwner` forks a matching retained owner rather
than resolving today's adapter catalog. The private registration fixes kernel epoch, Run and optional
binding/Operation identity. Exact queued-model registrations are idempotent; another scope cannot
replace them merely by reusing a display name.

Child dispatch transfers the exact model through the existing ACK-before-Catalog-accept handoff.
The Host searches only the original parent registration/dependency graph and records a child-operation
hold, even when the child has no MCP or extension tools. It also retains the original dispatch catalog
dependency graph for later nested selections. Parent termination cannot release that hold.
Actual child adoption, original rollback or report retires it through the same handoff owner.
Terminal Run release also covers unstarted queued Runs cancelled as a tree; it does not depend on
a later inspector and does not retire independent operation/child registrations.

Each registration retains its owner independently of the preparing caller. Failed preparation,
replacement and unregister release their own holds. Active scope/auth resolution retains the actual
owner until it settles. Cancelling a waiter or unregistering a Run closes that observation and
prevents late replies, but cannot abandon a refresh that may already have rotated a token. Its
original account service finishes persistence; a subsequent account replacement wins over stale
refresh completion.

A restarted Host validates the original durable model/credential scope before rebind. Dynamic source
identities without durable continuity need a fresh trusted selection. A new kernel epoch never
revives an old private handle or redirects old continuation data to the current account.

## Private dispatch and headers

Rust sends a one-shot request with the original epoch, Run/binding, scope and optional dispatch
metadata. Secret replies bypass public RPC, event buses and histories. A reply must match both the
pending request and scope; cancelled or already settled requests discard it. Closing the private
channel fails its waiters rather than selecting an ambient credential.

The Host checks scope before and after resolution and once more before returning headers. It rejects
removed/missing credentials, changed accounts and authentication failures; it never falls through to
a different key, header or account. Any resolved base URL must remain compatible with the registered
target. Explicit anonymous channels are permitted only when their frozen binding allows them.

Built-in protocol families map resolved keys to their actual authentication header. Reviewed custom
protocols receive configured credential headers from the Host model service. Non-sensitive connection
headers are separate; authentication headers take precedence case-insensitively. Header values do
not enter request snapshots, histories, public events, configuration hashes or debug output.

For signed requests, private dispatch supplies `POST`, the exact registered endpoint and a lowercase
SHA-256 digest of the frozen body. The Host validates that target and digest; AWS signing uses the
same payload hash, overriding conflicting configured hash headers. Rust persists, hashes and sends
one frozen body allocation, without reserializing after signing. Auth frames contain no prompt body.
The bounded bridge preflights frames before queueing, so malformed preparation does not kill the
shared writer.

## Provider-specific ownership

Google ADC uses the native Host's directly imported `google-auth-library`. File-source identity uses
non-secret filesystem revision; metadata-service identity is owner-local. Google's client owns token
refresh/cache, with no copied credential store. Explicit Vertex Cloud API keys use their separate
header and routing mode. The original project/location and endpoint remain fixed.

AWS uses directly imported AWS/Smithy credential and signing libraries. Its source identity binds
profile/chain inputs separately from rotated temporary credentials. Dynamic identity needs fresh
selection after restart; model ARN region takes precedence over standard endpoint defaults. The
Rust adapter does not load the cloud credential chain or persist signing secrets.

Native Anthropic subscription OAuth uses the Host's own OAuth provider and account storage. The
selected `anthropicOauth` mode fixes the matching identity/tool-name/header/body contract and is
checked around resolution. API-key mode does not inherit that contract. Explicit workload federation
is separately owned by the Host's `anthropic-auth.ts` and selected `anthropic-federation` source;
its identity-file exchange does not enable subscription-only request decoration.

Codex requires both a Bearer token and the selected account header. The Host authorization flow
owns that account metadata; the Rust adapter cannot decode an arbitrary JWT to invent authority.
Opaque response history cannot be reused after relink solely because channel/model names match.
Protocol-specific limits remain in [Model adapters](README.md).

## Verification boundary

Focused store, capture, continuation, bridge and controlled provider tests establish specific local
ownership and dispatch behavior. They do not establish access to real accounts, live OAuth/ADC/IAM,
subscription services, Entra paths, proxies or platform-specific credential chains. Those paths and
installed-product deployment require their own acceptance. No user secrets are needed to review
these contracts.
