# Model adapters

These modules implement the Agent runtime's `ModelProvider` boundary. They serialize immutable
semantic history, execute one request, parse protocol events and preserve continuation originals.
They do not own a conversation loop, tool authorization or a credential store. The default product
runtime still uses Pi; see [runtime ownership](../../../../../docs/runtime.md).

The native base catalog is declared in [builtins.rs](builtins.rs) and validated by its family-specific
options. Reviewed Host model contributions register [brokered codecs](extensions.rs) into the same
[ModelAdapterRegistry](registry.rs). The trusted Host [model catalog](../../../../../packages/web/application-host/lib/kernel/model-authority.ts)
prepares the selected implementation and endpoint.
The renderer chooses registered model IDs, not arbitrary endpoints or auth headers.

## Current protocol families

| Family | Adapter and important protocol boundary |
| --- | --- |
| `openai-responses` | [responses.rs](responses.rs): complete Responses events and original encrypted/reasoning items |
| `openai-completions` | [chat.rs](chat.rs): one choice; complete tool finish plus `[DONE]`; trailing usage retained |
| `azure-openai-responses` | [azure.rs](azure.rs): distinct continuation family, explicit deployment and API version |
| `anthropic-messages` | [anthropic.rs](anthropic.rs): validated block order/types and retained signed/server-tool originals |
| `google-generative-ai`, `google-vertex` | [google.rs](google.rs): GenerateContent, ordered thought signatures, paired function names/IDs |
| `mistral-conversations` | [mistral.rs](mistral.rs): the configured SDK family's `/v1/chat/completions` protocol |
| `openai-codex-responses` | [codex.rs](codex.rs): Codex-specific SSE body/headers and bound account identity |
| `bedrock-converse-stream` | [bedrock.rs](bedrock.rs), [aws_eventstream.rs](aws_eventstream.rs): AWS binary eventstream and ConverseStream |
| `pi-messages` | [pi_messages.rs](pi_messages.rs): the locked Pi message HTTP protocol, without a Pi AgentSession/loop |

These are concrete adapters, not aliases for one generic OpenAI-compatible body. Protocol fixtures
and loopback tests do not establish parity with every service option or live account.

## Brokered protocol implementations

`BrokeredModelAdapter` invokes a fixed Host service pin for typed serialization and parsing while
`Connection`/`HttpTransport` retain HTTP dispatch, SSE framing and cancellation. The original
`RequestView` IDs, `ProviderEvent` values, usage receipts and request ledger remain authoritative.
The callback receives no credentials. A missing terminal protocol fact is an incomplete stream,
not a retry instruction. The current cross-process contract is chat over SSE, not a claim of binary
protocol or auxiliary-operation support.

A runtime binding ID selects the actual pinned worker. A separate content identity covers the
verified artifact/composition and adapter metadata, so an identical implementation can be rebound
after process restart without accepting changed code. Captured selections retain the original Rust
composition before admission. Replacing an unrelated provider reuses unchanged adapter registrations.
Explicit revocation forwards cancellation through the original token. The callback bridge must await
actual response or worker exit before claiming drain; a cancelled observer cannot release the original
request or turn unknown usage into zero. The Host also drains pins when a kernel epoch disconnects,
without depending on static Rust destructors during process exit.

## Immutable request boundary

`ModelProvider::serialize(view, reuse)` returns [RequestBody](../request_body.rs), containing no
credentials. Same-family/version originals are replayed only under the same nonempty trusted
connection identity and applicable model constraints. Cross-family projection drops provider-only
items but rebuilds portable text and complete client-tool exchanges. Signatures, citations and
encrypted reasoning are never flattened into invented ordinary text. Attachments must already be
materialized; unsupported media/protocol combinations fail explicitly.

Responses, Azure and Codex reuse independent item fragments and tool schemas from the original Run
worker's latest-only holder. Codex also reuses the joined instructions fragment only for its exact
ordered system-item sequence. The actual adapter lease, configuration/schema/model/connection,
checkpoint and immutable item identities govern reuse. Preview has no holder. Chat, Anthropic,
Google/Vertex, Mistral, Bedrock and Pi retain complete encoded message groups. Group keys include
the actual ordered sources and opaque projection, with original call dependencies for results and
Mistral's request-wide wire-ID allocation. System items keep each protocol's placement and grouping.
Only the latest request's groups survive; appending to a group rebuilds it without rebuilding earlier
groups. Pi's nested context carries these fragments through final serialization without a parsed copy.

Every call validates the pinned adapter. Outer options finish before final bytes freeze. One raw JSON
allocation is shared with HTTP and Bedrock signing; ContentStore retains/reopens those same bytes,
including valid noncanonical JSON. No transport may reserialize the body after signing. Retained
fragments plus a complete wire buffer still cost memory; vector scans, final assembly, durable
encoding/hashing and media work remain. This is local reuse, not remote incremental transmission.

## Dispatch and stream semantics

[Connection and transport](mod.rs) resolve the credential reference immediately before dispatch via
`CredentialResolver`. Production uses the [Host authority](AUTH.md); the explicit environment resolver
only maps trusted references to configured environment/header bindings and performs no OAuth flow.
Header values never enter snapshots, histories, public events or Debug output.

