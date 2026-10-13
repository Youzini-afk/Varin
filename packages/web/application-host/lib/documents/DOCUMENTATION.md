# Documents module

Application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

This module is the application-host authority for revisioned workspace documents, file watches, and crash-recovery journals.

Text editors and workspace text helpers consume DocumentsAPI. `FilesAPI` remains browse/binary/CRUD, and `WorkspaceAPI` remains project/tree/git/upload. Neither exposes a duplicate text read/write shape.

## Entrypoints

- `authority.ts`: `createDocumentAuthority(options)` — workspace identity, revisioned read/write/move/delete, watch, recovery journals, immutable agent-input snapshots, and `applyAgentSurfaceWrite` (the shared root-session plan that edits a live Registry buffer or applies disk targets through the bound durable file backend). Production binds the Rust file-resource backend: write/move/delete and mixed surface/disk mutations use its exact/subtree gate and conditional filesystem operations. `inspectWorkspace(workspaceId)` returns `{ workspaceId, hostId, root }` after physical-root admission. `admitWorkspaceRegistration(workspaceId, signal?)` checks the original Host registration and current deployment trust without reopening that directory; its `canonicalPath` identifies a configuration namespace, not a physical capability. Both methods are Host-only collaborators, not renderer DocumentsAPI methods.
- `surface-mutation.ts` — classifies snapshot-owned vs disk paths, matches every edit against the original content and rejects overlapping matches before writing, writes editor-canonical text through `requestSurfaceOperation`, and compensates a mixed batch with one undo that reuses the apply `operationId`. UI `bufferHash` is compared only to the normalized editor identity, never to serialized snapshot bytes.
- `line-ending.ts` — detect / normalize / serialize editor line endings so Registry buffers stay LF while snapshots keep the file's original endings.
- `agent-mutation-operation.ts` — durable `agent-mutation` kind on the Rust typed recovery store. It records intent before the first write, per-path before/target identity, external dispatch/compensation/observation phases, and monotonic needs-attention. Disk capture/apply/compensation uses the Rust file-resource backend; Registry receipts remain Host-coordinated. The durable store is the sole operation authority; there is no bounded in-memory mirror. This is not an Integration operation.
- `surface-snapshot-store.ts` — content-hash-deduplicated in-memory copies of one input surface's dirty buffers, including encoding/BOM metadata, editor `bufferHash`, `lineEnding`, and content serialized with its original line endings so consumers can reproduce save bytes. Each snapshot belongs to an explicit `pi-session` or `thread` consumer. Pi acceptance activates its pending snapshot; replacement, rollback, consumer drop, and Host disposal release content references. Thread snapshots remain immutable until release. The internal clone operation lets Thread preparation copy a validated snapshot into persistent WorkingState; it is not a renderer route.
- `routes.ts`: `registerDocumentRoutes(app, { documents, uiAuthController })` — authenticated `/api/documents/*` routes.
- `capability.ts`: `createDocumentsCapabilityHandler(authority)` — resource-scoped `workspace.documents` Host capability.
- `contract-fixtures.ts`: shared Web contract fixtures.

## Filesystem observation

`watch.ts` projects filesystem hints into invalidation generations; it never establishes content revisions.
Windows uses `windows-watch.ts` and the packaged kernel's private `--watch-directories` mode. This helper
owns notification handles independently of Catalog, Storage and tool execution. It subscribes separately
to names/attributes/security and content changes, excludes access time, and lets Documents ignore
directory-only content timestamps. Windows can emit a delayed directory LAST_WRITE notification on
first enumeration with unchanged metadata; directory modes still arrive through the attribute stream.
The parent subscription observes root metadata/replacement, and flush validates the named root identity.
No directory inventory or file body cache is needed. Other platforms retain their Node watcher.

Documents capture, language views and managed file observation await subscription readiness. `settle()`
joins native notification delivery and Host metadata processing; it does not wait for the directory to
become quiet. Overflow or handle loss invalidates the generation. A reconnect replaces readiness, and
closing a subscription settles its pending callers. Idle subscriptions do not keep the Host process alive;
the last close or Host pipe EOF releases the helper. Stable capture retains its two state reads and inventory
check in addition to these observation hints.

## Routes

- `POST /api/documents/workspace/resolve`
- `POST /api/documents/read`
- `POST /api/documents/write`
- `POST /api/documents/move`
- `POST /api/documents/delete`
- `POST /api/documents/dirty/publish|clear|barrier/ack`
- `POST /api/documents/agent-input/capture|release`
- `POST /api/documents/surface-operation/read|complete`
- `GET /api/documents/watch?workspaceId=` (SSE; credentials stay in headers, not the URL)
- `POST /api/documents/recovery/list|read|write|delete`

Watch events carry resource metadata only. Agent-input capture bodies use the authenticated Documents POST channel. Runtime worker requests receive only an opaque snapshot reference or unavailable dirty paths; file bodies are not written to logs, event payloads, or URLs.

