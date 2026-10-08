# Native model adapters

This module implements OpenAI Responses, OpenAI Chat Completions, Azure Responses and Anthropic Messages as execution `ModelProvider`s.
It is not a claim that every configured Pi provider, OAuth flow, or production Host path has migrated.

## Dispatch boundary

`serialize` compiles semantic history into a credential-free immutable request body. Same-family,
version-1 provider originals are replayed without flattening encrypted reasoning, signatures, citations,
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
