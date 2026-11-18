# Agent Collaboration

The lead agent coordinates goals, delegates focused work, and judges overall delivery. Roles (Implementation, Verification, Research, etc.) can be enabled independently and inherit or override models.

- `dispatch` defaults to native Varin, or targets an [External Agent](external-agents.md) via `executor` (alias or `exec:` ref from `executors`) or preset binding.
- Known targets can be dispatched or messaged directly without querying catalogs first.
- Core entrypoints: [harness-presets.ts](../packages/protocol/src/harness-presets.ts) · [child-profiles.ts](../packages/web/application-host/lib/kernel/child-profiles.ts) · [catalog_delegated.rs](../kernel/crates/varin-runtime/src/catalog_delegated.rs) · [code-exchange.ts](../packages/web/application-host/lib/kernel/code-exchange.ts).

## Cross-Session Messaging

- Within the same authenticated principal scope, lead tasks, child tasks, and Bot direct sessions can discover (`threads`, default all accessible; `relationship: "family"` for delegation tree only) and message each other (`send`), including specific branches.
- Internal fast retrieval, compaction, and memory maintenance runs are excluded from collaboration directories. Archived sessions are readable but must be unarchived before receiving new work.
- `inform` queues passively; `request` resumes/continues at the next valid boundary (`afterCurrent: true` waits for the recipient's full Run to settle); `replyTo` binds to the initiating branch. Messaging another session never grants cancel, file, or memory-write authority over it.

## File Handoff (Attachments)

- Both `dispatch` and `send` accept `attachments`: each entry is either `{ "ref": "attachment:..." }` (existing immutable ref) or `{ "path": "..." }` (readable path in the caller's Source), never both. Text body may be empty.
- File/document/Office tools return typed attachment descriptors (`ref`, filename, MIME, bytes). Plain text paths, hashes, or another thread's ref string never grant read access.
- **Atomic preparation**: Runs outside the Catalog lock. Captures paths consistently via the caller's file owner, establishes temporary retention, and admits body + attachment links as one input (no half-delivered messages; same-key retry reuses the original capture and receipt).
- **Consumption**: Vision-capable dispatches receive images as typed media blocks; tools read refs via `file_read` / `document_read` / Office tools, or materialize a read-only file on the executing Host via `resource_read` (`path` view). See [resources.md](resources.md#immutable-attachments).
- **Retention**: Attachments stay readable by surviving recipients even if the sender or source file is deleted, until the last real reference drops. Final reports include only attachments actually delivered to that requester.

## Free Dispatch & Model Selection

- Native `dispatch` accepts `model` (stable channel-config ID from `providers.models`, not raw model name), `thinking`, `inputTypes`, `workFocus` (`general` | `code` | `research` | `office`), `workMode`, and `tools`. Explicit `preset` cannot combine with free `model`/`thinking` overrides.
- **Delegation model selector** (optional, off by default in Agents settings):
  - When off, omitted model/thinking inherits the parent's full binding.
  - When on, runs asynchronously as the first step of `delegation-model:<executionId>` (after tool ACK, before preparing child source/context) to pick only unspecified fields from enabled local channel configs.
  - Input packs fixed requirements, enabled candidates + descriptions, task text, and a bounded preview of the last 3 user turns before the dispatch point (no tool outputs, thinking, or summaries). Uses one tool-free LLM or typed-classifier call (no agent loop, no silent fallback to another channel on error; retries reuse frozen inputs).

## Identity, Short Codes & Lifecycle

- Every Thread has a stable 8-char short code; executions increment monotonically across branches as `<shortCode>/<N>` (e.g. `8F2A6C10/2`), preserved across renames, restores, and restarts.
- `agent_rename` updates metadata only; avatars assign randomly from the flat SVG pool (or preset override) and stay purely visual.
- **Tool queries**:
  - `threads`: Paged lightweight catalog (`scope: "all" | "current" | "history"`, filterable by container, bot, backend, archive, workspace, artifact path). Does not load full histories.
  - `read_thread`: On-demand `overview`, `recent`, `range`, `search`, `item` (returns `body`, plus `preview` only when truncated).
  - `child_status` / `wait_child` / `child_cancel` / `child_report`: `target` pins a specific execution on admission (UTF-8 byte offsets for `child_report`).
- **Active vs History**: A task leaves `current` once terminal (completed/failed/canceled), its report is delivered, and any pending code exchange finishes; re-engaging it via `send` brings it back.
- **Frozen compatibility**: Restarts/upgrades preserve each admitted child's frozen tool schema and read contract (e.g., short refs vs legacy offsets).

## File Sources, Isolation & Code Exchange

`workMode` is chosen per dispatch (independent of role/model/tools):

| `workMode` | Behavior |
| --- | --- |
| `shared` (default) | Shares the selected live/working source directly; edits take effect immediately |
| `isolated_write` | Forks a Native Workspace (WinFsp/FUSE/macFUSE) with a pinned baseline; changes merge back via code exchange. Fails fast with `workspace_backend_unavailable` if backend is missing — never silently downgrades to `shared` |
| `read_only` | Strips file/physical mutation tools (explicitly requesting them fails) |

- **`sourcePath`**: Scopes the child to a subdirectory of the source; handoff preserves parent ↔ child path mapping for merges and recovery.
- **`sourceAgent`**: Captures a running agent's current working state or reuses a finished agent's published revision as the starting point (also supported on continuation via three-way merge).
- **`dispatch.projectId`**: Resolves the target project's real Host, Source, trust, and workspace MCP at preparation time without borrowing the parent's grants or copying MCP across projects.
- **Bidirectional code exchange**:
  - `submit_code({ target?, files?, afterCurrent? })` pushes changes (default: direct parent); `update({ source?, files?, afterCurrent? })` pulls changes.
  - Same writable source returns `status: shared_source, effect: none`.
  - Isolated sources snapshot files and run three-way merge via Integration + Documents dirty-buffer coordination + native recovery journal. `afterCurrent: true` pins the snapshot as a Thread-lifetime Job and applies it once the recipient's active Run settles (cancellable/send-now in the Collaboration panel).

## Collaboration Panel & Composer Handoff

- **Collaboration panel** (right sidebar): Unified chronological projection of family dispatches, messages, reports, and code-exchange cards directly from Catalog (excludes internal `code_retrieval`). Read-only projection — does not own delivery or model wakeups. Supports per-message "Immediate" vs "After current turn" timing and editing/retracting unconsumed user messages.
- **Composer commands**:
  - `/contact` (`/联系 Agent`): Targets real accessible member/branch with per-recipient isolated drafts and idempotent send keys.
  - `/handoff` (`/整理交接`): Creates either an editable directed draft to an existing agent or a native **User dispatch** (empty tool origin/callId, user instruction history, explicit project/source selection, optional paged background messages). Optional "Ask agent to draft" runs an explicit normal task whose result is reviewed before applying.
  - `/export` (`/导出对话`): Streams Markdown or JSON (preferring raw `userText`, excluding Host augmentations/private continuations) to a local download.
  - `/remember` (`/记住这件事`): Writes directly to the relevant Bot KnowledgeStore or personalization record with CAS revision checks.
