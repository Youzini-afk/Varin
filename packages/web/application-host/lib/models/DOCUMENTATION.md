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
| Background directory refresh, service templates, derived cache and metadata normalization | `directory.ts`, `channel-directory.json`, `channel-directory.ts`, `directory-models.ts`, `directory-snapshot.ts` |
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
selection. `compaction.reserveRatio` defaults to 0.1 and applies to the selected model's context window;
global, trusted project and per-model ratios use the same precedence. Ratios are finite numbers from
0 to less than 1; the former `reserveTokens` setting is rejected rather than silently ignored.
Token counts require non-negative safe integers, including every model override; explicit zero remains
distinct from the default. Resource file roots are `VARIN_DATA_DIR/resources` and
`.varin/resources`; see [resource admission](../agent-resources/DOCUMENTATION.md).

## Channels and model selection

A channel type declares its protocol, operation support, authentication options, parameter schema,
display metadata and optional discovery/catalog candidates. A channel is one stable user-selected
connection. Multiple channels may use the same type. Each channel model has a stable catalog ID;
`requestModelId` supplies the actual model/deployment identifier. Display names are not routing keys.
Protocol-specific thinking options follow that upstream identifier, so a local catalog alias does
not change the selected model's wire dialect or token budget.
Opaque Bedrock resource/profile IDs retain the configured model-name hint; a recognizable upstream
model ID always takes precedence over that hint.

OpenAI-compatible and local services can host decision models alongside chat, embedding and rerank
models. Mark the classifier model with the `decision` operation and select its `decision.api`
(System One, Cloudflare System One or llama.cpp). An unset value inherits the channel's
`parameters.decisionApi`, then the installed type default (`typesafe-system-one` for compatible/local
services). Each decision model can select its own protocol without changing sibling models or the
channel default. Decision requests use that classifier protocol and its routes; conversation requests
retain their chat protocol. `decision.paths.classify` overrides the channel's decision path. llama.cpp
instead uses `decision.paths.tokenize`, `applyTemplate` and `completion`, relative to the server root
with a trailing `/v1` removed. It retains separate preparation/compute routes and does not accept a
single decision-path override. An explicit purpose endpoint remains the highest-priority override.

Image protocol selection belongs to each model's `image.api`. An unset value inherits the channel's
`parameters.imageApi`, then its installed OpenAI Images/OpenRouter default. Model edits preserve other
image capabilities and do not rewrite sibling models or the channel default. Prepared image bindings
retain their original protocol and route. `image.paths.generation` and `image.paths.editing` override
the respective channel paths. Image and single-call decision paths append to the configured service
base URL's existing path; they keep the same origin and reject traversal, query strings and fragments.
The model editor always shows editable paths. Choosing a protocol preset fills its standard paths;
clearing a path restores its inherited/default value. Request formats stay with the selected protocol.

All model editors expose `contextWindow`, including embedding, rerank and decision models. Auxiliary
bindings capture the configured capacity with their model identity. Remote embedding uses an explicit
`harness.embedding.maxTokens` input budget first, then the model context capacity, then the existing
unspecified-capacity default. Changing capacity affects newly prepared bindings and vector spaces.

UI and execution consume the same type definitions. `channel-types.ts` is the current built-in
support list; a provider name does not imply every protocol option is supported. Unknown model
names can be explicitly configured under a compatible type. Operations and image capabilities
remain explicit: image input alone does not enable image generation, editing or masks.

`catalog.ts` supplies reviewed protocol hints; `directory-snapshot.ts` supplies offline models.dev
metadata and public service lists. `ModelDirectory` loads `model-directory.json`, then refreshes in
the background using conditional HTTP requests. The normal freshness interval is six hours; settings
also offer an explicit refresh. Initial settings contain only service descriptions; the selected
service's model catalog is fetched separately. Conversation creation, model capture and dispatch never
wait for directory network requests. A failed refresh retains the prior source. This cache is derived
data and can be replaced; user configuration and credentials retain their separate owners.

`channel-directory.json` is the bundled standard-service directory and is also fetched from Varin's
main branch. Reviewed vendor, agent-service and local entries select existing protocol implementations;
ordinary new service templates can therefore arrive without a client release. Specialized channels
such as OpenCode, Command Code and Cline remain installed behavior. Remote directory data cannot
replace an installed channel's protocol, introduce OAuth implementations or execute SDK packages.
Missing later entries retain their known descriptors so saved connections remain usable. Generic
aggregator/reseller expansion is deferred. The channel directory, models.dev and activated public
service lists refresh independently, with per-source in-flight reuse and atomic cache replacement.

