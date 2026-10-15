# Model connections, settings and credentials

`ModelsService` owns the Agent runtime's channel catalog, model selections and purpose bindings in
the Application Host. It serves settings, discovery and authorization without an active conversation.
Native settings, credentials, resources and context policy share their explicit owners. Old Pi assets
are neither read nor imported.

The Host prepares product configuration and authentication. Rust owns native chat protocol execution,
HTTP/SSE, cancellation and durable request/usage facts. Auxiliary inference uses the existing
purpose-specific consumers and original inference Operations, rather than another request database.
See [runtime ownership](../../../../../docs/runtime.md) and the
[Rust adapters](../../../../../kernel/crates/varin-runtime/src/providers/README.md).

## Entry points and storage

| Responsibility | Entry |
| --- | --- |
| Channel types, validation, discovery and captured selections | `channel-types.ts`, `service.ts` |
| Credential-free HTTP headers, operation paths and proxy validation | `connection.ts` |
| Revisioned settings and file observation | `configuration.ts`, `settings.ts` |
| Model account storage, OAuth and cloud credential sources | `credentials.ts`, `oauth.ts`, `google-auth.ts`, `aws-auth.ts`, `anthropic-auth.ts` |
| Reviewed extension contributions and exact service pins | `extensions.ts` |
| Authenticated client access | `routes.ts`, `application-client/src/model-connections.ts` |

`VARIN_DATA_DIR/models.json` contains channels and their models; `agent-settings.json` contains
global Agent settings, including purpose selections. Trusted projects may supply
`.varin/settings.json`. `model-auth.json` holds model credentials separately from MCP's
`mcp-auth.json`. Both use `@varin/settings-store` locking and atomic replacement. Reads do not create
or repair files, and unchanged updates do not rewrite them. New files use private permissions;
existing file/directory permissions are retained by the shared store.

Updates check the expected revision. File observation publishes configuration changes, including
external edits. A malformed document is an error, not an empty replacement; an already accepted
binding can retain the last valid configuration. Invalid channel entries report their own issues
without removing independent valid channels. A first invalid load has no invented valid fallback.

`ProjectTrustService` owns native `VARIN_DATA_DIR/project-trust.json` through the same locked revision-CAS
file transaction. Missing decisions are untrusted. Explicit true/false decisions inherit along canonical
ancestors; deleting a direct decision exposes the ancestor decision, if any. The authenticated
`/api/project-trust/read` and `/update` routes accept an existing workspace ID, resolve it through
Documents admission, and never grant trust to a raw request path. Updates pin both the reviewed canonical
`expectedPath` and file revision, so reassigning a workspace while confirmation is open cannot transfer
approval to another root. Change subscribers observe committed writes, external revocation and invalid
files; the Host broadcasts `project-trust` invalidations through its existing settings event stream.
Bad trust files are errors and remain
untouched. `~/.pi/agent/trust.json`, Pi environment variables and legacy files have no native authority.
Every new project resource/model/MCP access consults current trust; revocation does not rewrite accepted
immutable input history. The settings, MCP and resource panels expose an asynchronous trust review.
Changing Host/project, dismissal or invalidation retires pending approvals and stale callbacks.
Revocation freezes cached project capabilities while re-reading the owner; dirty resource/MCP text
remains available read-only when its original source is no longer admitted. A lost save response
invalidates cached trust instead of claiming the write was rolled back.

`agent-settings.json` and trusted `.varin/settings.json` also own the typed `compaction` and `resources`
fields. Context policy is derived from a settings snapshot with its revisions and trusted project
selection. Token counts require non-negative safe integers, including every model override; explicit
zero remains distinct from the default. Resource file roots are `VARIN_DATA_DIR/resources` and
`.varin/resources`; see [resource admission](../agent-resources/DOCUMENTATION.md).

## Channels and model selection

A channel type declares its protocol, operation support, authentication options, parameter schema,
display metadata and optional discovery/catalog candidates. A channel is one stable user-selected
connection. Multiple channels may use the same type. Each channel model has a stable catalog ID;
`requestModelId` supplies the actual model/deployment identifier. Display names are not routing keys.

UI and execution consume the same type definitions. `channel-types.ts` is the current built-in
support list; a provider name does not imply every protocol option is supported. Unknown model
names can be explicitly configured under a compatible type. Operations and image capabilities
remain explicit: image input alone does not enable image generation, editing or masks.

Discovery and extension catalog candidates are read-only material. Applying a selection requires a
configuration write; an empty or failed discovery does not delete saved models or purpose bindings.
Configured values, unavailable types, missing credentials and disabled models remain distinguishable.
Gemini and Anthropic discovery follow their opaque page cursors on the captured connection; cancellation,
invalid/repeated cursors and later-page failures never publish a partial list as complete. Settings show
contributed catalog candidates even without network discovery, and require connection changes to be saved
before querying that connection. Selecting a candidate preserves its declared model capabilities.

Connection options are explicit and credential-free:

- `headers` accepts non-sensitive HTTP headers. Authentication and transport-controlled headers are
  rejected here; resolved credential headers take precedence case-insensitively at dispatch.
- `paths` selects supported operation endpoints beneath the configured base path. Paths cannot
  change origin, traverse directories, or carry query/fragment data. Azure retains its deployment
  and API-version binding. The multi-route llama.cpp classifier rejects a single decision-path override.
- `proxy` is absent for the existing Host policy, `direct` for explicit direct access, or `proxy`
  with a credential-free HTTP(S) proxy origin. An explicit override cannot silently become direct.

The same captured options reach chat, discovery and supported auxiliary consumers. Normal edits
affect later preparation; they cannot retarget an accepted Run, queued input or active request.
Explicit disable/removal or account withdrawal is checked separately and can reject further access.

