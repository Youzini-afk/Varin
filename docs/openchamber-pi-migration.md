# OpenChamber-to-Pi migration contract

## Authoritative source and workspace boundary

Varin adopts the maintainer's OpenChamber fork, not a pristine upstream checkout:

- repository: `https://github.com/Youzini-afk/openchamber`;
- original reviewed fork baseline: `f551150e57de87858383dd62f45462189adf4125`;
- reviewed upstream tip: `dea3826f8759e503465a9a9ac5614f4d54caa1b0`;
- reviewed fork/upstream reconciliation: `24379cc84b2818a61f62301fa83c82a24d17986a`
  on `sync/upstream-20260813`;
- the reconciliation is an audit source, not a replacement engine: Varin adopts its behavior through
  the capability ledger below and does not restore OpenCode contracts;
- copied OpenChamber material remains subject to its MIT license and copyright notice.

Every OpenChamber source worktree is read-only for this project. Imports are produced from the
specified commit tree; all copies, deletions, rewrites, branches, commits, and pushes happen only in
this repository. Tracked `.env`, tool-specific agent directories, stale CI/release
identity, and OpenChamber/OpenCode branding are not blindly copied into release artifacts.

## Non-regression contract

The following fork capabilities are product requirements, not incidental patches:

- custom provider configuration, model discovery, API-key and OAuth flows;
- remote/cloud connection, pairing, relay, notifications, tray behavior, and client permissions;
- workspace files, Git, terminal containment, external-access auditing, and allowed directories;
- session queues, delayed child-session materialization, parent/subagent visibility, archive restore,
  revert/fork/timeline, and workspace checkpoints;
- Magic Context, orchestration/OpenAgent surfaces, voice settings, and extension management;
- Electron, web/PWA, mobile, and VS Code surfaces where the fork supports them.

An upstream or Pi implementation may replace a fork implementation only after focused review shows
equivalent user behavior, persistence, security boundaries, platform support, and tests. Partial
equivalence is supplemented; a materially divergent implementation is not adopted.

The current upstream review and per-capability disposition are recorded in
[openchamber-upstream-20260813.md](archive/openchamber-upstream-20260813.md). This keeps the Git conflict
resolution, the product decision, and the Pi-native implementation as three separately reviewable
steps.

## Direct Pi-native refactor

The imported OpenChamber baseline exposed platform capabilities through `RuntimeAPIs`, while its conversation
sync, server lifecycle, session features, provider pages, scheduled tasks, and control service use
OpenCode SDK/HTTP types directly. Varin does not preserve those contracts as a second permanent
layer. Inside the copied Varin tree the migration:

1. defined one canonical set of Varin-owned Pi domain types;
2. rewrote session/message/event synchronization and UI stores to consume those types;
3. rewrote provider/model/auth, agent, command, tool, permission, question, scheduling, and control
   flows against the existing Pi host protocol;
4. retained the fork's platform and product services while changing their engine data source;
5. deleted OpenCode lifecycle/proxy/watcher/configuration/downloaded CLI and dead SDK-dependent code;
6. removed `@opencode-ai/sdk` after the last real consumer was migrated.

There is one runtime boundary between trusted application services and isolated Pi workers. There
is no OpenCode-shaped compatibility server layered on top of another Pi adapter.

Recovery attaches directly to Pi timeline entries. A user-message rollback targets the stable Pi
entry ID, restores that prompt into the Varin composer, and coordinates file restoration through
the selected `varin.workspace-recovery@5` Host service. The default policy is conversation only,
conversation + files, or always ask; detailed native recovery management lives in the right sidebar
and settings. `pi-workspace-history` and `pi-wtf` remain optional Pi packages with independent
commands and native configuration; they are not installed or invoked by this recovery path.

The primary Web/Desktop layout now reads the Pi catalog and Pi branch entries directly. Its
session tree, search, project grouping, streaming assistant state, tool executions, image prompts,
steering/follow-up queue, abort, rename, archive, restore, delete, and message rollback do not
project Pi data into OpenCode `Session`, `Message`, or `Part` objects. No production UI root imports
the former OpenCode client or sync graph. The old chat/composer/turn/sidebar closure, SDK-only test
fixtures, Vite aliases, and package dependency were deleted instead of being renamed into a
Varin-shaped compatibility layer.

Terminal, Git, pull-request, and embedded context-panel flows now use Pi session identity and cwd
directly. Context captured from terminal selections, PR comments/checks, merge conflicts, and
worktree integration is staged in a session-scoped Pi composer draft. When no session exists, the
same flow creates one in the relevant directory before attaching the context. Hidden workflow
instructions are submitted through Pi's native `instructions` field rather than projected
OpenCode synthetic parts. Git worktree discovery and bootstrap status no longer mutate the legacy
session UI store.

## Pi-native session features