`ReqwestTransport` lazily creates a persistent TLS client and Tokio I/O executor per transport instance;
production bindings share the default instance/pool. Requests have independent cancellation/futures.
A trusted ClientBuilder supplies proxy/DNS/certificate policy. Redirects and automatic retries are
disabled. No default generation deadline is imposed here; configured deadlines and cancellation are
separate controls. Synchronous execution belongs on a worker; an async-runtime caller receives
`worker_required` rather than blocking that runtime.

SSE supports fragmented UTF-8, CR/LF/CRLF, multiline data, comments and an initial BOM, with a
configurable event memory budget. Partial tool deltas never become complete calls. HTTP EOF alone
does not prove model completion; each family supplies its actual terminal rule. Responses duplicate
completed items must preserve exactly the same original body. Error messages are sanitized because
remote bodies may echo prompts/secrets; safe machine codes, HTTP status, request IDs and numeric
Retry-After remain available. The runtime does not repeat a potentially paid request automatically.

Raw usage and normalized actual/estimated/missing measurements remain distinct. Absent measurements
are not synthetic zero. The adapter declares its transcript grouping and complete-input interpretation
for request-budget calibration; that estimate does not alter usage receipts or pricing.

## Family-specific reasons and limits

### Responses, Chat and Azure

Responses preserves original output items for same-connection continuation. Chat preserves one full
assistant wire message while retaining semantic calls for cross-family replay, avoiding duplicate calls.
`legacy_max_tokens`, stream usage and reasoning choices are explicit configuration, and unsupported
vendor deltas fail rather than disappearing.

Azure requires the complete endpoint, deployment and API version selected by the Host. It validates
or appends the API-version query and uses deployment as the request model. Resource defaults and
maps are Host configuration, not hostname guesses. Auth resolver extensibility alone is not evidence
that every Entra login/refresh path is integrated.

### Anthropic and GenerateContent

Anthropic preserves block/signature identity. Its subscription OAuth mode is an explicit frozen model
configuration, including the required identity system block, headers and tool-name mapping; API-key
and workload-federation requests do not accidentally inherit that body contract. `pause_turn` currently
fails as unsupported because resumable server work needs an orchestration contract, not a fabricated
completed Run. Received provider server tools are not automatically declared executable client tools.

Google and Vertex use complete `:streamGenerateContent` endpoints with `alt=sse`. EOF is accepted
only after a finish reason; trailing usage is retained. Original thought signatures are model-scoped.
Changing models keeps portable content and drops incompatible originals. Partial-argument function
streaming currently fails explicitly. Gemini API keys, Vertex express API keys and Host-owned ADC
are different authentication/routing paths; see [AUTH.md](AUTH.md).

### Mistral and Pi messages

`mistral-conversations` names the locked SDK's chat-completions family, not Mistral's separate stateful
Conversations API. The profile has consistent nine-character alphanumeric tool IDs, typed text/thinking
arrays, joined thinking chunks, object-form tool arguments and `model_length` handling. DONE or clean
EOF needs a prior finish reason. Its explicit prompt-cache key also supplies request-local `x-affinity`.
These semantics must not weaken the OpenAI Chat adapter's terminal contract.

`pi-messages` preserves that HTTP wire format's signed blocks, tool pairing and native usage. Using
this adapter does not invoke Pi's agent execution loop or migrate Pi histories into Catalog.

### Codex SSE

Codex requires its authorized `/codex/responses` endpoint, top-level system instructions, encrypted
reasoning inclusion, `store:false`, session/request identity and a frozen branch/Run-derived cache key.
The credential binding must supply both Bearer authorization and the account header; the adapter does
not decode JWTs to invent account authority. It uses honest Varin originator/user-agent metadata.

The locked contract does not accept output-capacity/sampling parameters on this path; those options
fail rather than pretending to enforce a wire budget. WebSocket incremental state, account-keyed socket
pooling and zstd are not implemented by the SSE adapter. Live account authorization requires separate acceptance.

### Bedrock

ConverseStream uses `/model/{encodedModelId}/converse-stream` and AWS binary eventstream, not SSE.
The decoder validates prelude/message CRC32, fragmented frames, content type and event budgets. Success
requires `messageStop` plus a complete final frame; trailing usage is retained. Exceptions are sanitized
and never trigger retries. Signed reasoning/redacted bytes remain model/connection-scoped originals.

The Host resolves bearer keys or its existing AWS credential-chain/SigV4 owner. Model ARN region takes
precedence for standard endpoints; explicitly registered custom endpoints remain intact. Private auth
messages carry method, endpoint and the SHA-256 digest of exact frozen HTTP bytes, not prompt bodies.
Configured options are implemented by the actual serializer; full SDK option/live-cloud parity is
not implied by this transport.

## Verification

[tests.rs](tests.rs) and module-local tests cover serializers, framing, opaque replay, usage,
cancellation and loopback requests. Host auth/configuration tests cover the production selection and
private bridge separately. Live provider accounts, network/proxy environments and platform credential
chains require appropriate acceptance. See [development](../../../../../docs/development.md) for
verification entry points; historical pass counts belong in Git, not this contract.