## Authentication and retained bindings

Channels reference a stored credential, an explicit environment variable, an allowed cloud source,
or explicit anonymous access. Cloud libraries are direct dependencies: Google's client owns ADC
refresh and the AWS/Smithy owners resolve chains and sign native requests. No library is loaded
through Pi's dependency tree. OAuth authorization uses the existing Host interaction owner with a
local callback or manual callback response; an unrelated channel does not wait for that interaction.

Anthropic workload identity is an explicit `anthropic-federation` authentication source: an absolute
Host identity-token file, organization ID and federation rule ID, with optional service-account and
workspace IDs. The Host exchanges the JWT using the documented JWT-bearer grant against the selected
channel's `/v1/oauth/token` endpoint. HTTPS is required except for local loopback fixtures; credential
redirects are rejected. No Pi configuration or ambient Anthropic environment variable is imported.
Assertions and minted access tokens are never written to the channel catalog or credential store.
The Host coalesces exchanges and refreshes cached tokens before expiry. It rechecks the identity file
before and after resolving even a cached token; principal changes, withdrawal and channel revocation
invalidate old handles. JWT rotation for the same issuer, subject and audience preserves identity.
Federation uses bearer authentication and the OAuth API beta, but does not enable subscription-only
Claude Code request decoration. Token exchange errors never publish remote bodies or secrets.

`CredentialScope` binds authority, reference, account/source and generation without storing the
secret as identity. Normal token rotation preserves the account. Replacement, relink, sign-out and
changed dynamic sources invalidate affected selections. Refresh is coalesced per account; cancelling
one waiter does not cancel another waiter or abandon persistence of a rotated token. An old refresh
cannot overwrite a subsequently replaced account.

Captured model and authentication implementations have real leases. Preparation, queued Run
handoff, continuation and child selections retain their original owner dependencies. Background
embedding, rerank, decisions, memory and retrieval retain their own stage/request lifetimes. A caller
leaving releases its observation; the owner retains active resolution and callbacks until they really
settle. Failed, replaced and late preparations release their exact captures.

Before Catalog accepts a delegated child, the existing private child handoff acknowledges its exact
model retention and the original dispatch catalog dependency graph, including model-only children.
Nested children can still select another captured preset after their ancestor terminates. This
child-operation hold survives parent completion
and cold source/context preparation until the child adopts its own registration, or the original
rollback/report releases it. Terminal Run notifications retire Run admissions without requiring a UI
inspection; independent operation/child duties and real authentication drain remain owned.

Dispatch rechecks the original scope and target before returning transient headers. Missing or
failed selected credentials never fall through to another account. Secrets stay out of public DTOs,
configuration identities, prompt snapshots, history and logs. The private wire and signing contract
is documented in [credential ownership](../../../../../kernel/crates/varin-runtime/src/providers/AUTH.md).

## Extension protocol and authentication contributions

`varin.models@1` and the SDK's `provideModels` use the existing reviewed extension service and
composition lifecycle. The Host validates a complete candidate, publishes its adapter set to the
Rust registry, then commits channel/authentication contributions. Failed or superseded preparation
leaves the prior generation selected; it does not partly publish a new catalog.

`adapterIdentity` is the durable verified artifact/composition plus adapter metadata identity.
`adapterBindingId` selects one actual running implementation. Unchanged providers can reuse a live
binding; reactivation of identical code gets a new binding ID. A live original pin is never replaced
by a lookup of today's logical service name. Recovery without that handle requires the exact same
content identity, not merely the same extension/version label.

The current brokered protocol contract is chat over SSE. Extension callbacks serialize typed input
and parse typed events; Rust still owns HTTP, SSE framing, usage, cancellation and the request ledger.
Callbacks receive no credentials. Authentication contributions use a separate call-scoped client and
reviewed token endpoint. Their captured implementation survives ordinary replacement until its
consumers and refreshes drain. Kernel disconnect cancels and drains the actual callbacks before
pins are released; observer cancellation alone is not drain evidence.

See the [SDK](../../../../extension-sdk/README.md) and the executable
[model protocol example](../../../../../examples/extensions/model-protocol/README.md).

## Purpose inference and accounting

Conversation, embedding, rerank, decision and image operations retain their own typed input/output
and original request receipts. Image generation and editing have independent global model settings;
an unconfigured tool is absent from the Agent tool collection. The original image binding and schema
remain fixed through an accepted call. Result media, subsequent editing and project saves use the
existing resource/file owners; see [runtime image tools](../../../../../docs/runtime.md#图像工具与媒体).

Provider usage belongs to its original ModelStep or inference Operation. Repeated history, recovery
or parent/child projections do not create another consumption record. Actual, estimated, missing
and pending measurements stay distinct; cancellation is not zero usage. Context capacity uses full
request estimates and eligible prior actual usage, retrieval uses tokenizer/chunk estimates, and
Goal budgets retain their existing output-token scope. These are different consumers of evidence,
not interchangeable counters. Raw non-token image usage is preserved without inventing token costs.

## Rationale and support boundaries

The new-api comparison informed channel fields, discovery and model management. Varin calls the
selected protocol directly; it does not adopt gateway forwarding, automatic channel failover,
balances or settlement. Discovery is deliberately separate from writes, and malformed configuration
is never repaired by clearing user data. The comparison did not copy new-api code; repository and
dependency license obligations remain in [LICENSE](../../../../../LICENSE) and
[THIRD_PARTY_NOTICES](../../../../../THIRD_PARTY_NOTICES.md).

Local protocol/configuration tests establish specific behavior, not live account or deployment
support. Provider accounts, OAuth interaction, proxy/DNS environments, cloud credential chains,
headless/remote use and installed-product packaging still require their relevant acceptance.
