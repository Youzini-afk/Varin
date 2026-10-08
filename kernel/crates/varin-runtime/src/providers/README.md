# Native model adapters

This module implements OpenAI Responses, OpenAI Chat Completions, Azure Responses and Anthropic Messages as execution `ModelProvider`s.
It is not a claim that every configured Pi provider, OAuth flow, or production Host path has migrated.

## Dispatch boundary

`serialize` compiles semantic history into a credential-free immutable request body. Same-family,
version-1 provider originals with the same nonempty trusted connection identity are replayed without flattening encrypted reasoning, signatures, citations,
or server-tool blocks. Cross-family provider-only items are omitted by `compile_history`; portable
text and client-tool exchanges are rebuilt. Unsupported local/multimodal references fail explicitly.
The Host must materialize attachments before compilation. Tool schemas use the frozen request's versions.

`Connection` resolves a credential reference immediately before dispatch through `CredentialResolver`.
`EnvironmentCredentialResolver` is a concrete implementation for trusted reference-to-environment-header
bindings. It never treats an arbitrary reference as an environment variable name. A Host credential
broker can implement the same interface, including OAuth refresh coordination; OAuth is not implemented
by the environment resolver. Authentication headers never enter request snapshots or debug output.

`NativeHttpTransport` lazily creates one persistent reqwest TLS client and Tokio executor per transport instance. Model steps share that client and connection pool; concurrent requests have independent futures and cancellation. No global tenant or credential cache is used. A trusted
ClientBuilder factory supplies proxy/DNS/certificate policy. Redirects and automatic retries are disabled.
Cancellation drops the active send/read future. Calling this synchronous adapter from an async runtime
returns `worker_required`; use a blocking execution worker. The default has no generation deadline;
the caller can configure one through ClientBuilder and can always cancel the run.

## Stream semantics

SSE framing supports byte-fragmented UTF-8, CR/LF/CRLF, multiline data, comments, and an initial BOM.
Each event has a configurable memory budget. Partial deltas are not admitted as complete tools. A clean
HTTP EOF does not establish model completion. Completed duplicate Responses items must have identical
original bodies. Anthropic block order and delta/block types are validated.

Provider machine error codes are retained when well-formed; error messages remain generic because remote
error bodies can echo secrets or prompt content. HTTP status, request IDs and numeric Retry-After headers
are returned without automatically repeating potentially paid calls. Raw usage is retained separately
from standardized actual/estimated/missing measurements. Missing usage is never a synthetic zero.

Anthropic `pause_turn` currently fails explicitly as `unsupported_stop_reason`: the orchestration layer
needs a distinct resumable server-work contract before that can be treated as completion. Provider-native
server tools can be preserved in received history but are not declared as executable client tools.
Other protocol families, cloud-identity signing, built-in remote tool configuration and purpose-specific
embedding/rerank/image requests require their own adapters and admission contracts.

Protocol references: OpenAI streaming responses and reasoning guides, Anthropic streaming Messages docs.
https://developers.openai.com/api/docs/guides/streaming-responses
https://developers.openai.com/api/docs/guides/reasoning
https://platform.claude.com/docs/en/build-with-claude/streaming

## Chat and Azure contracts

Chat requests one choice and accepts complete function calls only after a tool-call finish reason and
`[DONE]`. It retains usage chunks arriving after the finish reason. The complete assistant wire message
is preserved once; semantic tool items are retained separately for cross-family compilation, without
duplicating calls during same-family replay. `legacy_max_tokens`, `include_stream_usage` and
`reasoning_effort` are explicit configuration choices. Unsupported vendor delta extensions fail rather
than being silently erased. This is not full behavioral parity with every OpenAI-compatible service.

Azure has its own `azure-openai-responses` continuation family. The host supplies a complete Responses
endpoint, deployment name and API version. The adapter verifies/appends the API version query, uses the
deployment in the request model field and shares Responses event parsing. API-key authentication uses
an `api-key` environment-header binding; a separate credential resolver must implement Entra token
refresh. Resource defaults and deployment maps are resolved by the host, not guessed from hostnames.

## GenerateContent contract

`GoogleProvider::new` selects `google-generative-ai`; `GoogleProvider::vertex` selects `google-vertex`.
Both require a complete `:streamGenerateContent` endpoint and validate/add `alt=sse`. They share the
GenerateContent request/response protocol, while continuation data remains family- and model-scoped.
Original parts are preserved in order, including thought signatures on text/function/server-tool
parts. Switching models strips signed originals and retains only portable semantic content.
Function responses recover their name and optional wire ID from the paired call. Partial-argument
function streaming is explicitly unsupported, rather than admitting an unfinished call.

Google uses an explicit transport clean-EOF mode: EOF is successful only after a protocol finish reason,
and trailing usage receipts are retained. Other adapters retain their existing terminal-event rules.
API-key Gemini headers and explicitly resolved Vertex bearer/API-key headers use CredentialResolver;
ADC discovery, service-account signing and token refresh are not implemented here.

