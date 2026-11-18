# Workbench, Documents & Presentation

The workbench is a replaceable UI layer over shared client kernels and Host services. Swapping a shell, editor, or theme never creates a second backend or expands renderer privileges. See [packages/ui/DOCUMENTATION.md](../packages/ui/DOCUMENTATION.md) for component-level details and [interactive-content.md](interactive-content.md) for chat widgets and quoting.

## Responsibility Map

| Owner | Responsibility |
| --- | --- |
| Application Host | Workspace admission, disk documents, file watch, recovery journals, profiles, extension catalog & privileged services |
| `@varin/application-client` | Framework-neutral `RuntimeAPIs`, DTOs, typed failures, observation mux |
| Document Registry | Live text buffers, `baseRevision` / `localEditRevision`, dirty/save/conflict & draft recovery |
| Editor Workbench Kernel | Editor groups, tabs, provider resolution, view identity & layout snapshots |
| Editor adapters | Monaco (desktop/web) & CodeMirror (mobile/embedded) model/view projections |
| Shell contribution | Layout, chrome & short-lived UI state |
| Runtime / domain owners | Conversations, execution, terminals, Git, LSP, debug, tests & resources |

## Profiles, Shells & Visual Transitions

- **Official profile IDs** (ordinary built-in extensions, replaceable/disableable): `varin.bot` (Varin), `default` (Workbench), `varin.ide` (IDE). A fixed Recovery Shell renders if the active shell fails to boot.
- **Orthogonal concepts**: Shell selection is user/application-level; project/conversation navigation never switches shells; switching shells never alters an admitted Run's backend, work focus, model, or source.
- **Storage & transactions**: [WorkbenchProfileStore](../packages/extension-host/src/workbench-profile-store.ts) persists profiles revisionally (corrupt docs surface diagnostics rather than overwriting with defaults). [workbench-shell-transition.ts](../packages/ui/src/lib/extensions/workbench-shell-transition.ts) prepares candidate shells in-place before committing selection; [profile-transition.ts](../packages/ui/src/lib/workbench/profile-transition.ts) coordinates `transition-scene` cover/covered/reveal phases with core fallback and reduced-motion support.
- **Desktop companion preferences**: Managed under Settings → Preferences → Companion; downloads assets on-demand verified by pinned commit/digest ([packages/electron/README.md](../packages/electron/README.md#optional-desktop-companions)). Sleeping the companion closes only the pet window, never stopping Bots or tasks.

## Chat Reading, Composer & User Intervention

- **Reading modes**: Chronological, Conversation-first (default), and Answer-focused. Prose forms reading boundaries; ordinary tools/thinking fold into expandable activity rows while delegated agents, questions, and interactive artifacts stay visible.
- **Tool cards**: `ChatTimelineEntries` honors extension renderers first, then purpose-specific built-in cards (`ChatDelegation`, `ChatExploreCard`, `ChatFileChangePreview`, `ChatProcessTool`, etc.), keeping raw JSON fallback for unknown tools. Expanding/navigating never re-executes tools.
- **Next-step suggestion**: Optional Host-owned auxiliary draft (`useThreadNextStep`) bound to `(Host, Thread, branch, Run, head)`. Renders as CodeMirror ghost text (Tab inserts into draft; Enter sends normally; never enters draft until accepted).
- **Questions & approvals**: Multi-question forms submit atomically on one Operation with drafts isolated per `(Host, Thread, branch, Operation)`. Permission prompts support Allow once / Allow always (persisted rule for extension/MCP tools) / Deny; optional Smart Approval evaluates unmatched extension/MCP calls with tool metadata only (raw values stay on Host).
- **Context panel**: Visualizes model window breakdown (system, user, assistant, tools, MCP, active summary, reserve) computed by Rust from persisted request snapshots + tokenizers, alongside background compaction status and manual trigger/apply/cancel.
- **Composer features**:
  - `/` triggers registered Workbench/skill/harness commands (Tab completes; Enter executes only when entire input is a registered command).
  - `@` attaches files, dirs, attachments, and family tasks scoped to the active Thread's Source.
  - `[Quote N]` / `[Image N]` atomic draggable markers (see [interactive-content.md](interactive-content.md#user-quoting-and-draggable-composer-markers)).
  - **Image annotation**: Shared viewer/editor supporting arrows, shapes, brush, text, numbered callouts, and opaque redaction; composites at original resolution on send/download (redaction burns pixels without attaching raw originals).
  - **Inline images**: Adjacent markdown images group responsively; local files serve via `/api/fs/raw` with Host-generated previews; remote URLs load directly in the browser.

## Text Documents, Buffers & Editors

- **Single text path**: `DocumentsAPI` owns text reads/writes; `FilesAPI` owns browsing/binary/CRUD; `WorkspaceAPI` owns projects/trees/Git/upload. Production disk writes always go through Rust file-resource owners via [Host Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md).
- **Document Registry** ([packages/ui/src/lib/documents/DOCUMENTATION.md](../packages/ui/src/lib/documents/DOCUMENTATION.md)): Per-document external store (high-frequency text stays out of broad Zustand state/localStorage). Normalizes live buffers to LF while preserving disk encoding, BOM, and original EOL. Enforces stale-load fencing, dirty-save isolation, conflict candidates (ancestor + buffer + disk), and workspace-edit transactions (`prepareWorkspaceEdit` with Host recovery barriers and conditional undo).
- **Editor engines**:
  - Desktop/Web: Lazy-loaded [Monaco](../packages/ui/src/lib/monaco/DOCUMENTATION.md) (one model per document instance, shared undo across split views; built-in semantic workers do not duplicate Host LSP).
  - Mobile & small embeds: [CodeMirror](../packages/ui/src/lib/codemirror/DOCUMENTATION.md) (official IDE does not target mobile).
  - [Agent/editor bridge](../packages/ui/src/lib/agent-editor/DOCUMENTATION.md): Captures selections/diffs/diagnostics from visible views only; accepted agent patches land as dirty buffers requiring explicit save.
- **Provider resolution**: Enabled declarations → explicit association → filename/language + priority → text fallback (pinned providers like Git diff/browser never become default).

## Conversation Continuity & Shared Navigation

- **Projection & drafts**: `ThreadProjection` + `ThreadsAPI` project Catalog truth without a second state store; drafts isolate by `(Host, Thread, branch)`. Uncertain submissions freeze `(requestKey, body, attachments, config)` for idempotent retry.
- **Session tree**: Renders branch topology and forks from `runtime.thread.tree` metadata; loads turn previews on demand; supports branch switch, fork ("Continue from here"), and recovery ("Rewind here").
- **Shared conversation organization**: Mixed nested Projects + Folders stored in Catalog per principal, shared across Workbench, IDE, and Varin (each shell keeps its own layout/collapse prefs). Workbench/IDE show ordinary conversations + all delegated tasks; Bot direct conversations stay in Varin mode. Moving containers never moves files on disk or changes a task's Source/delegation tree.

## Settings, Projects, Usage & Storage

- **Settings surface**: Full-canvas overlay under desktop titlebar keeping chat/editors mounted. Organized into Preferences, Models, Agents, Capabilities, Projects, Devices & Network, and Data. Backed by [settings-catalog.ts](../packages/application-client/src/settings-catalog.ts) + [settings-service.ts](../packages/web/application-host/lib/harness/settings-service.ts). Drafted sections use fixed `SettingsActionBar` with navigation/Host-switch guards; CAS conflicts fail explicitly.
- **Projects & cross-device sources**: Stored in Host Settings; `ProjectEntry.source` binds remote resource Host + Documents workspace ID (offline remotes stay listed rather than vanishing). Local projects read trusted `.varin/settings.json`; remote project model defaults store on the coordinating Host keyed by stable `projectId`. Project files, Git worktrees, Native Workspace adoption, project actions, and remote external harnesses all route to the target resource Host without falling back to local paths.
- **Usage dashboard**: Reads `runtime.usage.summary` for the selected Agent Host using client local calendar/DST buckets, breaking down tokens, USD estimates, cache hits, and subscription/local channels, with CSV export on desktop/web.
- **Work Connections & Storage**: Work Connections composes client Host connections, resource Hosts (HTTP/SSH), and desktops without creating a second profile store. Storage settings preview deduplicated disk usage and reclaim candidates by opaque ID on the selected Host (never accepting raw delete paths from clients).
