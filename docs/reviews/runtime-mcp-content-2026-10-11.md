# MCP content, resources and prompts through the original owners

Date: 2026-10-11. Baseline: `cbd286ba7e6a450c7a4205c1b0cc037cb91c8619`.
Status: finite slice accepted after original-owner integration and independent review.

## Finite contract

The original `McpAuthority`, installed MCP client and `McpCompositions` own configuration, connection,
credentials, provider grants and retained generations. This slice adds native resource/template pages,
resource reads and prompt pages/get to that owner. Tools-only, resources-only and prompts-only servers
already negotiated successfully at the baseline; this is a native consumer completion, not a claimed
handshake repair. No second client, credential store or Pi session is introduced.

`kernel/protocol/schema.json` declares the public helpers and their typed routes once. Generated Host
schemas and frozen `McpBinding.routes` reach Rust admission, child subsets and restored compositions.
Rust interprets `direct`, `server_argument` and `discovery` rather than repeating helper-name lists.
Catalog **49** and Kernel wire **4** replace the previous internal formats directly; content **4**,
manifest **2** and policy **4** remain unchanged. The generated event envelope follows the same wire
version. External configuration, workspaces and Pi assets are not migrated.

- `mcp_discover` retains local catalog/selected-server preparation and adds negotiated service versions.
- `mcp_call` retains exact tool/version/arguments dispatch.
- `mcp_list_resources` supports resource or template pages and the original cursor.
- `mcp_read_resource` sends the URI to the selected original server. Prior listing is not required.
- `mcp_list_prompts` returns the complete page and exact versions for its prompt descriptors.
- `mcp_get_prompt` requires that descriptor version and string arguments, including required own fields.

The owning [MCP module](../../packages/web/application-host/lib/kernel/MCP.md) records exact request
fields. Whole page metadata is retained, including top-level `_meta` that the earlier SDK convenience
page projection dropped. Resource links are data; their existence does not fetch a URL or local file.
Unknown string prompt arguments remain the server's responsibility. Remote roles, annotations and
read-only hints do not grant authority or become provider instructions.

## Content, authorization and lifecycle

Known protocol payloads under `tools.content`, `resources.contents` and `prompts.messages[*].content`
become ordered Text/Media parts. Each original payload field points to its exact `{outputPartIndex:n}`;
its URI, role, MIME, annotations, `_meta` and other siblings stay intact. Unknown content kinds and
ordinary `structuredContent` remain opaque JSON. Resource text precedes blob when both are present.
A blob without a MIME uses `application/octet-stream`; an invalid supplied MIME follows the existing
same-index diagnostic path without changing the original result/effect or other parts.

Original Rust execution stamps the actual origin, writes body/media outside Catalog, commits the
same Operation and model result pairing, and exposes bytes only through their original holders.
Policy actions and nested calls use their real origins. A policy result is readable from original
PolicyEvidence without manufacturing a model call. History, Operations, forks, GC and reopen retain
those same content references. Supported image payloads reach the original provider serializer;
unsupported provider/MIME combinations fail explicitly. The shared non-image UI offers the original
media download; this slice does not add remote model audio or arbitrary document understanding.

Every selected remote service remains an ordinary effect-capable operation with the original server
resource claim. Original permissions cover exact call, arguments, schema, owner and policy generation.
Pre-dispatch failure has no effect; cancellation after actual entry retains unknown remote effects and
unconfirmed stopping. There is no read-only transport retry or replay of an unknown completed request.
Explicit hide/disable revokes admissions. Ordinary replacement preserves a frozen old contribution
until its original users release it rather than retargeting them to the new gateway.

Independent review found a concrete lifecycle seam: bypassing the SDK's automatic read retry also
bypassed its expired-session handling. Two independent native requests kept sending the old HTTP
session after a 404, although the original resource entry could reconnect. A one-shot connection
entry now shares the original identity-bound session detachment and authentication state handling
without replaying the operation or closing another in-flight call. The original expired-session
error supplies separate RPC-stop evidence: the result retains Unknown effects while releasing the
actual server occupancy. No new no-effect guarantee is inferred. The ordinary default policy still
stops on Unknown; this integration explicitly checks that decision before its custom test policy
chooses a distinct new operation. The old result remains Unknown. Session reconstruction follows the
[protocol session management contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management). A direct Host reconnect alone is insufficient: the actual Engine must
successfully dispatch a distinct subsequent operation on that same server resource.

Prompt declarations belong to the same connection. A new client or `prompts/list_changed` invalidates
them. An old in-flight page cannot repopulate the invalidated cache. Current matching declarations are
reused; cold recovery resolves the exact descriptor through original paginated listing. Repeated
pagination cursors produce an explicit failure rather than looping forever.

