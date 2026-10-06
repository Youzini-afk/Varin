# Editor Workbench Kernel

Shared editor groups, resource providers, commands, context keys, and panel model. Shells mount
this kernel; they do not own document buffers, disk revisions, or layout schema.

- `groups.ts` — split tree, tabs, preview/pinned, move, close. Moving the last tab out of a group
  collapses that group.
- `snapshot.ts` — workspace-scoped v2 restore: missing, empty, malformed, failure, ready; v1 cursor/
  selection/scroll/fold fields migrate once into provider-owned state
- `persist.ts` — runtime+workspace local snapshot, 400ms structural debounce, pagehide/freeze flush,
  in-memory last-good. Cursor/scroll patches update last-good without scheduling a write.
- `session.ts` — Map by workspaceId. `peekEditorWorkbench` never creates. Persist failure/malformed
  keeps last-good and does not write empty over the failed snapshot. Runtime switch resets the map.
- `providers.ts` — enabled provider selection, user association, text fallback, and disable without
  background work. A provider that declares no languages, filenames, or fallback is never selected
  by resolution and is reachable only through an explicit request.
- `commands.ts` / `context-keys.ts` / `menus.ts` — owner-scoped commands, per-key context subscribe,
  `when` menu projection. The Monaco command service adapts the focused editor into these contracts;
  the user-facing command catalog remains the Varin surface-command registry.
- `panels.ts` — terminal/problems/output container; empty is distinct from failure
- `view-state-core.ts` — framework-neutral provider ID/schema/JSON state and selection summary
- `view-state.ts` — mobile/embedded CodeMirror capture and restore; desktop/Web Monaco owns its payload

High-frequency cursor/scroll state stays on the tab `viewState` in memory. Snapshots are explicit,
not per keystroke. Document dirty buffers remain in the Document Registry.

`subscribeEditorViewState` serves cursor/status projections without invalidating the entire layout.
Explicit display choices such as `diffLayout` notify layout subscribers and schedule the existing
snapshot writer. Diff automatic mode uses the actual Monaco editor width; manual inline/split choices
stay on the tab. The status bar reads the active editor's real cursor, language metadata and indentation,
plus Document Registry encoding/line endings; binary/browser views do not invent text-editor metadata.

Passing an explicit `providerId` to `openWorkbenchEditor` pins it: the tab records `providerPinned`
and the host stops re-resolving that tab, so the caller's choice is not replaced by the resource's
default on the next render. A pinned tab is a distinct view of the resource, so one file can be open
as text and as a Git diff at the same time; pinned opens only reuse the same pinned provider and
ordinary opens never focus a pinned tab. A pinned provider still yields to being disabled, which is
an authoritative unavailable state rather than a silent substitution.

`varin.builtin.git-diff` renders the working-tree or staged diff for a tracked file and is the
IDE's target for Git diff requests. It declares no languages and no fallback, so resolution never
selects it. Its `viewState.diffScope` carries `working` or `staged`; `diffRepositoryResourceId` keeps
the selected nested Git root relative to the outer workspace, and both persist with the tab. The
working side is the live document buffer, while the staged side and original side are immutable
snapshots. Stage, unstage, and discard refuse to race a dirty editor buffer.

The IDE Workbench's secondary sidebar hosts the Agent session only. Notes and todos stay with the
Agent profile, and Git diffs open here in the editor area, so the retired `context` secondary view
migrates to `session` while extension-contributed secondary views are preserved.

The Agent Files surface and the official IDE Workbench both mount this kernel. `FilesView` is now
only a composition of `SidebarFilesTree` and `EditorWorkbenchArea`; it owns no second document or
tab model. `useFilesExplorerStore` persists expanded directories and performs a one-time migration
of legacy open paths into Editor Workbench.

Adjacent material views share the same tab/view state. PDF reading location is provider state;
Markdown preview scroll, browser URL/available scroll, and diff layout are view state. The browser
provider is explicitly requested and declares no text fallback or filesystem language association.

Desktop/Web official text tabs project the Document Registry into a shared Monaco model. Tab owners
survive Shell/Profile remounts; visible views own only Monaco editor DOM, layout, language subscriptions,
and decorations. Mobile keeps the document-bound CodeMirror adapter.

Workbench Profile context supplies presentation defaults only. Agent uses a compact editor surface and
IDE enables the full minimap/sticky-scroll presentation, while validated user settings override both.
Profile changes update live options and never create a second buffer, dirty flag, save path, or undo stack.

The official IDE layout is a versioned split/stack/editor-area document stored by the
`varin.workbench.layout` v1 Host service in profile/workspace-scoped extension storage. Missing
and empty documents use the distribution default without writing it; malformed/read failures keep
the last valid in-memory document and surface a diagnostic instead of replacing Host state.

The IDE offers region navigation from allocated content width and temporary reading focus. Focus
changes visible placement only; returning restores the saved visibility and split weights. A resize
keeps the adjacent weight sum, including direction reversal at an edge, and separators accept keyboard
input. Window resizing never silently closes a user-selected column. Agent material surfaces use
content-specific initial widths; a manual resize takes precedence over these initial preferences.

Language diagnostics publish into the Problems panel through the language-services registry.
Stale diagnostic versions are dropped. Hidden search views do not start language servers.

Run, debug, and test live in `lib/run-debug`. The Application Host owns DAP adapters, test
providers, and task processes; renderers never start a debugger. `acquireRunDebugView` opens
SSE subscriptions only while a Run view is visible. Hidden views drop those listeners and
do not keep refreshing. Agent attachments may cite a test failure or stack frame as prompt
text; they never grant process, debug, or test-runner capability.

Agent/editor coordination lives in `lib/agent-editor`: attachments are runtime+session scoped,
unsaved snapshots are explicit prompt text, tool path hints never override DocumentsAPI watches,
and patch accept/reject uses a revision-checked Document Registry transaction. Active-editor context
is selected by visible view ownership; a disposed or hidden integration cannot become an arbitrary
fallback command/context target.
