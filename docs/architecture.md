# Varin architecture

Status: current system overview — implementation details belong to the linked module documents.
Last updated: 2026-10-06

Varin is an Agent workspace and harness built around the stable Pi SDK. Pi owns the Agent loop,
model/provider integration and native conversation history. Varin owns the workbench, tool environment,
task coordination, retrieval, working state and recovery. The source originated from the maintainer's
OpenChamber fork; the former OpenCode runtime and VS Code companion are not current product surfaces.

This page answers **where things run, who owns state, and how a request crosses those boundaries**.
[Status](status.md) records delivery limits; [designs](design/README.md) explain domain decisions;
[development](development.md) maps a change to code and verification. The previous, migration-heavy
architecture is retained as a [historical snapshot](archive/architecture-2026-10-06.md).

## Process model

```text
React workbench — Agent / IDE / Research / Bot shell selected by Workbench Profile
    |
    | authenticated HTTP + SSE: documents, search, language, tasks, settings
    | authenticated Varin v1 surface protocol: Pi session interaction
    v
Application Host — Web server, also hosted in-process by Electron
    |
    +-- TypeScript product services: admission, Thread/Run, Documents, recovery coordination
    +-- Varin extension host: privileged extension capabilities
    +-- Pi runtime broker
    |     +-- catalog worker: discovery
    |     +-- Pi session workers: AgentSession, providers, native history, Pi extensions
    |     `-- internal compaction workers: frozen history and scoped read-only queries
    +-- knowledge storage process: TriviumDB, durable knowledge and plans
    +-- semantic storage process: derived vectors and index generations
    `-- private Rust kernel: files, immutable working state, processes, search/structure compute
```

Electron adds windows, menus, native dialogs, notifications and updating through its preload boundary.
It does not add a second application backend. Browser, Electron and mobile clients use the same trusted
Host services; connecting to a remote Host changes placement, not ownership. See
[Electron](../packages/electron/README.md), [Web Host](../packages/web/README.md),
[mobile](../packages/mobile/README.md), and [kernel integration](../packages/web/application-host/lib/kernel/DOCUMENTATION.md).

## Authority map

| State or operation | Authoritative owner | Implementation reference |
| --- | --- | --- |
| Native conversations, branches, provider/model state and Pi resources | Selected Pi SDK in a session worker | [Pi host](../packages/pi-host/src/session-host.ts) |
| Worker lifecycle, request routing and session metadata | Runtime broker | [Broker](../packages/runtime-broker/src/runtime-broker.ts) |
| Task relationships, Runs, messages, waits and code-transfer coordination | Application Host harness | [Harness services](../packages/web/application-host/lib/harness/DOCUMENTATION.md) |
| Immutable work branches, file objects, recovery transactions and managed processes | Rust kernel | [Kernel](../kernel/README.md) |
| Open documents, save coordination and admitted file mutations | Host Documents authority; client Document Registry projects it | [Host Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md), [client registry](../packages/ui/src/lib/documents/DOCUMENTATION.md) |
| Plans, observations, symbol graph and Bot/user knowledge | Host domain services and private TriviumDB storage owner | [Knowledge](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md), [memory](../packages/web/application-host/lib/memory/DOCUMENTATION.md) |
| Ordinary Agent notes and scoped prompt edits | Host personalization service and Rust typed record | [Memory ownership](../packages/web/application-host/lib/memory/DOCUMENTATION.md) |
| Semantic indexes and vector generations | Derived semantic storage, keyed by resource/content/model identity | [Semantic indexing](../packages/web/application-host/lib/knowledge/semantic/DOCUMENTATION.md) |
| Workbench shell, panels, editor groups and view state | Shared UI kernel and selected shell extension | [UI](../packages/ui/DOCUMENTATION.md), [editor workbench](../packages/ui/src/lib/workbench/editors/DOCUMENTATION.md) |
| Public client contracts and transport DTOs | Framework-neutral application-client and protocol packages | [Runtime APIs](../packages/application-client/README.md), [wire protocol](../packages/protocol/README.md) |

A project groups work for navigation. It is not interchangeable with a task scope, a Pi session's cwd,
a resource root, an execution target or an index. Paths are fixed at operation admission using the
session cwd and authorized resource roots; retrieval scope is selected per request. See the
[task/resource design](design/resource-oriented-harness-design.md).

## Request and tool lifecycle

A client submits input to a session through the broker. The Pi worker loads the selected SDK, resources
and extensions, then prepares the actual model request. Native prompt sections, selected tools,
configured instructions and retained conversation determine the input; a shell choice does not impose
a separate Agent runtime. Work focus controls research capability selection independently of the shell.

