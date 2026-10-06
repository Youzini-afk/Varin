# Agent / editor coordination

Shared Workbench Kernel for Agent context attachments, tool file-change hints, patch
review, and session↔editor navigation. Document buffers and disk revisions stay in the
Document Registry / DocumentsAPI.

- `attachments.ts` — runtime+session scoped attachment list; consume-on-send
- `projection.ts` — saved vs unsaved prompt text; unsaved snapshots are not claimed as disk
- `hints.ts` — tool path hints only; file watch events remain authoritative
- `patch.ts` / `document-write.ts` — hunk apply/revert with expected revision; dirty buffers never overwritten
- `merge.ts` — three-way ancestor/ours/theirs regions
- `navigation.ts` — last session entry linked to a resource
- `material-navigation.ts` — move the selected material view between the adjacent Agent surface and
  the IDE through the authoritative Workbench Profile selector; return to the originating profile

Adjacent file views bind to an existing Editor Workbench `viewId`. Continuing in IDE pins that view;
returning opens the same resource/view beside the current conversation. Neither action copies a
document buffer, accepts a proposal, saves an editor, or changes the active Pi session. Quote actions
use the existing attachment projection, so unsaved content keeps its explicit unsaved identity.

PDF reading position (page, scale, view, snapshot and source hash) is provider state on that same tab
and is session scoped. Markdown preview scroll is tab view state. Browser materials use the existing
desktop webview or Web iframe through a shared viewer. Explicit movement captures only URL and
available scroll coordinates; there is no periodic capture. Cross-origin iframe restrictions remain
in force, and page forms, browser history and application state are not copied across viewer mounts.

Do not copy Pi plugin private history. Do not log attachment or document text.