Grounding: locked Pi SDK 1.0.4 `api/google-generative-ai.js`, `google-vertex.js`, `google-shared.js`, plus
https://ai.google.dev/api/generate-content and https://ai.google.dev/gemini-api/docs/thought-signatures.

## Remaining parity boundaries

- Responses, Anthropic, Chat and Azure have native streaming serializers/parsers and reviewer-owned
  fixture/loopback checks. Check current verification reports for the exact tested revision.
- Google/Vertex have native GenerateContent serialization/parsing and signed-part replay; review tests
  and production factory wiring are separate gates, not implied by the module's presence.
- Codex SSE serialization and required bound-account headers are implemented. Codex WebSocket/compression
  parity, Bedrock Converse event framing/signing, the separate stateful Mistral Conversations API and
  pi-messages remain explicit work.
- Environment-key lookup and an injected transactional native OAuth broker are implemented. The broker
  supports scope pinning and cancellation-safe refresh/persistence; the Host store/private bridge is now wired and checked with temporary/fake credentials. Platform
  keychain integration, Entra/ADC/AWS identity and live-auth verification remain separate work.
- Built-in remote tools and server-job continuation, embeddings/rerank/decision/image purpose-specific
  contracts, model override compatibility, pricing catalogs and complete multimodal support remain
  explicit work. No generic base URL alias should claim those contracts are implemented.

## Mistral configured-family contract

The locked SDK names its native `/v1/chat/completions` transport `mistral-conversations`. This module
implements that existing configured family, not Mistral's separate stateful Conversations API.
`MistralProvider` applies a distinct profile to the common chat event machinery: nine-character
alphanumeric tool IDs are allocated consistently across calls/results, typed text/thinking arrays
are replayed, adjacent thinking chunks are joined without empty-text separators, object-form tool
arguments are supported, `model_length` maps to an output-length stop, and either DONE or clean EOF
requires a prior finish reason. OpenAI Chat retains its original stricter DONE contract.

`max_tokens`, optional `prompt_mode`/`reasoning_effort` and explicit `prompt_cache_key` are serialized;
the cache key is also the request-local `x-affinity` header. Credentials use the standard Bearer
resolver. Cached-token variants are normalized while retaining the complete raw usage object.

Connection scoping is enforced by every serializer and every emitted original. Empty or mismatched
connection identities lose their opaque continuation while keeping semantic text/tool history.
The trusted factory derives identities from validated endpoint and configuration/reference facts;
the environment-only credential prototype still requires a generation bump when account identity
changes. A full credential broker must carry authoritative credential identity/version at cutover.

## Native auth module

`auth::NativeCredentialBroker` is a dispatch resolver over an injected `CredentialStore`. Its public
`CredentialScope` is nonsecret metadata: reference, authority, account and relink generation. Ordinary
same-account token rotation does not change that generation. Each transaction checks the pinned scope
before resolving or refreshing and again before returning headers. The backing store is the sole writer
and must persist a successful refresh before returning; no credential-file fallback exists here.

Caller cancellation races the credential worker without cancelling an already-started refresh. The
broker's runtime shuts down in the background so dropping a cancelled caller cannot discard the only
valid rotated refresh token. Store transactions are keyed per credential; unrelated connections do not
share an authentication lock. `HttpOAuthRefresher` implements registered HTTPS public-client form/JSON
refreshes with timeout, response budget, disabled redirects and disabled retries. It does not perform
login, broaden scopes, store client secrets or discover cloud identities.

See `AUTH.md` for the Host/platform authority boundary. The Application Host now supplies the existing shared credential owner over the private kernel bridge,
and brokered Pi runtimes delegate to that same owner. Real temporary-store and Pi-worker IPC checks
supplement the synthetic broker tests; live cloud authentication remains unverified.

## Codex SSE contract

`CodexProvider` uses the distinct `openai-codex-responses` family and requires a complete authorized
`/codex/responses` endpoint. It extracts textual system instructions into the required top-level field,
keeps encrypted reasoning, enables parallel tool calls, and preserves the frozen branch/run cache
identity as a 64-character SHA256 key. It sends the SSE beta header, honest Varin user-agent/originator,
session identity and the individual request ID. A guard requires both a Bearer token and account header
from the explicit credential binding; it never decodes JWTs to invent verified account authority.

The locked SDK does not send `max_output_tokens` to this backend; the adapter does not pretend a common
configuration capacity is a supported Codex wire budget. Run-budget policy remains a separate concern.
WebSocket incremental state, account-keyed socket pooling, zstd and full capability parity are not
implemented by this SSE-only path. Real account authorization remains a separate acceptance gate; Host store wiring is now present; no live credentials were used to develop or validate these modules.
