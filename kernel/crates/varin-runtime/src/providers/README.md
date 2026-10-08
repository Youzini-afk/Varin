# Native model adapters

This module implements OpenAI Responses and Anthropic Messages as execution `ModelProvider`s.
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

`NativeHttpTransport` builds a reqwest TLS client on the execution worker's Tokio runtime. A trusted
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
