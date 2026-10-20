# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces selected from the collapsible right icon rail
(`components/layout/ContextPanelRail.tsx`) and rendered by
`components/layout/ContextPanel.tsx`.

## Model

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
- `availability: 'always'` surfaces are always present on the rail when expanded.
  `availability: 'has-content'` surfaces (interactive content, chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- `defaultWidthFraction` is the panel width as a fraction of the content area,
  used until the user manually resizes that surface (manual widths are stored
  per mode in `useUIStore.contextPanelByDirectory[dir].widthByMode`).
- The rail honors the draggable order persisted in `useUIStore.contextRailOrder`;
  `sortContextSurfaces` applies it on top of the registry's default order and
  appends any missing surfaces. `isContextRailOpen` defaults to false and is persisted.

The browser is the web-page surface. Saved project actions can open a configured URL
there; automatic URL opening is scoped to actions explicitly configured for it.
Restored layouts retain supported surfaces and discard retired tabs and rail entries.

## Adding a surface

1. Add a `ContextPanelMode` value in `useUIStore` (type union plus the
   sanitizer whitelist in `sanitizeContextPanelTabs`).
2. Register a descriptor here (icon, label key, availability, width fraction).
3. Render the mode in `ContextPanel.tsx` (content dispatch, label, icon).
4. Add label/hint i18n keys to every locale dictionary.

No per-surface header buttons: the rail and `openContextSurface` are the entry
points for opening surfaces directly; deep links from chat/palette go through
the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, or an in-content link.
- `ContextPanelControls` owns only the icon-rail visibility toggle. In chat, the
  work-overview control row owns the generic workspace-panel toggle so overview and
  panel controls stay adjacent without consuming a second rail. `toggleContextPanel`
  restores the exact last active tab in the current workspace; only an empty workspace
  opens a new file view. Surface icons use `openContextSurface` to select the most recent
  tab of that mode (or close the panel when that mode is already visible).
- Multi-instance and session-holding surfaces (file/editor, chat, diff,
  browser, terminal) are keep-alive panes in `ContextPanel.tsx`: switching
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Singleton surfaces (git, pr, notes, plan, context)
  intentionally remount on switch and must restore themselves from
  their stores/snapshots instead.
- Recovery is a singleton surface. `WorkspaceRecoveryPanel` follows the current workspace and
  selected native Thread/branch. The versioned recovery service owns checkpoints and combined
  file/history operations; the Catalog owns conversation navigation receipts. These are separate
  authorities, and changing the Host or selection retires stale reads.
- Runtime scope: desktop/web `MainLayout` only. The dedicated mobile shell has
  its own layout and does not consume this registry.
