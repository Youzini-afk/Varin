# Phase 2 desktop implementation

Phase 2 delivers the first usable Varin desktop shell. It is intentionally Pi-native: every live
session is backed by an isolated Pi SDK worker, not a terminal transcript parser or an OpenCode
compatibility layer.

## Process and security boundary

- Electron `43.2.0` runs with `contextIsolation`, renderer sandbox, web security, and no renderer
  Node integration.
- Production renderer assets use the secure, standard `varin://app` scheme rather than
  `file://`.
- The preload exposes named capabilities only. Renderer code never receives raw Electron IPC,
  filesystem, process, or shell APIs.
- Main-process IPC validates the sender/main frame and bounds structured values and image payloads.
- New windows, unapproved navigation, webviews, and ambient Chromium permissions are denied.
- Package install, update, and removal cross an explicit native confirmation boundary because Pi
  extensions execute as the current user.
- Project-local Pi resources cross a native trust prompt before they are loaded.
- A single-instance lock prevents two desktop brokers from accidentally managing the same live
  application state.

## Runtime broker

The broker starts the compiled Pi host with Electron's Node runtime (`ELECTRON_RUN_AS_NODE=1`) over
a private IPC stdio pipe. One worker owns each opened top-level session. A separate catalog worker
lists persisted sessions without replacing a live session. Requests have timeouts, event sequence
checks, bounded shutdown, and a force-kill fallback.

Normal close and application quit dispose Pi SDK state before terminating workers. Unexpected exit
is projected to the renderer as an offline session state; the persisted Pi session remains
reopenable.

## User interface

The React renderer provides:

- project onboarding, recent projects, session creation/opening, and live session switching;
- persisted and streaming user/assistant messages, thinking, tool calls/results, custom entries,
  compaction/retry/queue state, and stable entry actions;
- prompt/follow-up, abort, fork, and tree navigation;
- provider authentication, model selection, Pi settings, package management, commands, and runtime
  diagnostics;
- generic extension select/confirm/input/editor requests, notifications, status text, widgets,
  title, and editor-text updates.

TUI-only custom components retain a generic fallback rather than executing terminal UI inside the
renderer.

## Verification

The automated boundary covers:

- renderer timeline normalization and stable entry IDs;
- IPC payload bounds and the static Electron security contract;
- a deterministic fake-provider prompt that streams, settles, and forks;
- generic extension loading and interactive UI round trips;
- compiled host stdio startup/shutdown;
- compiled runtime-broker session/configuration integration against real Pi `0.84.1`;
- a real Electron → preload → main → Pi-worker smoke journey, including a sustained active-session
  renderer state and clean shutdown.

An actual provider credential is deliberately not required by CI. Provider-specific network
streaming remains a manual acceptance check because it would otherwise require secrets and a
billable external service.

Phase 3 owns durable conversation/workspace recovery, leases, destructive transaction handling,
and crash injection. Phase 4 owns first-class extension-specific panels; Phase 2 already preserves
their generic Pi UI and command behavior.