Protocol version 1 owns Goal, Assist, parent-session creation, and scoped Pi package lifecycle operations
as Varin's native runtime ABI. Goal and Assist use `PiSessionFeatureState`. The Pi
host persists each change as a versioned, append-only custom entry in the session JSONL and reads
the newest state visible from the active branch. Feature state is therefore branch-aware, travels
with the Pi session, and does not depend on OpenCode metadata, sidecar goal files, or projected
messages. A goal records its native cumulative token baseline so budget accounting remains stable
across restarts and compaction.

The host installs a hidden Pi extension for the Goal behavior. `before_agent_start` adds an active
goal's objective to the effective system prompt. Bookkeeping entries never enter model context or the
visible timeline. Varin deliberately does not retain a message-pin/context hook: compaction, memory,
and context reinjection remain owned by Pi and its installed packages.

The Web/Desktop server subscribes to the Pi runtime broker and implements one event-driven
automation loop. It audits quiet goal turns, persists progress before continuing, stops on errors,
aborts, token budgets, audit failures, or turn limits, and requires three consecutive blocked
verdicts before accepting a blocked outcome. Assist generation runs only after a settled latest
exchange. Scheduled tasks start a goal through the same protocol mutation, and completion
notifications are emitted from the settled goal result instead of from generic intermediate turns.
The former OpenCode-shaped `session-goal`, `session-assist`, `context-obligatory`, and
`permission-auto-accept` server implementations are deleted.

Pi executes tools through its extension runtime rather than OpenCode's permission-request stream.
Varin therefore does not add an automatic approval policy for unrelated extension confirmation
UIs. Individual tools and packages keep their own explicit safety and confirmation behavior; if a
future Pi permission contract is introduced, it must be integrated as a Pi-native capability with
an independently reviewable policy.

## Pi agents, commands, prompts, and skills

Agents are a catalog, not a second universal configuration format. Varin includes fallback
adapters for `pi-subagents` and Magic Context, and exposes the versioned
`varin.agent-provider.discover/v1` event contract so any loaded Pi extension can register its own
provider. A provider-owned bridge takes precedence over Varin's fallback adapter with the same
ID. Provider-specific configuration remains authoritative and opens the matching GUI adapter when
one exists; otherwise Varin opens the native JSON/JSONC editor without projecting the plugin into
a reduced common schema.

Commands are the live slash-command catalog of the current Pi session or workspace. The host
combines extension commands, native `.md` prompt templates, and active skills; the settings page is
therefore read-only discovery and explanation, while invocation stays in chat. Prompts and skills
are managed through Pi's resource loader and their native roots. Varin preserves loader ownership,
collision diagnostics, read-only package resources, complete skill directories, and project trust
instead of restoring the former OpenCode command/skill stores.

Pi Packages delegates install, update, removal, source normalization, and session reload to Pi's
native package manager. The UI exposes both user and project scopes, reports the installed manifest
version when available, and keeps local working copies linked instead of copying them. Local sources
are not presented as remotely updatable; their removal uses Pi's resolved package path so a
project-relative entry is removed from the same settings scope that created it.

## Mobile and embedded session surfaces

The dedicated mobile application and the context-panel iframe now mount the same `PiChatView`, Pi
interaction host, and endpoint-aware session store as the primary desktop surface. Neither root
creates an OpenCode `SyncProvider`. Mobile session grouping, parent/child expansion, search, pin
ordering, create/open/archive, edge-swipe navigation, deep links, widget snapshots, and worktree
deletion all operate on `SessionSummary` and Pi runtime methods. The worktree creation flow creates
Pi sessions directly and submits linked GitHub issue or pull-request context through Pi's native
prompt/instructions contract. Mobile widget completion/error badges read Pi session attention state;
they no longer read the legacy OpenCode notification index.

The iframe URL ABI is Varin-owned: `piPanel`, `piSessionId`, `piDirectory`, and `piReadOnly`.
Legacy `ocPanel`/OpenCode-shaped aliases are deliberately not accepted. The parent still supplies
the authenticated runtime bootstrap through the same-origin message handshake, while the child
opens the target Pi session directly and keeps in-panel navigation stable.

## Server event and notification transport

The Web server no longer opens or exposes OpenCode `/event` or `/global/event` streams. Their SSE
readers, WebSocket bridges, replay hub, proxy/auth/relay allowlist entries, and orphaned
OpenCode-session notification trigger/template runtimes are removed. Pi session notifications are
derived from runtime-broker `session.snapshot` and `agent.event` envelopes. Renderer-owned attention
for background completion and failure is derived from the same routed events, is cleared on view,
and is the single input for Pi session lists and mobile widget snapshots.

The remaining transports have separate product ownership: `/api/varin/runtime/ws` carries the Pi
runtime protocol, `/api/varin/events` carries scheduled-task events, and
`/api/notifications/stream` carries UI notifications. Desktop relay proxying explicitly permits
those Pi-native endpoints and does not retain an OpenCode event alias.