Thread Integration uses Host-directed surface capture/apply/undo requests. The dirty-owner connection carries the request ID; the authenticated surface-operation routes carry bodies and receipts. Authority checks owner registration, generation, workspace and document identity. Integration persists its intent before dispatch and only completes after a valid receipt; caller-provided paths cannot acknowledge a write. Confirmed own writes update matching active Pi agent-input sources. An uncertain dispatched write invalidates those Pi paths, so reads cannot silently return either the old draft or old disk. Thread source snapshots and ordinary later user edits do not participate in that Pi own-write replacement rule.

Combined recovery adds `restore` under its original affected-path barrier. It replaces the live buffer
and disk base with one version-checked Registry transaction; it does not issue an editor save. Capture
under that barrier also reads a now-clean or missing document for undo. The recovery row retains original
draft/base content and each dispatch receipt through the kernel's existing object references. Registry
waits for affected reads and saves before acknowledging, defers related file notifications while held,
and replays only actual deferred reloads on release. Unchanged disk revisions preserve unsaved edits.

Thread source selection resolves the chosen directory through Documents once, then freezes its
`workspaceId`, preparation key, explicit saved-files or surface-drafts choice, and capture scopes.
The Registry includes dirty buffers only from that selected physical root, including verified aliases;
another registered workspace cannot contribute bodies. Preparation reads its original durable branch
receipt before requiring a still-live snapshot or directory. A completed request can therefore be
retried after snapshot release or a directory move, while current registration and trust admission
remain mandatory. This does not authorize a live file operation through registration metadata alone.

The original resource-identity query accepts `withinWorkspaceId` for this selection. Only disjoint
registered canonical roots return `null`, without opening an unrelated offline root. Overlapping
parent/nested/file registrations still resolve actual physical identity and aliases; their admission
failures remain errors. The Registry does not infer paths from opaque coordination IDs.

Root-session mixed surface/disk mutations preflight every disk member under the same Rust file-resource lease before sending any surface request. Explicit failure is recorded as not applied; a missing authenticated Registry receipt remains uncertain. Conditional compensation continues across paths and never overwrites a later user edit. Rust file operations persist intent before the side effect and reconcile started operations after kernel restart; an observed mismatch remains conflict/needs-attention rather than being guessed complete. Recovery status and the Recovery panel expose durable `agent-mutation` needs-attention rows.

## Persistence

Workspace IDs live under `{VARIN_DATA_DIR}/documents/workspaces.json` and are scoped to this application host. Converting a filesystem path into an ID performs the current root-admission check once; later operations use that persisted host registration instead of re-reading mutable project selection settings. Physical document operations still canonicalize the root at use time, reject a changed filesystem identity, enforce resource containment, and fail with `workspace-unavailable` while the root is inaccessible. Loading this registry never touches workspace storage: a deleted or disconnected root keeps its workspace ID and cannot prevent other registrations from loading. Recovery journals live under `{VARIN_DATA_DIR}/document-recovery/{hostId}/...`. Agent-input snapshots themselves are deliberately Host-memory state: they survive a renderer/surface disconnect, but Host restart makes an unconsumed opaque ref unavailable rather than reading current disk as the old draft. A Thread created from one first copies its content into the separately persistent WorkingState store. Another host must not inherit the same-path selections.

Registry lookups index the current committed document by workspace ID and normalized canonical path. Exact lookups reuse that index; containing-root lookup walks path ancestors, including filesystem roots, instead of scanning and sorting every registered root. Path indexing is lazy so ID-only readers do not normalize the full registry. Concurrent cold readers share one load and can retry a failed load. Registrations remain serialized and publish a new document only after the atomic rename succeeds; duplicate registrations reuse the committed identity without rewriting it. No disk schema or root-admission boundary changes. `node --import tsx scripts/measure-document-registry.mjs` measures cold/warm lookups and concurrent I/O counts on synthetic roots.

Electron reuses this Web host in-process. It does not add a generic filesystem preload IPC.

Native fixed-source admission and source-derived configuration routing use `admitWorkspaceRegistration`.
They may continue after the former live directory moves, but an absent Host registration or withdrawn
deployment trust still rejects access. Storage independently admits the exact branch/revision and its
current grant; materialized execution independently validates its original managed directory. Registration
metadata never substitutes for the physical checks required by live reads, capture, processes or file effects.

## D-278 kernel gate composition

When durable mutation storage is bound, nested Documents resource operations must enter the kernel gate even when
canonical path keys match. Only Rust `file.lease.check` may decide whether exact/subtree coverage is sufficient;
the local queue shortcut is confined to the unbound test seam. The real Documents write/stale-save/move/delete
composition and a nested exact-to-subtree rejection are covered by `../kernel/file-resource-audit.native.test.ts`.
The combined recovery restart/undo test now uses real Documents and the real Recovery kernel gate rather than
no-op gate stubs. The Pi navigation response-loss adapter is still simulated and is not a real model/UI session.