An installed channel definition owns protocols, authentication and special behavior. Directory SDK
labels map to installed codecs, without loading packages or executable remote configuration. Public
lists determine advertised models; connected account discovery is cached separately under the exact
connection fingerprint and credential scope. User overrides win over service facts, which win over
models.dev provider metadata and explicitly identified canonical-model metadata. Display-name guessing
is not used. Directory membership does not establish account entitlement.

New starter/candidate models follow directory defaults through `model.catalog`. Its `overrides` list
marks explicit field choices, including clearing a field. The settings editor can restore each field
or the whole model to the current defaults. Service-discovered models retain their service snapshot
until a matching account directory is available. Older manually configured models stay manual until
the user chooses to follow the directory. Refreshing never rewrites `models.json`, enables newly
discovered models, removes configured references or changes purpose selections. Captured execution
bindings retain their original configuration. A model missing from a later directory keeps its saved
metadata. Model catalogs and user configuration have independent revisions.

Mixed-API channels declare supported `protocols` and optional relative `modelBasePaths`; a model's
protocol chooses both the installed codec and the corresponding path beneath the saved service root.
This allows one OpenCode connection and credential to serve Responses, Chat, Messages and Google
models. Command Code uses its advertised `supported_endpoints`. Saved service origins are not changed
by a directory refresh. The advanced model editor exposes protocol selection.

Discovery and extension catalog candidates are read-only material. Applying a selection requires a
configuration write; an empty or failed discovery does not delete saved models or purpose bindings.
Completed saved-connection discovery can update the derived account cache without changing the user
configuration revision. Draft discovery does not write either the connection or the entered key.
Configured values, unavailable types, missing credentials and disabled models remain distinguishable.
Gemini and Anthropic discovery follow their opaque page cursors on the captured connection; cancellation,
invalid/repeated cursors and later-page failures never publish a partial list as complete. Settings show
contributed catalog candidates even without network discovery. `discover-draft` captures the displayed
connection and optional entered key without writing either to storage. Selecting one or many candidates
changes the editor draft and preserves declared capabilities; Save publishes that selection.

Models declare image input, context capacity, output capacity and reasoning separately. `thinking`
describes effort levels (including whether Off is allowed), an on/off switch, always-on reasoning, or
a token budget. `thinkingLevelMap` maps public choices to provider values when their names differ.
UI previews, chat controls and execution use the same declared choices. A reasoning flag alone does
not claim support for all effort levels or for disabling reasoning. Providers retain their own wire
formats and output-budget constraints; this metadata does not add unsupported server capabilities.

The model editor's explicit Test action uses `/api/models/test` and the existing standalone
`ModelTextService`/Catalog inference owner. It captures the unsaved connection, selected model and
thinking choice, sends one short request, and retains the ordinary usage receipt. It does not create
a conversation, publish a temporary channel, store an entered key, or automatically repeat a request.
Leaving the test signals cancellation; the inference owner retains credentials until actual drain.

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
Settings HTTP failures retain Host egress classifications with fixed, non-secret messages; a network
policy denial is not reported as malformed model configuration. Non-desktop Hosts retain private-address
checks; local model access is supplied by the real Electron network integration, not a model-setting bypass.

## Authentication and retained bindings

Channels reference a stored credential, an explicit environment variable, an allowed cloud source,
or explicit anonymous access. Cloud libraries are direct dependencies: Google's client owns ADC
refresh and the AWS/Smithy owners resolve chains and sign native requests. No library is loaded
through Pi's dependency tree. OAuth authorization uses the existing Host interaction owner with a
local callback or manual callback response; an unrelated channel does not wait for that interaction.

Kimi Code, GitHub Copilot, xAI and Meta use device codes displayed by the same authorization panel.
The Host polls at the issuer's interval, observes code expiry and cancels when the user closes sign-in.
Copilot exchanges the GitHub token for an inference token; Meta exchanges its identity token for an
API key. Their renewal uses the same credential store and account-generation checks as browser OAuth.
Copilot's account endpoint is resolved during request preparation and frozen into that request;
refresh cannot retarget it. Copilot OAuth does not enable Claude's subscription-specific body format.

OpenCode Zen and Go additionally support OpenCode's documented workspace-scoped device flow with
client ID `varin`. Relative verification URLs resolve against the issuer. Rotating refresh tokens use
the existing account refresh single-flight and generation checks. The OpenCode request profile is
selected only by those channel types. Rust derives its session, request and optional project headers
from the original execution branch/workspace, including auxiliary work; other channels do not receive
them. Auxiliary purposes have separate stable affinity scopes. No project path or header placeholder
is sent, and the profile does not change the system prompt or tool list.

Cline and ClinePass retain separate model lists on the same API. Their explicit Chat compatibility
option retains streamed `reasoning_details`, assembles fragments and replays encrypted blocks only
under the original connection identity. It does not project encrypted data into visible reasoning.

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
