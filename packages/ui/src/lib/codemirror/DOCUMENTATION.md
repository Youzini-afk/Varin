# CodeMirror boundary

CodeMirror is a purpose-specific mobile and embedded editor dependency. It is not a fallback for the
desktop/Web Workbench file editor.

Retained consumers:

- `DocumentCodeMirror` projects a `DocumentRegistry` record into the official mobile file editor and
  embedded workspace editors such as Plan. It submits offset edits against the revision actually
  projected into the view; the registry remains the buffer, dirty, conflict, recovery, and save
  authority.
- `language-client.ts` adapts the applicable diagnostics, completion, and hover subset of the shared
  Host language DTO for those document-bound views. It does not start or own a language server.
- `languageByExtension.ts`, `flexokiTheme.ts`, and `shikiHighlight.ts` support Plan, resource drafts, and
  embedded editor presentation. They do not participate in desktop/Web Monaco model or language ownership.
- `CodeMirrorEditor` remains the lightweight editor for MCP/configuration/resource drafts and other
  focused embedded fields that are not Workbench file tabs.
- `workbench/editors/view-state.ts` is the mobile/embedded CodeMirror view-state adapter. Desktop/Web
  Monaco persists its own provider payload.

Do not add desktop Monaco-failure branches here. A Monaco failure is a local official-provider failure
with retry/recovery; it does not revive a second file editor implementation.