Trusted local admission failures now cross the original private Host/Rust bridge as a generated,
locally branded marker. The model can distinguish unsupported capability, stale version and missing
required prompt arguments. The generic error remains for untrusted/remote exceptions, including
objects that forge `code` or `admission`; arbitrary error text and credentials are not forwarded.

## Original-chain verification

The new ignored integration is runnable explicitly from the repository root after the normal protocol
and Pi Host builds:

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
  agent_runtime::mcp_content_review::original_mcp_content_resources_prompts_reach_model_permissions_and_persisted_readers \
  -- --ignored --exact
```

It requires workspace Node/tsx and compiled Pi Host. It uses the original Rust Engine, RunSupervisor,
ToolBridge and Catalog, original TypeScript ToolBridge/PermissionService/McpAuthority, and the installed
MCP stdio transport spawning an actual local protocol peer. Test-only stdio carries private bridge
frames between Rust and Host. Model decisions, peer payloads and allow-once clicks are controlled;
actual permission open/decide/consume, tool admission, dispatch, receipts and storage are not replaced. An additional original HTTP transport has only its fetch responses controlled,
without a listener or network request. It does not open the product socket transport or call a paid/remote provider.

The accepted path has seven real model request compilations, fifteen model tool results, eleven original
one-action permission decisions and a subsequent real PolicyAction ToolGraph resource read. It covers
resource/template/prompt pagination, complete page metadata, an unlisted URI, tool/resource/prompt
images, opaque lookalike JSON and remote prompt roles. Three accurate admission errors reach the next
model request without the corresponding remote operation: resources on a prompts-only server, a stale
service version and missing required prompt arguments. Original media and policy-evidence readers,
fork, GC and close/reopen recover the original bytes without restarting an MCP server.

The initial integration fixture was missing the activated tool composition's canonical sorting; only
the fixture was corrected. Two existing child tests renamed a tool without its newly frozen route;
the fixtures were updated without relaxing production validation. These are distinct from product
fixes: complete-page retention, retained contribution selection, prompt notification/cache ordering,
and actionable trusted admission projection.

Scoped current evidence also includes:

- 47 Catalog unit cases and 42 cases across child delegation, continuation, composition, prepared
  request recovery, nested invocation and source inheritance.
- 15 original Node MCP grant/policy/startup/session/proxy/service/HTTP cases and 22 Host cases across
  bridge, projection, composition and actual stdio source-less/service-only child preparation.
- Two original Rust Host tool integration cases and the explicit cross-language MCP integration.
- Protocol generation and Pi/Host source/test types, changed-source lint and production Host bundle:
  548 reachable modules, with 88 legacy/test artifacts excluded. CLI and Web assets also build for
  the ordinary cloud-runtime staging/lock refresh; this is not an installed-product smoke.
- The installed SDK runtime and declarations exactly match the checked dependency patch. Workspace
  and production lock graphs remain semantically unchanged after the official refresh and frozen
  verification; formatting-only lock churn is not retained.
- The normal staging script verifies Linux x64 ELF identity 0.9.25, wire 4, SHA-256
  `96f3ae5251e93b84397d9122d5577328639dc628b2352c5a74aaddcd0735caa0`.
  The frozen source manifest covers 4,972 non-documentation kernel/package/script/example and root
  build inputs, SHA-256 `73329c7cda40bcbaee9ba9c2df44ec5aefa21d4485d59091e64bbe759d781313`.
  It is rechecked before publication. The same fourteen existing kernel warnings remain.

Independent review starts from the two designs and the maintainer's fourteen integration findings,
not the writer's test list. Its original-stdio probes independently cover capability-only peers,
page metadata/cursors, mixed text/image/audio/blob order, opaque JSON, cancellation before and after
remote entry, disabled admissions, and both prompt descriptor and in-flight list-change races. Its original HTTP transport probes use
controlled in-memory fetch, without a listener. They independently show the expired request enters
once, a distinct request initializes session-2, and another original in-flight session-1 call is not
closed or aborted. Ordinary HTTP 500, network loss, accepted SSE resume failure and remote JSON that
spoofs an expired-session error retain Unknown effects and unconfirmed stopping. The real Engine
integration then confirms the same-server occupancy boundary with an explicit new policy action.

Independent review accepts this finite slice with no remaining confirmed production blocker.

## Remaining boundaries

MCP Tasks and durable remote-task reconciliation, resource subscriptions/updates and server-initiated
interactions remain unfinished subsequent work. This slice does not claim full socket Host IPC,
installed Desktop/mobile/Windows acceptance, real remote MCP/OAuth servers, remote model quality,
latency or large-load performance. The maintainer's earlier Windows evidence remains specific to its
own baseline and cases. Both designs remain in progress, with final product migration owned by the
user after acceptance.
