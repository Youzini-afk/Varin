# Monaco runtime foundation

The official desktop/Web file editor loads Monaco through this directory. Importing these modules
must not make Monaco eager: `runtime.ts` owns one lazy runtime promise and installs one editor-worker
factory only when `loadMonacoRuntime()` is called.

- `runtime.ts` imports `monaco-editor/editor`, editor features, and lazy basic-language definitions
  through public 0.56 entrypoints.
  It rejects non-editor worker labels so Monaco's TS/JS/JSON/CSS/HTML language services cannot become
  a second language authority beside the Application Host.
- `theme.ts` projects Varin semantic theme tokens into Monaco. It owns no theme preference.
- `editor-options.ts` projects the active Workbench Profile and validated user settings. `default`
  uses `agent-compact`; `varin.ide` uses `ide-full`; user settings override either without replacing
  the model.
- `editor-command-service.ts` tracks the focused view and projects one command table into Varin
  commands, workbench menus/context keys, toolbar actions, and user shortcut overrides. It exposes no
  raw editor/model handle.
- `model-registry.ts` projects one Document Registry record into one Monaco model. Workbench tabs own
  models; React views only own layout/listeners. The model URI contains a runtime key and internal
  document instance ID, never a workspace path.
- `diff-model-registry.ts` owns reference-counted immutable snapshot models. File diffs keep the
  original/staged side immutable, while a working side reuses the live Document Registry model so
  unsaved edits, language features, editor commands, Agent context, and debug decorations stay aligned.
  `MonacoFileDiffEditor` detaches its binding before releasing either model lease or disposing the widget.
  The same idempotent teardown captures view state and removes listeners, regardless of React effect
  cleanup order; changing a workbench or diff revision never leaves the widget bound to a disposed model.
- `language-bridge.ts` keeps the existing Host language service authoritative. It projects generation-
  scoped diagnostics and rich language features, including rename and code actions. Cross-file edits go
  through the Document Registry preview/transaction path, completion additional edits stay in Monaco's
  single-model transaction, and server commands return to the Host only after document sync. Monaco's
  built-in semantic workers remain disabled.
- `run-debug-editor-adapter.ts` projects workspace-scoped breakpoint, current-frame, and latest-test-
  failure state into glyph and line decorations. Gutter clicks send the clicked line through the typed
  debug authority with the current session owner; debug and test projections reject stale owner
  generations, and disposing the view removes its listener and decorations.
- `view-state.ts` owns the v2 Monaco payload and a framework-neutral cursor/selection summary.
- `vim-adapter.ts` consumes the persisted Vim setting through Monaco 0.56 public APIs. It deliberately
  does not import `monaco-vim` private `vs/*` modules; mode cursors, counted motions/edits, search,
  save, composition handling, dispose, and re-enable remain a behavior adapter, never document state.
- `performance.ts` emits privacy-safe marks for runtime import, worker creation, model readiness, and
  first paint.
- `fixture.ts` is used by the conditional Web/Electron smoke entry. It is not the production file
  adapter. It records Monaco cold/warm view timing and model ownership on a 50,000-line
  diagnostic sample, not an editor file-size or line-count limit. The former CodeMirror comparison is retired.

Do not import the `monaco-editor` root entrypoint, `editor.main`, or
`monaco-editor/languages/features/*`. Language definitions used for tokenization are distinct from
language features; semantic language capability remains behind `RuntimeAPIs.language`.

Agent collaboration consumes the same visible view owner as editor commands. Selection/file/diff
attachments carry runtime, workspace, document-instance, and session identity; inline comments remain
session drafts; patch review applies an atomic Document Registry workspace edit and leaves a dirty
buffer for explicit save. No collaboration path writes around the registry or exposes a Monaco handle.
