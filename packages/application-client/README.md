# @varin/application-client

Framework-neutral Varin application client boundary.

## Purpose

This package owns the `RuntimeAPIs` aggregate interface and the API interfaces (Terminal, Git,
Files, Documents, Settings, Permissions, Notifications, Extensions, Language, LanguageSupport, Tasks, Debug, Tests,
etc.), typed failures (`DocumentsError`, `FilesystemError`, `LanguageServicesError`,
`LanguageSupportError`, `RunServicesError`, `WorkspaceSearchError`), pure DTO types (`WorktreeMetadata`,
`DraftStarterRef`, `FileEditorSettingsPatch`, `ThreadResultHistory`), and the single desktop IPC contract (`desktop.ts`).

`thread-history.ts` describes the user-only Thread history list and release response. The Host owns
selection validation and object cleanup; the UI sends a frozen branch/revision selection. Logical bytes
referenced by a version and bytes actually removed by cleanup are distinct fields. These DTOs do not
add an Agent tool or a second state store.

`ThreadsAPI.resume(runId, waitId)` explicitly consumes the displayed policy Pause and returns its
durable receipt. Retrying the same command preserves that receipt and cannot resume a later Pause.
`retryPreparation(runId)` is a separate launch-preparation retry; queueing input is not a resume
command. The UI reads derived `LaunchIntent.startable`/`pause` projections rather than guessing
eligibility from a waiting Run or a Wait ID prefix.

`ThreadsAPI.inspectTools(identity, runId)` queries the authenticated Host for the Run's activated
tool directory, selected provider identities, and per-service preparation state. An extension still
preparing is not callable. Revoked providers are unavailable immediately; a normally retiring provider
can remain callable through its original Run pin. Listing a callable tool does not grant permission:
each actual invocation is authorized against its original operation and current permission policy.

`ThreadsAPI.inspectPolicy` and `ThreadSnapshot.policySelection` separate the committed strategy
generation and desired update from the current Host's preparation status. Preparation is not activation.
`restartPolicy(identity, runId, selectionId)` explicitly restarts only that displayed candidate's private
checkpoint at a closed decision boundary; the candidate ID and active generation are rechecked by
Catalog. Conversation history and independent tasks remain intact. `cancelPolicyUpdate` cancels that
unpublished candidate, not the Run. Neither operation resumes an explicit Pause.

The desktop contract defines:

- `VarinDesktopCommandMap` — typed `{ args, result }` for all 58 `desktop_*` commands
- `VarinDesktopBridge` — the typed bridge interface implemented by Electron preload and consumed by the UI
- `PreloadBootstrapPayload` — discriminated union carrying credentials only for local pages
- `VarinDesktopEventMap` — typed desktop events (update progress, SSH status, menu actions, etc.)
- exhaustive command/event catalogs and runtime guards, plus `VARIN_REMOTE_SAFE_DESKTOP_COMMANDS`

It has no React, Zustand, or UI component dependencies. It depends only on `@varin/protocol` and
`@varin/extension-contract`.

## Consumers

- `packages/web` — Web/remote surface API implementations
- `packages/ui` — shared React presentation and client-side kernels
- `packages/electron` — Electron main/preload import the focused `@varin/application-client/desktop`
  subpath so bundling the native bridge does not pull in unrelated HTTP/relay transport modules

All three product consumers import contracts and transport primitives directly from
`@varin/application-client`; the former UI forwarding modules have been removed. Relay is injected
through `registerRelayTunnelProvider` and `registerRelayTunnelLifecycle`, so this package never imports
the UI tunnel implementation. Selecting Relay without a registered lifecycle fails explicitly.

## URL-auth mint lifetime

`transport/runtime-auth.ts` owns the shared in-flight URL-token mint, including its 10-second
deadline across credential lookup, HTTP/relay fetch and response-body parsing. Concurrent consumers
share that operation; a stalled mint must release its shared promise so a later connection can retry
without restarting the application. Fetch receives the owner's abort signal and late completion is
checked before token publication, even when a transport ignores cancellation. Runtime/origin generation
checks still prevent an old authority from overwriting a new token. Token values are never logged.

The UI connection candidate separately bounds authentication, socket open and handshake as one startup
attempt. A startup timeout means no agent input was dispatched by that candidate; a timeout after a
prompt was sent has different, ambiguous execution semantics. `test/runtime-auth-timeout.test.ts`
exercises a stalled response body, concurrent mint sharing, retry and late-publication rejection.

## History

This package was extracted from the former UI-owned API and transport modules to clarify the boundary
between framework-neutral client behavior and React presentation.
