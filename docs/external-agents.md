# External Agents

Varin connects to external CLI/SDK agents running on an execution Host — **Codex**, **Claude Code**, **Pi** (native adapters), and **ACP-compatible** programs (20 product profiles total; full catalog in [profiles.ts](../packages/web/application-host/lib/external-agents/profiles.ts)). External agents keep their own models, accounts, tools, and project configs; Varin provides the conversation UI, workspace binding, attachment delivery, and cross-agent delegation.

## Discovery, Installation & Device Scope

- **Settings & Picker**: Settings lists detected/configured agents per connected Host (local or remote managed Host via Work Connections); "Add Agent" shows the full catalog plus custom ACP entries. The composer picker lists Varin, enabled configs, and auto-detected executables on the active execution Host without triggering model calls.
- **Managed installs**: npm-distributed products install into the target Host's private data dir (using its existing Node/npm/registry); Cursor and Antigravity fetch official ACP distribution bundles. Installs stage into an isolated dir and atomically swap Catalog launch config on success; running/undrained processes pin their program dir against uninstall. Uninstalling removes only Varin-managed binaries, preserving user configs and history.
- **Windows launch**: Default Codex/Claude lookup checks `PATH`, then falls back to unpacked Codex Desktop CLI / native Claude Code user launcher. `.cmd`/`.bat` scripts run via the native process owner with argument boundaries preserved.
- **ACP / Gateway specifics**:
  - ACP file callbacks route through the executing Source's file owner (preserving root scope and version conflicts) and are advertised only when wired.
  - Hermes (`gateway attach --json`) and OpenClaw attach to existing shared gateways; one-time tickets are never persisted/logged and shared gateways stay outside the session's process tree.
  - Authentication always happens via the external program itself on the target Host; Varin never harvests or writes external credentials.

## Composer, Capabilities & Context Display

- **Lazy preparation**: Selecting an external backend and focusing/typing or opening its model/mode menus prepares the connection (pure chat uses a private Host working dir; workspace chat uses the selected Host/dir). Opening a default draft without interaction does not spawn a process. Backend locks once the first input is admitted.
- **Capability cache**: Host caches real model/thinking/mode catalogs per launch config + version for display during preparation, then validates once live; stale cached choices are cleared rather than assumed sendable. Codex/Pi support metadata refresh without restart; Claude requires reconnect.
- **Per-turn overrides**: Model, thinking, mode, and Codex native permission shield choices are durably admitted with the next input and recorded on each reply header. Slash commands from the backend insert into the draft only (never auto-execute).
- **Context & usage**: Context window occupancy (`usage_update`, Codex window usage, Claude/Pi reports) displays when reported, marked as last-recorded on history reopen. Billing usage stays separate from window occupancy.

## Execution, Persistence & Stopping

- **Owners**: [application-client/src/external-agents.ts](../packages/application-client/src/external-agents.ts) (client API) · `packages/web/application-host/lib/external-agents/` (protocol adapters & lifecycle) · Rust Catalog `external_*` tables + ContentStore (bindings, inputs, turns, delegation — never fake native Threads/Runs).
- **Adapter contracts**:
  - **Codex**: `app-server`, matching connection/thread/turn/interaction IDs; supports native `turn/steer` (pinned by `expectedTurnId`).
  - **Claude Code**: Official Agent SDK via Rust-tracked bridge process; requires native `user_message_uuid` + tool-use correlation; uncorrelatable output never merges into the active turn.
  - **Pi**: Independent RPC process (`>=1.5.0 <2.0.0`); final settlement via `agent_settled`.
  - **ACP**: Capability-negotiated (`promptCapabilities.image`, `sessionCapabilities.resume` / `loadSession`, standard options).
- **Durability & Recovery**: Inputs are durably admitted before delivery (idempotent by request key). After crash/disconnect, **Reconnect** restores observation/session while **Continue** explicitly confirms recovery and advances queued inputs — never auto-replaying an already-dispatched turn with unknown side effects.
- **Stop vs Force Stop**: Normal stop revokes pending prompts, sends protocol cancel, and waits for confirmation. **Force Stop** terminates the Rust-tracked process tree and marks the turn interrupted/unconfirmed without claiming rollback.
- **Observation**: Authenticated SSE over the shared observation mux; snapshots on connect/resync, deltas in-memory, persisted at item/turn/disconnect boundaries.
- **Idle reclamation**: With zero active observers, idle prepared sessions reclaim after ~5 min and started sessions after ~15 min (blocked by active turns, pending interactions, queues, or reported background subtasks; skipped if backend lacks native resume). Reclamation stops only the process, preserving bindings and history.

## Delegation, Cross-Session Messaging & Steering

- **Free dispatch**: `dispatch` accepts `executor` aliases (e.g. `"codex"`) or `exec:` refs from `executors` (`list`/`inspect`/`detect`) without requiring a preset. `executorOptions` passes explicit `model`/`thinking`/`mode`/`config` (precedence: call → preset → config default → CLI default).
- **Host matching**: File source and executor must reside on the same execution Host (auto-provisioning a private dir on a remote Host without a selected source is not yet wired).
- **Cross-session access**: `threads` and `read_thread` read Catalog-persisted turns/items/attachments without reconnecting the CLI. `send` accepts any accessible external conversation ID (`inform` queues passively; `request` steers an active Codex turn or queues next turn; `wait` awaits that turn's report without gaining cancel authority over the whole session).
- **In-turn steering status**:
  - **Codex**: Live `turn/steer` wired; tracks durable admission → dispatching → native append (`consumedByTurnId`).
  - **Pi / Claude / ACP**: Next-turn queue in product UI (Pi's `steer` lacks input-ID correlation; Claude's `priority: "next"` cross-turn correlation is not yet wired).
- **Bot schedules & events**: Bot event watches and source-object links can target an existing external conversation (active events create durable external turns; passive events attach as `awaiting_input` on next real turn).

## Attachments, Sources & Current Limits

- **Attachments**: Prepared and durably retained before admission. Supported images use native image blocks; other files materialize read-only paths on the execution Host (or ACP `resource_link`). Missing capability fails explicitly without fabricating text summaries.
- **Sources & code exchange**: Default is shared live directory. `isolated_write` uses Native Workspace fork/mount + three-way Integration merge (`read_only` sandbox is not claimed for external CLIs and rejects before dispatch).
- **Current limits**: Exposing Varin's CLI/Skills/MCP to external harnesses is deferred; importing pre-existing external CLI history or attaching to outside terminals is not supported.
- **Brand identity**: `HarnessIcon` resolves by Catalog `configurationId` + `harness` (never title/avatar guessing). Assets in [harness-logos](../packages/ui/src/assets/harness-logos/README.md).
