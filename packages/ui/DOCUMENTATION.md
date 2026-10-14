# Shared UI

`@varin/ui` is the React presentation shared by Web, Electron, and mobile. It owns client-side
projections and workbench kernels, not privileged filesystem, credential, shell, or process work.
Surface packages provide `RuntimeAPIs`; shared code imports the contracts and transport primitives
from `@varin/application-client` without hardcoding origins, IPC channels, credentials, or local paths.

[Workbench and presentation](../../docs/workbench.md) explains the cross-feature invariants.
[Extensions](../../docs/extensions.md) explains contribution and service ownership.
[Runtime](../../docs/runtime.md) separates the Pi product route from the opt-in Agent runtime.
Use these for architecture, then the local owner below for implementation changes.

## Module navigation

| Area | Owner and local reference |
| --- | --- |
| Official shells | `src/workbenches`: Agent, IDE, Research, Bot, and Settings composition |
| Extension integration | `src/lib/extensions`: catalog, loader, mounts, replacement/slot consumers, and owner-bound services |
| Profile handoff | `src/lib/workbench/profile-transition.ts` and `src/lib/extensions/workbench-shell-transition.ts` |
| Text state | [Document Registry](src/lib/documents/DOCUMENTATION.md) |
| Groups, tabs, providers, restore | [Editor Workbench Kernel](src/lib/workbench/editors/DOCUMENTATION.md) |
| Desktop/Web file editor | [Monaco](src/lib/monaco/DOCUMENTATION.md) |
| Mobile and embedded editors | [CodeMirror](src/lib/codemirror/DOCUMENTATION.md) |
| Agent/editor attachments and patch review | [Agent/editor bridge](src/lib/agent-editor/DOCUMENTATION.md) |
| HTTP, browser URLs, switching | [Runtime API boundary](src/lib/api/DOCUMENTATION.md) |
| Shared projections and preferences | [Store ownership](src/stores/DOCUMENTATION.md) |
| Agent resource-panel navigation | [Context surfaces](src/lib/surfaces/DOCUMENTATION.md) |
| Settings primitives and save feedback | [Settings components](src/components/sections/shared/DOCUMENTATION.md) |
| Pi conversation | `src/components/pi-session`, `src/lib/pi-runtime`, and `usePiSessionStore` |
| Agent runtime conversation | `src/components/thread`, `src/lib/agent-runtime`, and `ThreadsAPI` |
| Theme and shared chrome | `src/lib/theme`, `src/styles`, and `src/components/ui` |
| Icons | [Sprite-backed Icon contract](src/components/icon/README.md) |

Lower framework-neutral `lib` owners do not import official `workbenches`. Narrow `features`
adapters connect React/stores to those kernels. Extension code must not import product UI internals
when the SDK's framework-neutral mount/controller contract provides the seam.

## State and lifecycle

Shells own presentation. Documents, open groups, terminals, runtime identity, and domain facts remain
with their existing shared or Host owner. Same-Host directory resolution can retain the rendered shell,
but must not supply the previous workspace ID as the new target. Failed resolution, Host replacement,
or a revoked contribution is a different state and cannot keep a stale authority alive.

Async work captures Host/API epoch and its actual session, Thread, branch, resource, or contribution
identity. Changing targets invalidates both the request and its intended mutation target. A cached view
can preserve continuity but cannot turn missing, loading, failed, or inaccessible data into success.
Complete authoritative snapshots and partial save responses have different merge semantics.

High-frequency document text, cursor motion, streaming output, and transition frames stay close to
owners with narrow subscriptions. Zustand holds appropriate navigation, preference, and keyed query
state; it is not a universal storage layer. Dirty text never belongs in Local Storage. Profile changes
must not recreate text models, accepted execution, or terminal processes.

Connected workbench mounts participate in the existing Surface preparation lease. Their real hidden
mounts validate before publication; closure, replacement, and render failure fence that lease. Once the
Host confirms durable selection, local mount cleanup cannot claim the catalog or an external effect
rolled back. Detailed lifecycle mechanics belong to the extension packages.

## Conversation and resource projections

Pi's native entries, queue, commands, session generations and worker readiness remain authoritative.
Cold previews can render before readiness but cannot admit execution. Optimistic submission is local
until native reconciliation; uncertain delivery remains visible instead of automatically resending.
A single virtual list and scroll controller preserve manual reading, new-turn anchoring, and follow-end.
Renderer choices do not change the live event transport or invent progress, timing, or token facts.

