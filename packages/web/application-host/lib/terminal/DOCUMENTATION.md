# Terminal Subsystem

## Ownership

`runtime.ts` owns terminal identity, status projections, ordered display, bounded scrollback, WebSocket attachments and lifecycle routes. Rust owns actual PTY/process trees, raw byte offsets, input receipts and writer lifetime; `KernelProcessService.ptyProvider` is the production backend. Programmatic `createTerminalSession` / `attachTerminalSession` / `inspectSession` are the same authority used by HTTP and WebSocket. Harness background shells create sessions with `owner: 'harness'` and `retainWhenDetached: true`; the runtime allocates their process-wide `sh_N` ids. HTTP create ignores client `owner` / `spawn` / retain flags and cannot reuse a programmatic Harness identity. Closing a retained session detaches viewers and leaves the process running. `shells.ts` discovers executable shell families and resolves the persisted shell ID without accepting command strings or arguments. Clients own tab arrangement and choose stable terminal IDs. Electron uses this same runtime in-process.

## Protocol

`/api/terminal/ws` is the only terminal data transport. It uses v3 binary JSON control frames and is opened through `openRuntimeWebSocket`, preserving direct, Electron proxy, URL-token authentication, and private-relay routing.

- `attach` registers a connection for one terminal. One socket may attach to many terminals.
- Every attach and reconnect begins with an authoritative `snapshot` containing bounded history and the current sequence.
- `output`, `exit`, and `restarted` carry monotonically increasing per-terminal sequences. Output carries raw live bytes plus replay-safe bytes with terminal query exchanges removed.
- Attach registers before capturing the snapshot, buffers concurrent events, drops events represented by the snapshot sequence, then enters live delivery.
- `write` always includes the terminal ID; sockets never have mutable single-terminal binding state.
- `detach` removes only that attachment.
- Creation carries the active UI appearance. The PTY sets `COLORFGBG` and answers OSC 10, OSC 11, and Mode 2031 queries immediately, including queries emitted before a WebSocket attachment exists. Subscribed TUIs receive a Mode 2031 notification when the appearance changes.

HTTP remains the authenticated command plane for create, resize, appearance updates, restart, close, and force-kill. There is no SSE output or HTTP input compatibility path.

## PTY Lifecycle

- User IDs are client-provided or generated with `randomUUID()`; Harness IDs are allocated by the runtime and returned to the caller.
- Concurrent creates for one ID are single-flight only when the complete creation identity matches: owner, HTTP/programmatic source, working directory, shell/spawn, login, writer registration, and retain behavior. An exited ID cannot be reused until it is explicitly closed.
- Dimensions are bounded to 1-1000 columns and 1-500 rows; input is capped at 64 KiB.
- PTY children explicitly clear `NODE_CHANNEL_FD`; daemon IPC descriptors are host-private and invalid after PTY descriptor cleanup.
- `GET /api/terminal/shells` reports shell IDs available on the active server using the same augmented PATH provided to spawned PTYs, plus whether each executable has a supported login-mode argument. `auto` preserves environment/platform fallback order; an explicit unavailable shell fails creation instead of silently running a different shell. Login mode is opt-in and uses only built-in arguments for known shells. Preference changes affect new sessions and explicit restarts, not running PTYs.
- PTY data and exit callbacks enter one FIFO queue. Stale callbacks from replaced processes are ignored.
- Scrollback is retained on the server and capped at 512 KiB with UTF-8-safe trimming. Device-status, device-attribute, cursor-position reply, color-query, and OSC 133/633 shell-integration exchanges are removed from replay history with incomplete control sequences carried across PTY chunks; live output remains byte-for-byte unchanged.
- User sessions inject a Varin-owned OSC 633 script for bash, PowerShell, and zsh. Command text, cwd, and exit codes come only from those sequences. A finished sequence without command text is dropped; PTY process exit is never turned into a command. Harness `spawn` sessions are not injected and their output is not parsed. `inspectSession.integration` is `ready` after the first observed sequence, otherwise `not-observed`. `subscribeCommands` is the Host observation API. PowerShell compares `LASTEXITCODE` with the command-start value; an unchanged nonzero value cannot be attributed to the new command and falls back to exit 1. zsh sources user startup files with the original `ZDOTDIR` semantics, then restores the Varin injection directory; zsh is not claimed as live-tested here.
- Exited sessions remain attachable until explicit close or idle cleanup.
- Restarts are serialized per terminal. Each restart spawns and wires the replacement before terminating the old process, retaining the terminal ID.
- Close uses SIGTERM with bounded SIGKILL escalation. Harness kill/close and explicit force-kill wait for a real PTY exit and process-writer release before evicting the session; failure leaves the same identity observable and retryable. Idle cleanup and shutdown request native tree termination; unconfirmed exits retain the same process/session and report failure. Attached terminals are not considered idle.

## Security And Relay

The WebSocket path must remain in both `isUrlAuthWebSocketPath` and relay `ALLOWED_WS_PATHS`. The client must use `getRuntimeUrlResolver().websocket()` and `openRuntimeWebSocket`; direct local URLs or raw browser WebSockets break relay and URL-token authentication.

## Verification

Run:

```sh
node node_modules/vitest/vitest.mjs run packages/web/application-host/lib/terminal/runtime.test.ts packages/web/application-host/lib/terminal/terminal-ws-protocol.test.ts
bun run test:kernel
```

## Authority loss

Rejected native completion projects `status: error` / `PROCESS_UNAVAILABLE`, not `exit`.
Programmatic `onError` / `waitForExit` report the same failure. Harness work fails explicitly while
its command writer stays retained. Reconnect sees the error in the snapshot. Unknown exit codes
never become zero; an uncertain launch never falls back to another interpreter. Shutdown stops new
admissions, drains pending creates, retains failed owners and closes transports without clearing the
session map before native receipts. See [process ownership](../process/DOCUMENTATION.md).
