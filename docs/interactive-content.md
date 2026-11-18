# Interactive Chat Content & User Quoting

Assistant responses support two interactive tiers alongside normal Markdown/math/tables/Mermaid:

1. **Inline declarative widgets (`varin-ui` fenced JSON)**: Lightweight choices, inputs, forms, disclosures, tabs, embeds, and live native object links placed directly between prose paragraphs.
2. **Custom HTML/JS artifacts (`render_ui`)**: Full sandboxed interactive charts, calculators, and custom tools rendered inline at natural content height (or expanded to sidebar/fullscreen).

## Inline Declarative Blocks (`varin-ui`)

- Only top-level `varin-ui` fences in assistant messages execute (user messages, tool raw outputs, quotes, and nested code examples stay plain text). Incomplete streaming blocks show placeholders; invalid JSON shows readable errors + raw text without auto-calling the model.
- Supported `type`s: `choice` (`multiple`, `allowOther`), `input` (`text` | `textarea` | `number` | `range` | `date`), `form` (`fields`), `disclosure`, `tabs`, `embed` (`ref: "ui:<id>@<rev>"`), and `object` (`ref: "<nativeRef>"`).
- **Actions**: String `action` fills an editable draft in the composer; object `action` supports `compose | reference | copy | open | send`. Selections never auto-send — explicit `send` runs through a platform-owned button outside the widget using the normal thread input/queue owner.
- Detailed model examples live in `render_ui`'s on-demand metadata (`tool_describe({ name: "render_ui", detail: "full", path: "/examples" })`), not permanently stuffed into system prompts.
- **Copy & Export**: Turn copy and Markdown export convert valid declarative blocks to readable text from the original assistant message; JSON export preserves raw definitions; HTML download produces a standalone snapshot with embedded media/state (no host save/send channel).

## Native Object References (`type: "object"`)

References never grant new access; opening/reading goes through the owning service:

- **Task / Agent**: Thread ID or dispatch operation ID → live name/avatar/status, opens original conversation.
- **Plan**: `plan:...` → scoped to `(Host, Thread, branch)`; mismatched older refs stay explicit instead of substituting latest plan.
- **File**: `file:<encodeURIComponent(callId)>/<encodeURIComponent(path)>` → resolves via the original file tool call's owner.
- **Material**: `varin-material://...` or Web citation → verified by Thread material scope.
- **Recovery / Usage**: `recovery:<opId>` (opens recovery panel only) · `usage:<threadId>/<branchId>` (context usage only, not billing).

## HTML Artifact Creation & Revision (`render_ui`)

```ts
type RenderUiInput = {
  ref?: string;
  title?: string;
  entry?: string; // default: "index.html"
  content?: unknown; // declarative varin-ui JSON (mutually exclusive with changes)
  changes?: (
    | { file: string; op: "write" | "append"; text: string }
    | { file: string; op: "edit"; edits: { oldText: string; newText: string }[] }
    | { file: string; op: "delete" }
  )[];
};
```

- Omit `ref` to create; pass `ref` to create a new immutable revision (CAS-checked against the admitted base revision). Paths are artifact-relative only (no `..`, absolute paths, or project file writes).
- Streaming deltas update iframe DOM per paint frame with scripts disabled until the saved revision commits. Each revision executes scripts once per iframe (reconnects do not re-run scripts).
- Explicit inline `embed` and same-turn tool results deduplicate to a single full inline view (other spots link to it). View sessions preserve state/scroll across virtual list unmount and sidebar expansion.

### Sandbox & `window.varinUI` Bridge

HTML runs in an `allow-scripts` sandbox with an isolated origin, inheriting Varin theme CSS variables (`--background`, `--foreground`, `--muted`, `--primary`, `--border`, `--card`, etc.) and reduced-motion preference.

- Local module imports resolve against artifact files; `@varin/ui` provides built-in `controls` (`install`, `button`, `field`, `status`); `media:<resourceId>` pins session image bytes; `d3` and `chart.js/auto` map to pinned CDN versions.
- Fixed page API (no `send`, no model/FS/credential access):
  - `window.varinUI.state`: initial saved JSON state (`null` if unsaved)
  - `await window.varinUI.saveState(json)`: persists sequentially via Host `ui.view`
  - `window.varinUI.setContext(json)`: supplies discussion context when referenced
  - `await window.varinUI.compose({ text, includeContext? })`: fills editable composer draft
  - `await window.varinUI.requestActions([{ key, type, label, text?, ref?, includeContext? }])`: asks the platform chrome outside the iframe to render action/send buttons