`ThreadConversation` projects native Agent facts through `ThreadsAPI`. Its child, family, follow-up,
plan, Goal, permission, question and recovery components keep their original owner and revision.
Showing a resource or history view does not launch work. A follow-up registration observes its original
Job/source and cursor; it never stops the observed Job or uses a renderer timer as a scheduler.

`ThreadContent`/`ThreadMedia` consume declared typed text/media holders, not arbitrary JSON that looks
like an image descriptor. On-demand reads retain the original holder, part ordinal and execution
identity. Object URLs belong to the mounted view and are revoked on cancellation or target change.
Incomplete output-body pages must not be rendered as a complete report or reinterpreted as Markdown.

`components/materials/PdfMaterialReader` is the shared reader core. Pi and Thread adapters provide their
actual transport and draft destination. Research artifacts first resolve through the original artifact
owner and then use the returned fixed snapshot. Selected regions go to the enclosing conversation's
guarded composer; there is no global material event that can target a different Thread.

`lib/attachProcessTerminal` attaches an accepted process. Remote cwd and resource identity are metadata,
not permission to resolve that path on the coordinating Host or create a replacement local shell.
Closing an attached tab detaches; it does not stop its Job. Thread retry first reopens the original
owner/branch/operation through the Host. Attached Jobs are not persisted as restartable local shells.

Computer activity is an event projection of the Host operation. Its launcher does not probe/capture
screens or acquire control. Bot sleep/archive/delete progress is also Host-owned; opening history
never wakes a Bot. Ordinary navigation observes the Bot session index before displaying conversations,
so an unavailable ownership read cannot leak Bot conversations into an ordinary session list.

Source files, Git snapshots, material pages, and editor drafts retain their own identities. Explicit
resource roots resolve through Documents instead of borrowing a session's workspace. A file-change
preview only describes received arguments until a real result supplies its mutation outcome.

## Settings and authoring conventions

Settings UI consumes shared catalog identities and the original domain APIs. Device-local entries use
`client-settings-bridge.ts` and acknowledge what the target Surface actually applied. Forms preserve
unsaved field drafts and their opened revisions across refresh; conflict is not an instruction to
resubmit an entire old document. Same-owner and cross-owner results retain their real atomicity.

`components/sections/agents` uses `AgentProfilesAPI` for shared profile fields and runtime-specific tools.
Pi plugin agents retain their provider catalog and management format. Host/runtime changes retire old
reads and drafts; omitted tools, empty selection, and reset are distinct. Accepted Runs are not rewritten
by editing a default. Functional models stay with their owning settings domains.

Provider editing separates connection configuration, model discovery, and authentication. Discovery
and login have different interaction identities and cancellation. Saving a configuration is not
successful login. Credentials stay in their native owner, never renderer settings. See
[provider authority](../pi-host/src/PROVIDERS.md) and
[memory/personalization authority](../web/application-host/lib/memory/DOCUMENTATION.md).

Use semantic theme tokens for surfaces, actions, selection, feedback, and syntax. Theme changes update
projections rather than rebuilding models. Shared primitives own shared focus and interaction chrome;
a single layout exception does not justify another wrapper or a public contribution type.
The fold logo's source is `src/components/ui/varin-mark.ts`; generated assets must not develop independent shapes.
Custom theme format lives in [the theme guide](../../docs/ops/CUSTOM_THEMES.md).

Visible text and accessibility labels resolve through `@/lib/i18n` during render or hook execution.
Every shipped message catalog receives real translations for new semantic keys; parity tests check key
shape. Keep parameters as values rather than fragments of grammar. Product names, paths, commands,
provider/model names and user content stay literal. Locale changes should not remount the application.

## Verification and performance

Use the scripts in `package.json` and tests beside the changed owner. Behavior evidence should exercise
real transitions: interrupted/repeated actions, stale target completions, drafts, connected mounts,
queue identity, cleanup, and provider failure. Layout constants or a copied literal enum are not useful
behavior tests. Scope shared-contract checks to actual consuming surfaces.

Visible demand owns refresh and subscriptions. Hidden views release DOM observers, language requests,
Git/PR refresh work and presentation timers; hiding a view does not cancel independently owned backend
work. Preserve unrelated object identities instead of rebuilding full histories/catalogs on each delta.
Measure cold load, warm switches, paint, and cleanup on the relevant platform before adding budgets.
A virtualized viewport size is not a stored-history/content limit.

Reduced motion, keyboard navigation, focus return, narrow layouts and touch must be checked through their
real interaction paths. Unit/contract tests and source inspection do not establish browser timing,
real-device usability, authenticated provider success, or packaged Electron/mobile acceptance.
