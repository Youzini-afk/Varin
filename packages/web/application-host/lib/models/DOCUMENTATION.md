# Model connections, settings and credentials

`ModelsService` owns the Agent runtime's channel catalog, model selections, project trust, and purpose bindings in the Application Host. The Host prepares product configuration, tokenizer cache entries, and transient credentials; Rust owns native protocol execution, HTTP/SSE transport, retries, cancellation, and durable request/usage facts. See [runtime ownership](../../../../../docs/runtime.md) and [Rust providers](../../../../../kernel/crates/varin-runtime/src/providers/README.md).

## Entrypoints and storage

| File(s) | Responsibility |
| --- | --- |
| [`service.ts`](service.ts), [`channel-types.ts`](channel-types.ts), [`channel-patch.ts`](channel-patch.ts), [`discovery.ts`](discovery.ts) | Channel catalog, built-in type definitions, CAS patches, model discovery, and captured bindings |
| [`directory.ts`](directory.ts), [`channel-directory.ts`](channel-directory.ts), [`channel-directory.json`](channel-directory.json), [`directory-models.ts`](directory-models.ts), [`directory-snapshot.ts`](directory-snapshot.ts), [`metadata-match.ts`](metadata-match.ts), [`catalog.ts`](catalog.ts) | Background directory refresh, bundled service templates, offline models.dev snapshot, and metadata matching |
| [`connection.ts`](connection.ts), [`retry.ts`](retry.ts), [`compaction-settings.ts`](compaction-settings.ts) | Credential-free headers/paths/proxy validation, retry rules, and compaction policy |
| [`configuration.ts`](configuration.ts), [`settings.ts`](settings.ts), [`project-trust.ts`](project-trust.ts), [`project-settings-scope.ts`](project-settings-scope.ts) | Revisioned settings, file observation, and native project trust |
| [`credentials.ts`](credentials.ts), [`oauth.ts`](oauth.ts), [`oauth-device.ts`](oauth-device.ts), [`google-auth.ts`](google-auth.ts), [`aws-auth.ts`](aws-auth.ts), [`anthropic-auth.ts`](anthropic-auth.ts) | Account storage, browser/device OAuth, cloud ADC/AWS chains, and Anthropic workload federation |
| [`tokenizers.ts`](tokenizers.ts), [`tokenizer-metadata.ts`](tokenizer-metadata.ts), [`token-count.ts`](token-count.ts) | Local tokenizer download/cache preparation and read-only native token counting |
| [`delegation-catalog.ts`](delegation-catalog.ts), [`classifier.ts`](classifier.ts), [`classifier-protocol.ts`](classifier-protocol.ts), [`rerank.ts`](rerank.ts) | Delegation model selection snapshot, decision classifiers, and rerank bindings |
| [`extensions.ts`](extensions.ts) | Reviewed `varin.models@1` protocol and auth contributions with exact adapter pins |
| [`pricing.ts`](pricing.ts), [`usage-routes.ts`](usage-routes.ts), [`routes.ts`](routes.ts), [`test-route.ts`](test-route.ts) | Price snapshots, `/api/usage/summary`, authenticated model/trust routes, and `/api/models/test` |

Client wrapper: [`packages/application-client/src/model-connections.ts`](../../../../application-client/src/model-connections.ts).