## Reading Artifacts & Live Screens (`resource_read`)

`resource_read({ kind: "ui", ref, view })` reads artifacts (`ui:...`, `ui:...@N`), live instances (`ui-view:...`), snapshots (`ui-snapshot:...`), and user selections (`ui-selection:...`).

- Views: `summary`, `source` (directory or file range), `state`, `screen`, `structure`.
- Requesting `screen`/`state`/`structure` on a bare `ui:` ref returns `ui_view_required`; disconnected views return `ui_view_disconnected`; unsupported screenshot platforms return `ui_screen_capture_unsupported`.
- Desktop captures the visible iframe region (`screen`); other platforms fall back to DOM redraw (`dom`, clipped to visible viewport). Read-only observation never clicks, scrolls, or mutates the page.

## User Quoting & Draggable Composer Markers

- **Capture**: Text selection (cross-paragraph/message), block context menu (paragraph/list/code/table), explicit "Quote full turn" (assistant prose only, excluding tool summaries/thinking), tool call results (individual real call), images/files (via real media/attachment owners), declarative state, and HTML context/box-select screenshot.
- **Draft model**: Quotes enter `ThreadDraft` as structured objects with atomic CodeMirror markers (`[Quote N]` / `[Image N]`) movable/deletable/undoable as one transaction. Deleting a marker keeps the attached object; removing the attachment deletes all its markers and renumbers. Typed plain text `[Quote N]` never fabricates references.
- **Contract**: `ContentReference` separates human text + real media/attachments from `source` metadata (internal IDs/URLs are never appended to user prose). History messages render clickable markers opening frozen previews; "Locate source" is separate and fails gracefully when moved/deleted.

## Ownership, Branching & GC

| Entrypoint | Responsibility |
| --- | --- |
| [interactive-ui-tools.ts](../packages/extension-builtins/src/interactive-ui-tools.ts) | `render_ui` tool schema & builtin binding |
| [interactive-ui/runtime.ts](../packages/web/application-host/lib/interactive-ui/runtime.ts) & [store.ts](../packages/web/application-host/lib/interactive-ui/store.ts) | Revision semantics, view observation, Rust Storage (`ui.work`, `ui.view`, `ui.snapshot`, `ui.selection`) |
| [application-client/src/interactive-ui.ts](../packages/application-client/src/interactive-ui.ts) | Client DTOs & observation transport |
| [work-projection.ts](../packages/ui/src/lib/interactive-ui/work-projection.ts) & [InteractiveUiCard.tsx](../packages/ui/src/components/interactive-ui/InteractiveUiCard.tsx) | Streaming projection, iframe sandbox, capture & export |
| [ChatContextMenu.tsx](../packages/ui/src/components/conversation/ChatContextMenu.tsx), [sourceBlocks.ts](../packages/ui/src/components/chat/markdown/sourceBlocks.ts), [chatQuoteObjects.ts](../packages/ui/src/components/conversation/chatQuoteObjects.ts) | Quote capture for prose, tools & media |
| [contentReferences.ts](../packages/ui/src/lib/agent-editor/contentReferences.ts), [markers.ts](../packages/ui/src/components/chat/composer/editor/markers.ts), [ContentReferencePreview.tsx](../packages/ui/src/components/conversation/ContentReferencePreview.tsx) | Draft objects, atomic markers & frozen history previews |

- **Scope & Leases**: Scoped to the Thread's task family; view connections hold replaceable client leases (reconnect invalidates stale leases).
- **Branch isolation**: Forking flushes mounted declarative/HTML views first, freezes state at the fork cutpoint, and restores unambiguously matched views into an independent child-branch lease. Editing a declarative/HTML work on another branch clones an independent copy.
- **GC**: Draft removals release unused selections/snapshots after checking live Catalog retention roots. Full family deletion waits for executors and active UI reads/writes to settle, then atomically releases unreferenced UI records and queues physical blob cleanup (preserving shared blobs).
- **Real-browser acceptance**: See [runtime-acceptance.md](runtime-acceptance.md).