Before each model request, including tool continuations, the Host supplies changed environment
observations and a current authorized teammate snapshot. Delivered environment observations can enter
native history; the teammate roster is request-local. Capacity accounting includes both. Near capacity,
a fixed-range compaction candidate is prepared in an internal worker and committed through Pi's native
session authority when space is needed. [Pi harness](../packages/pi-host/src/harness/README.md) owns the
integration details; [context design](design/harness-context.md) owns retention and cache semantics.

Host-backed tools cross `HostServicesBridge` and the authenticated Harness router. The broker binds the
actor identity; the Host resolves permitted resources. Tool permissions, resource scheduling and Rust
execution are separate layers. Independent operations may overlap, while conflicting resources retain
ordering. A tool allowlist is not an operating-system sandbox.

Source reads may use disk, a fixed editor-draft view or an isolated work branch. Source identity and
revision travel with the operation; a private source view is not a workspace Recovery branch. Shell
observation returns a real execution handle, and stopping an observation is distinct from terminating
the process. See [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md),
[terminal ownership](../packages/web/application-host/lib/terminal/DOCUMENTATION.md), and
[output organization](../packages/web/application-host/lib/harness/output-organize/DOCUMENTATION.md).

## Collaboration and working state

A Thread represents durable work; a Run represents one execution with its frozen launch configuration.
The main Agent retains responsibility for the overall task. Current ordinary delegation uses Worker
and retrieval configurations, with task-family conversation access, directed messages, event-driven
waits and selected code transfers. [Collaboration design](design/agent-collaboration-design.md) defines
these semantics; older implementation/frontend/review preset descriptions are historical.

Write-capable isolated work owns an independent immutable branch. Text operations can stay virtual;
operations requiring real paths materialize that branch. Shared physical work is an explicit choice.
Publication, selected code transfer and Integration use their recorded source/base/target identities,
not an unqualified copy of the latest files. Host services coordinate; the Rust kernel owns the
underlying objects, transactions and reconciliation.

Conversation-only rollback follows Pi history. Combined conversation/file rollback additionally uses
Recovery's recorded effects and coverage. Git history, editor drafts and external changes are not
silently replaced by task metadata. [Recovery operations](ops/recovery.md) explains the user action;
[recovery services](../packages/web/application-host/lib/recovery/DOCUMENTATION.md) and
[native recovery design](design/native-workspace-recovery-design.md) explain the implementation.

## Workbench and extension boundaries

Agent Workspace, IDE Workbench, Research Workbench and Bot Workspace are extension-provided shells selected through
Workbench Profiles. They reuse the Document Registry, editor kernel, terminals, Git and Pi session
state. Changing a project or work focus does not implicitly switch the shell.

Desktop/Web editing uses the shared Monaco document path; mobile and embedded editors use their
purpose-specific CodeMirror adapters. They do not introduce parallel content or save authorities.
See [workbench composition](design/composable-workbench.md) and
[editor design](design/unified-file-editor-platform.md).

Pi extensions execute in the Pi worker. Their UI is projected through a typed bridge or a maintained
adapter. Varin extensions instead use the separate Host/Surface capability model. Privileged extension
code does not run in an untrusted renderer. The [integration contract](design/extension-compatibility.md),
[Varin extension platform](design/varin-extension-platform.md), and
[authoring guide](ops/varin-extension-authoring.md) describe those distinct extension systems.

## Protocol, trust and failures

The public surface protocol, private Pi-worker protocol and generated Rust kernel protocol are separate
boundaries. Protocol types define messages; the receiving owner validates identities, generations and
resources. Cross-process callers do not acquire authority by supplying a session or workspace ID.

Credentials remain with their owning services. UI state is not privileged state, and permission prompts
are not a replacement for network, process or filesystem isolation. Missing, empty, unavailable, stale,
failed and conflicting results retain distinct meanings. Failed or superseded preparation does not
replace the previous valid owner generation. See [security](design/security.md),
[protocol](../packages/protocol/README.md), and [shared API failures](../packages/application-client/README.md).

## Runtime and deployment

The bundled Pi runtime is the default; an explicitly selected external installation is loaded through
the Varin bootstrap resolver. Runtime code and native user data remain separate. Shipped SDK patches
apply to bundled dependencies and in memory to supported external SDK seams, without rewriting the
user's installation. The production integration uses stable AgentSession/SessionManager; the
[Pi durable assessment](reviews/pi-durable-runtime.md) records a separate, unadopted candidate.

A Host owns its Rust kernel and private storage processes. Remote execution, desktops and virtual
machines reuse Host admission and resource identities; the implemented combinations are narrower than
the full [execution-environment design](design/execution-environment-design.md). Current product gaps
and platform evidence are listed in [status](status.md) and the [acceptance records](reviews/README.md).

Build and distribution configuration live with their packages and workflows. Repository version
metadata is not evidence that a particular installer or npm package has been published. Use
[development](development.md) for local commands and [operations](ops/README.md) for deployment.