**Storage files** (all use `@varin/settings-store` locking, atomic replacement, private permissions on new files, and revision CAS):
- `VARIN_DATA_DIR/models.json`: user channels and saved models.
- `VARIN_DATA_DIR/agent-settings.json` (and trusted `<project>/.varin/settings.json`): global/project purpose selections, `retry`, `compaction` (`reserveRatio` in `[0, 1)`, default `0.1`; legacy `reserveTokens` rejected), and `resources` (roots: `VARIN_DATA_DIR/resources`, `.varin/resources`; see [agent-resources](../agent-resources/DOCUMENTATION.md)).
- `VARIN_DATA_DIR/model-auth.json`: model credentials (separate from MCP's `mcp-auth.json`).
- `VARIN_DATA_DIR/project-trust.json`: owned by `ProjectTrustService`; missing entries are untrusted, explicit `true`/`false` inherit along canonical ancestors.
- `VARIN_DATA_DIR/model-directory.json` & `VARIN_DATA_DIR/cache/tokenizers`: derived caches, never user-config authority.

**Storage & trust invariants**:
- Reads never create or repair files; malformed documents are errors (existing valid bindings may retain last valid state, invalid channels do not drop valid sibling channels).
- Agent-facing reads redact header values and URL credentials; `patch` edits declared fields against the stored channel in one CAS transaction (`reset` clears optional fields). Never write a redacted projection back as a full channel.
- `/api/project-trust/read` and `/update` accept an existing workspace ID resolved through Documents admission (never raw paths) and pin both canonical `expectedPath` and file revision. Every new project resource/model/MCP access rechecks current trust; revocation broadcasts `project-trust` invalidation without rewriting immutable input history.

## Channels, metadata and connection options

- **Identity**: A channel is one stable user connection; each model has a stable catalog ID and optional `requestModelId` for upstream wire routing and thinking-dialect selection (opaque Bedrock IDs fall back to the configured model-name hint). Display names are never routing keys.
- **Mixed & specialized protocols**: Mixed-API channels (e.g., OpenCode, Command Code) declare `protocols` and `modelBasePaths` so one connection serves multiple codecs. Decision models declare `decision` + `decision.api` (`typesafe-system-one`, Cloudflare System One, or multi-route `llama.cpp` with `tokenize`/`applyTemplate`/`completion` relative to root without trailing `/v1`). Image models declare `image.api` and `image.paths.{generation,editing}`. Capabilities (`contextWindow`, `image`, `thinking`, `thinkingLevelMap`, `compat`) are explicit, never guessed from aliases.
- **Directory & overrides**: `ModelDirectory` loads `model-directory.json` and refreshes `channel-directory.json`, models.dev, and public lists in the background (6h freshness, conditional HTTP; dispatch never waits on it). Precedence: user overrides > live service facts > models.dev / canonical-model metadata. `model.catalog.overrides` tracks explicit field edits (including explicit empty `description` strings); directory refreshes never rewrite `models.json`, enable discovered models, or alter captured bindings.
- **Discovery & test**: Discovery (`discover-draft` or saved connection) is read-only; Gemini/Anthropic pagination aborts cleanly without publishing partial lists. `/api/models/test` sends one short request via the standalone `ModelTextService`/Catalog inference owner without saving drafts or creating a conversation.
- **Connection options (credential-free)**:
  - `headers`: non-sensitive headers only; auth/transport headers are rejected and overridden case-insensitively at dispatch (`anthropic-beta` appends).
  - `paths`: same-origin subpaths under the configured base path; traversal, query strings, and fragments are rejected (safe base-URL queries survive).
  - `proxy`: omitted (Host egress policy), `direct`, or credential-free HTTP(S) proxy origin; explicit overrides never silently fall back to direct. Model endpoints may target local, LAN, or Docker networks using standard Host egress routing.
- **Retry**: Host-wide `retry` settings in `agent-settings.json` are evaluated in Rust `model_retry.rs` (linear-time regex dialect; `/api/models/retry/test` validates via `runtime.retry.evaluate` without I/O). Protocol SDKs do not add a second retry loop.

## Tokenizer metadata and cache

- `ChannelModel.tokenizer` accepts a tiktoken encoding, Hugging Face repo/revision, public `tokenizer.json` URL, or explicit absolute Host file path. Remote metadata never selects local files.
- `ModelTokenizers` caches gzip-compressed files under `VARIN_DATA_DIR/cache/tokenizers` keyed by SHA-256 of uncompressed bytes (coalescing concurrent downloads, using Host egress without model credentials). Floating repo refs pin to first cached content; local file changes create a new immutable cache entry.
- Conversation preparation uses cached entries immediately, downloads missing ones in the background, and falls back to reference-tokenizer estimation when uncached/unsupported.
- Prepared file hashes/encodings freeze into `ModelSessionConfiguration` and `RequestBinding`. Rust loads tokenizer JSON without executing repo code or downloading on the counting path, shares parsed vocabularies via weak references across live counters, and reopens read-only token-counting resources across kernel epochs while keeping released consumers closed.
- Cache GC runs after config changes or binding release, preserving configured heads, active Host leases, and native Catalog roots (active/queued Runs, latest branch Run, pending selections, frozen child directories, unfinished compaction/delegation).

## Delegation model selection

- `harness.delegationModelSelection` is a user-owned, disabled-by-default purpose setting (projects cannot enable or redirect it; `next-request` consumer boundary). Supports chat and decision models (`decision` takes precedence when both are declared).
- `delegation-catalog.ts` captures one snapshot of opaque IDs, descriptions, capabilities, capacity, pricing, and effective thinking options without acquiring credentials or workspaces; connection/auth facts sit behind a configuration fingerprint hash.
- Selection freezes only at first child preparation (never during parent tool preparation). Replay reads original recipes/receipts without re-selecting. The selected executor rechecks its config fingerprint before acquiring credentials, and the native provider serializer supplies final capacity checks (rejecting over-budget requests as durable not-dispatched failures).

## Authentication and retained bindings

- **Sources**: stored credential (`model-auth.json`), explicit env var, direct cloud SDKs (Google ADC, AWS/Smithy signing), Anthropic workload identity (`anthropic-federation` JWT-bearer exchange against `/v1/oauth/token`, HTTPS except loopback, no credential redirects, never persisted to disk), or explicit anonymous access.
- **OAuth & device flows**: Issuer IDs must match those declared by the installed channel type (checked before capture, refresh, or header generation). Browser OAuth uses Host interaction callbacks; Kimi Code, GitHub Copilot, xAI, Meta, and OpenCode Zen/Go (client ID `varin`) use device-code polling. Copilot resolves and freezes its account endpoint at request preparation. OpenCode derives session/request/project affinity headers in Rust from the execution branch/workspace.
- **`CredentialScope` & leases**: Binds authority, reference, account/source, and generation without storing secrets as identity. Token refresh is single-flight per account; normal rotation preserves identity while replacement, sign-out, or changed dynamic sources invalidate affected bindings. Missing credentials never fall back to another account.
- **Retention**: Captured model and auth handles hold real leases across preparation, queued Run handoff, continuation, auxiliary stages, and delegated child handoffs (including model-only nested children) until actual drain. Dispatch rechecks original scope and target before returning transient headers; secrets never enter DTOs, snapshots, history, or logs. See [AUTH.md](../../../../../kernel/crates/varin-runtime/src/providers/AUTH.md).

## Extension protocol and authentication contributions

- `varin.models@1` (`provideModels`) validates a complete candidate, publishes its adapter set to the Rust registry, then commits channel/auth contributions atomically (failed/superseded loads keep the prior generation).
- `adapterIdentity` pins verified artifact/composition + metadata identity; `adapterBindingId` pins one live instance. Live pins are never replaced by logical-name lookup; recovery requires exact content identity.
- Brokered protocol contract is chat over SSE: extension callbacks serialize/parse typed payloads without seeing credentials while Rust owns HTTP/SSE, usage, cancellation, and the request ledger. Kernel disconnect cancels and drains callbacks before releasing pins. See [extension SDK](../../../../extension-sdk/README.md) and [model protocol example](../../../../../examples/extensions/model-protocol/README.md).

## Purpose inference and usage accounting

- Conversation, embedding, rerank, decision, and image (`generation`/`editing`, independently configured; unconfigured tools stay absent) retain typed I/O and original Catalog receipts.
- Provider usage belongs to its original ModelStep or inference Operation (actual, estimated, missing, and pending stay distinct; cancellation is not zero usage; raw non-token image usage is preserved).
- `usage-routes.ts` serves `/api/usage/summary` from Rust `runtime.usage.summary` (no Host usage DB). `pricing.ts` freezes prices/billing class on each binding and only supplies labeled current-price estimates for unpriced receipts. Native ledger totals stay separate from external Harness self-reported counts. See [runtime image tools & usage](../../../../../docs/runtime.md#providers-usage-ledger--image-tools).
