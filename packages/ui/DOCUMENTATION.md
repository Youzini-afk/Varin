# Shared UI

`@varin/ui` is the React presentation shared by Web, Electron, and mobile. It owns client-side
projections and workbench kernels, not privileged filesystem, credential, shell, or process work.
Surface packages provide `RuntimeAPIs`; shared code imports the contracts and transport primitives
from `@varin/application-client` without hardcoding origins, IPC channels, credentials, or local paths.

[Workbench and presentation](../../docs/workbench.md) explains the cross-feature invariants.
[Extensions](../../docs/extensions.md) explains contribution and service ownership.
[Runtime](../../docs/runtime.md) explains the native Thread/branch, Catalog and Application Host boundary.
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
| HTTP, browser URLs, switching | [Application client](../application-client/README.md) |
| Shared projections and preferences | [Store ownership](src/stores/DOCUMENTATION.md) |
| Agent resource-panel navigation | [Context surfaces](src/lib/surfaces/DOCUMENTATION.md) |
| Settings primitives and save feedback | [Settings components](src/components/sections/shared/DOCUMENTATION.md) |
| Conversation controls | `src/components/thread`, `src/lib/agent-runtime`, and `ThreadsAPI` |
| Conversation presentation | `src/components/conversation`: virtual timeline, message/tool cards, selection menus, sidebar and transitions |
| Purpose-specific tools | `ChatDelegation`, `ChatResourceTools`, `ChatSourceTools`, `ChatProcessTool`, `ChatWorkTools`, `ChatMaterialsTool`, `ChatEnvironmentTools`, `ChatComputerTools`, `ChatFollowupTool`, `ChatMcpTool`; `toolInvocation` preserves gateway and native operation ownership |
| Interactive content | `src/lib/interactive-ui`, `src/components/interactive-ui`; [contract and lifecycle](../../docs/interactive-content.md) |
| Theme and shared chrome | `src/lib/theme`, `src/styles`, and `src/components/ui` |
| Motion tokens and preference | `src/lib/motion`, `src/styles/motion.css`, `MotionProvider`; see [Motion](#motion) |
| Icons | [Sprite-backed Icon contract](src/components/icon/README.md) |

Lower framework-neutral `lib` owners do not import official `workbenches`. Narrow `features`
adapters connect React/stores to those kernels. Extension code must not import product UI internals
when the SDK's framework-neutral mount/controller contract provides the seam.

## State and lifecycle

Shells own presentation. Documents, open groups, terminals, runtime identity, and domain facts remain
with their existing shared or Host owner. Same-Host directory resolution can retain the rendered shell,
but must not supply the previous workspace ID as the new target. Failed resolution, Host replacement,
or a revoked contribution is a different state and cannot keep a stale authority alive.

Async work captures Host/API epoch and its actual Thread, branch, resource, or contribution
identity. Changing targets invalidates both the request and its intended mutation target. A cached view
can preserve continuity but cannot turn missing, loading, failed, or inaccessible data into success.
Complete authoritative snapshots and partial save responses have different merge semantics.

Conversation cards project native history IDs and original request metadata. File navigation resolves the
history item's original source through the Host before opening Documents; the selected navigation project
does not identify a task's working copy. Child rows follow Catalog execution admission order, while reports
remain attached to their original execution. Context summary history is read through its parent-owned job.

Child file review binds an immutable publication to its original parent source. Explicit User apply/undo
commands use native user Operations and the existing Integration journal. Preview refresh reads those
records; it does not repeat writes. Dirty editor buffers keep their Documents revision checks.

High-frequency document text, cursor motion, streaming output, and transition frames stay close to
owners with narrow subscriptions. Zustand holds appropriate navigation, preference, and keyed query
state; it is not a universal storage layer. Dirty text never belongs in Local Storage. Profile changes
must not recreate text models, accepted execution, or terminal processes.

Connected workbench mounts participate in the existing Surface preparation lease. Their real hidden
mounts validate before publication; closure, replacement, and render failure fence that lease. Once the
Host confirms durable selection, local mount cleanup cannot claim the catalog or an external effect
rolled back. Detailed lifecycle mechanics belong to the extension packages.

## Motion

The product uses four springs and two tweens from `lib/motion/tokens.ts`:
- `snap`: hover pills, menus, press.
- `glide`: the default, for arrivals, selection and size changes.
- `travel`: cross-region movement.
- `settle`: arrival moments only.
- `TWEENS.fade` is 160ms; `TWEENS.exit` is 110ms.

The same spring drives every motion layer:
- motion components use `springTransition(token)`;
- WAAPI uses `springTiming(token)`;
- CSS uses `var(--motion-ease-<token>)` over `var(--motion-dur-<token>)`.

`styles/motion.css` holds the generated `linear()` curves, and `tokens.test.ts` fails when they drift from the TypeScript springs. The older `--wb-*` durations remain for existing rules and follow the same levels.

`motionPreference` (Appearance → 界面动效) is `full`, `reduced` or `off`. It is persisted with the other app settings and synced through desktop settings. When the OS asks for reduced motion, `full` resolves to `reduced`.

`MotionProvider` wraps each React root. It writes `:root[data-motion]` and configures `MotionConfig`:
- Under `reduced`, CSS keeps opacity and colour changes and ends movement immediately.
- Under `off`, CSS ends every transition and animation.

`usePrefersReducedMotion()` and `prefersReducedMotion()` return true for either reduced level, so existing callers follow the user's choice. `useMotionLevel()` exposes the three-way level for code that treats `reduced` and `off` differently. Reading pauses, such as a preview that stays briefly before retracting, keep their time under every level because they are reading time rather than animation. The design and phased plan are in [motion and interaction](../../docs/design/motion-and-interaction.md).

Values that a motion component cannot own, such as a scroll position the virtual list also reads, use `SpringDriver` from `lib/motion/spring.ts`. It integrates one spring per frame, keeps its velocity when retargeted, and can be shifted when the underlying content moves.

The conversation timeline has one scroll spring, owned by one motion at a time:

- Following the end uses a critically damped spring (ω = 14). Its target only grows, so a long reply glides instead of stepping once per measurement. While it catches up, the timeline still counts as at the end.
- A sent turn travels to the top with `travel`. Once its reply passes the comfortable line, the view hands over to following on the same spring.
- 「滚动到底部」 skips a long history and travels the last 1.25 viewports. Near the live edge it hands over to following, velocity and all.
- Wheel, touch and key intent stop the spring at once. A motion whose owner went stale (mode, generation or return token) stops on its next frame.
- Entering a Thread, a resized viewport, and `reduced` or `off` place the end directly.

Streamed Markdown is revealed by `usePacedText` one frame at a time (`lib/motion/pace.ts`):

- The reveal rate is `max(26/s, backlog / 0.24s)`. Arriving text only moves the target, so a burst speeds the front up and a pause slows it down smoothly.
- When the stream ends, what is left drains evenly in 0.16s. `revealing` stays true until then, so the open block keeps its streaming render until the last character.
- History and windowless environments show text in full immediately. Joining a stream already in progress reveals only its last 160 characters. A reply remounted within 1.5s continues where it was.
- The pace runs under every motion level; it is reading rhythm, not animation.

A code fence that is still streaming is coloured line by line (`components/chat/markdown/liveFence.ts`). Each change to its completed lines is sent to the Shiki worker once, 90ms after the line completes, with one request in flight per fence. Renders reuse the newest result that is still a prefix of the code, and a result that lands during a pause re-renders its owner. The line being written stays plain. The open fence uses the same `.line` structure as the closed block, so closing it only adds line numbers. Fences over 400 lines and Mermaid stay plain until they close.

`MarkdownInk` (`components/chat/markdownInk.ts`) paints the ink front after each morph. Text revealed in a frame develops from faint secondary grey to its own colour in 300ms, and a zero-width dot after the last text stays lit while writing and breathes after 280ms without new text. The renderer calls `prepare()` before morphing, so morphdom never sees or reuses the ink spans or the dot. Spans are rewrapped after the morph with a negative animation delay matching their age, and merged back into text after 420ms. `reduced` keeps a still dot and `off` shows neither.

`SwapText` (`components/motion/SwapText.tsx`) changes a label in place: the old text rises and fades out while the new one enters from below in the same grid cell. A change that arrives within 260ms of the previous one waits and shows only the latest text, so quick actions stay readable at every motion level. `live` adds a faint light sweeping across the text; it replaces spinners for running labels and is static under `reduced` and `off`. The conversation-first process row keeps one `SwapText` for its whole segment: thinking, each action and the closing receipt swap in place instead of remounting the label. The one-line thinking preview follows new lines on the `glide` spring.

Each frame the spring compares the scroll position with what it wrote last. A difference means the list or the reader moved it in between, and the spring carries that shift instead of fighting it. `MessageHandoff` keeps a sent message's flight on its destination while the timeline scrolls, and ends the flight only when the destination leaves the view.

The motion lab (`packages/web/motion-lab`, development only) mounts real conversation components on simulated streams. Start it with `bunx vite --config motion-lab/vite.config.ts` in `packages/web`. Headless checks are in `motion-lab/checks`. `node follow.cjs` measures following, release, return, anchoring and reduced motion frame by frame; `node stream.cjs` measures pacing, ink, the dot, the drain and cleanup; `node process.cjs` measures the process row's labels, their hold time, the shimmer and the receipt. They need `PLAYWRIGHT_PATH` and `LAB_BROWSER` when Playwright and its browser are not installed in the workspace.

## Conversation and resource projections

Tool headings summarize the requested action and its subject before disclosure, then add returned
facts where useful (process state, confirmed input, output size, matches or restored paths). Each
purpose-specific renderer keeps its interaction model; `ToolHeadingText` shares typography only.
`ToolTargetScope` resolves process commands and child names from loaded native call identities,
including gateway targets. It does not fetch additional history or retain a cross-thread cache.
Missing subjects stay unknown, and requested mutations never substitute for completed receipts.
Narrow viewports wrap subjects instead of hiding them; original arguments remain in details.

Chat layout offers chronological, grouped-answer, and conversation-first (`dialogue`) modes.
Conversation-first is the default for unset preferences and resets; saved choices retain their mode.
Conversation-first preserves every spoken message in arrival order. A single activity renders its
original thinking or tool row, retaining that row's own disclosure. Multiple ordinary tools and public
thinking items between messages share one initially collapsed activity row: the active segment shows
the current action. While public thinking streams, its header reuses the single-line scrolling
preview; thinking-only history retains that preview. A later spoken message or the end of a mixed
segment leaves a receipt-based tool summary. Redacted thinking never contributes preview text. Dispatches, questions and usable UI/image outputs (including observed script descendants)
remain independent rows in all three modes. Opening a segment mounts the existing purpose-specific tools, preserving their controls and
resource identities. Failed, cancelled, and uncertain work stays visible in the collapsed status.
Provider-item identities and arrival order survive streaming-to-history replacement; disclosure
choices belong to the original segment and the conversation, rather than the latest render.
The settings preview uses these same projections with inert, manually stepped examples.

Ordinary successful calls recede without a repeated completed badge. Applied changes, drafts and branch
edits keep distinct effect labels; activity summaries count confirmed calls, not guessed unique files.
Follow-up rows distinguish current task state from a recorded invocation and empty lists from creation.
Script call history loads on expansion; headings only use already observed facts. Sorted activity rows
remain mounted through collapse so the existing virtual list can measure the height transition.

Turn footers keep actions on the left and usage directly visible on the right. Positive cache read/write
metrics appear inline. Cache rate is cached reads / complete input, derived by the native provider owner;
aggregate rates require known, deduplicated receipts and use weighted token totals. Original protocol
usage is retained independently of this complete-input presentation field.

`ThreadQuestions` owns a nonmodal, composer-width dock above the input. `ask_user` schema 2 accepts
stable question/option IDs, multiple questions, single/multiple choice and free text. A complete answer
is submitted once to its original Operation; Catalog validates against the original question and keeps
its ordinary Wait/history ownership. `question_status` returns both readable and structured answers.
Memory-only drafts retain selection, text, navigation and scroll per Host/Thread/branch/Operation;
collapsing, navigating or switching presentation does not discard them. Uncertain submission re-reads
the original Operation before retrying its frozen intent. Question receipts stay in the original turn.

`ThreadPermission` keeps allow-once / always / deny separate from questions. Always saves a user rule
through the Host configuration owner before deciding the original permission; partial saving/decision
failure is shown explicitly. The visible scope currently covers the named extension/MCP capability
and its arguments on the selected Host. Native source grants still own filesystem/process scope.
Workspace restrictions take precedence. Subsequent authorization reads current policy; a saved rule
does not bypass the original owner, pinned invocation or execution checks. Rules remain removable in
the existing permission settings. Settings page layout is outside this chat implementation.

The native Catalog owns accepted input, history, queues and execution receipts. `useThreadStore`
projects navigation and summary clocks; `ThreadProjection` observes the selected branch. Progress
streams are transient and sequence-scoped. A lost connection rebuilds from durable history rather than
inventing completion or automatically resending input. Drafts retain exact uncertain command intent.

Opening a new conversation creates only a local composer. Its first explicit send creates the Thread,
prepares the selected source and uploads staged PDFs. The composer keeps its key across that transition,
so editor attachments and message handoff stay attached. Creation and uncertain submission retries reuse
their original keys. Source Host discovery is available before creation and grants no file access.

`ThreadConversation` projects native Agent facts through `ThreadsAPI`. Its child, family, follow-up,
plan, Goal, permission, question and recovery components keep their original owner and revision.
The work overview projects current execution, plan steps, child tasks and saved outputs. Its quick and
full views use compact floating cards in a reserved layout column, so neither covers the conversation
or composer. Cards fit their content with internal scrolling when needed; the full card has a resizable
width. Narrow conversations stack the card above the chat. Disclosure and width state remain outside
streaming timeline subscriptions. Empty capability categories are not shown.
Plan summaries show up to three steps around the current work, with two wrapped lines per
step and a link to the full plan. The plan detail switches its content area between reading
and editing, grows the editor with its text, and keeps save/cancel controls in view. Concurrent
plan changes retain the draft and offer the latest revision for comparison before rebasing.
Workspace, goal, follow-up, memory, research and recovery editors mount on first inspection and retain
their drafts across panel navigation. Context resources and compression jobs share the context detail.
The plan reader stays subscribed to its existing branch events, while tool/operation bodies are read
only in their detail view. Full execution controls remain available from the overview menu.

Saved file changes and interactive HTML are projected from native calls and receipts. The overview
uses its own disposable history reader, so timeline virtualization cannot remove its entries. It finishes
the current Run's page boundary for file counts and reads older pages as the output list is browsed.
Failed writes are excluded; editor drafts, committed working-copy changes and applied files keep their
different labels. File navigation retains the original history item; HTML opens the saved content ref
with its original Thread/branch. Neither view substitutes the current project's Git changes.

The overview's child section is a task list. Row context menus and hover buttons share actions for
opening, inspecting, renaming, copying, sending another instruction and stopping the selected task.
Completed tasks offer continuation through the existing message request path; read-only views hide
mutations. Agent profile settings, family browsing and message-directory controls do not sit below
the list. Renaming uses the Thread catalog owner, and an uncertain instruction retry retains its key.
Showing a resource or history view does not launch work. A follow-up registration observes its original
Job/source and cursor; it never stops the observed Job or uses a renderer timer as a scheduler.

The right-hand Collaboration surface reads original family dispatches, peer messages and final reports in one native
event-cursor feed. Reports project the last assistant response from immutable execution history as child-to-organizer
replies, preserving multipart text and original outcome. Each continuation retains its own execution identity;
reading the room never publishes another message or invokes a model. Dispatches retain their original task and exact parent/child branches; later
continuations never substitute their input. Internal code retrieval stays outside the room. Its virtual
list prefetches older entries and merges by original message/dispatch/execution identity, including dispatch-only and report-only pages.
`CollaborationMessage` shows explicit sender/recipient routes and message bubbles. User messages align
right; Agents retain their avatars. Rendered body height determines long-message folding, including later
font/image/reflow changes. Expansion remains keyed to the entry in its room, animates in place and pauses
automatic following; copy uses original full text. Messages retain native reply identities; dispatches and reports
open a new send to the exact child branch without inventing a reply-to message ID.
Inside chat, `ChatAgentMessageBubble` presents received messages, task reports and native `send` calls
as separate directed bubbles in every render mode. They start folded with a literal two-line preview;
the timeline's existing disclosure cache retains manual choices. Preview and body animate together,
and expanded long text scrolls within a wrapping window. Native message/report envelopes are unwrapped
only under their original history holders; message-body JSON remains opaque and model context is unchanged.
Partial report previews retain explicit access to the original execution's paged report reader, loaded
only after the user asks. Failure/cancellation details and original send receipts remain inspectable.
Member selection mounts one original Thread history/progress reader with a separate viewport key; main
conversation scroll state stays independent. Completed members are paged through the native history
directory. User replies and per-recipient send attempts use the original message admission API, with
drafts and uncertain keys retained in the existing in-memory draft store. File cards read immutable
Integration journal versions on inspection; current working files are never substituted for an old diff.

`HistoryPresentation` projects semantic history into the timeline without replacing its IDs. Model
labels and token receipts come from the original frozen request, not today's selected model; usage is
counted once per request even when it produced several visible items. Tool-call identity includes its
Run and request. Cancelled, indeterminate, accepted background work and success have distinct states.
`thread-history` caches read-only bodies by Host epoch, Thread and branch, merging live tails and
prefetched pages through native parent IDs. It retains reading history on return, bridges unseen
appends, drops a rewound future, and aborts reads on view-owner departure. Whole-Run usage is a
separate cancellable Host read; bodies and progress never await that scan. Summaries carry their
original cut and appear once after the ended Run, with unknown receipts kept distinct from zero.
`chatTimelineBlocks` separates logical turns (quotes and copy) from measured user,
message, activity and footer rows. Stable native row IDs let the virtual list compensate prepends
and height changes; sticky user prompts use the list's own sticky-header support. Upward prefetch
starts a viewport ahead and extends by observed speed and read latency. Ordinary history scrolling
does not enter a frozen view or require a loading button; only read failures expose retry.
The navigation rail reads a separate complete native Run index, with one pointer per Run and
ordinals from the selected branch's ancestry. Loaded body pages, virtual rows and activity folding
do not define its count or order. Hover previews read the Run's prompt/response; selecting an
unloaded Run first loads its original history anchor, then maps it to a measured row.
The header context ring and context sidebar share a separate anchored context inspection. The Host
counts immutable ancestry metadata and reads the latest original model receipt beyond visible pages;
tool-result bursts cannot erase usage just by pushing that request out of the loaded tail. Inspection
runs alongside snapshot/progress rendering. Compaction clears the old footprint until a new request
reports usage. Sidebar message bodies remain paginated, and unavailable billing stays unknown.
`timelineViewStore` owns scroll positions only. Message handoff animation targets the history ID from
the accepted input receipt. A retained outgoing scene is inert during conversation switching.

Thinking is visible by default. `collapsibleThinkingBlocks` selects a one-line live preview versus
automatic expansion; it never prevents manual folding. `ChatThinkingBlock` follows wrapped preview
lines, and expanded text grows into a bounded reading viewport. Scrolling up pauses that viewport's
following until the reader returns to the end or selects Follow new output. Disclosure and reading
position use the native assistant message ID across live/history handoff, retained only as disposable
presentation state. The animated fold keeps its body mounted and inert while closed; reduced-motion
preferences disable movement.

`ThreadContent`/`ThreadMedia` consume declared typed text/media holders, not arbitrary JSON that looks
like an image descriptor. Visible image previews and explicit attachment reads retain the original holder, part ordinal and execution
identity. Object URLs belong to the mounted view and are revoked on cancellation or target change.
Incomplete output-body pages must not be rendered as a complete report or reinterpreted as Markdown.

`components/materials/PdfMaterialReader` is the shared reader core. Thread adapters provide the
authenticated material transport and guarded draft destination. PDF upload retains original bytes in
the Host material owner; submit, queues and child continuation carry a fixed snapshot reference.
Research artifacts first resolve through the original artifact owner and then use the returned snapshot. Selected regions go to the enclosing conversation's
guarded composer; there is no global material event that can target a different Thread.

`lib/attachProcessTerminal` attaches an accepted process. Remote cwd and resource identity are metadata,
not permission to resolve that path on the coordinating Host or create a replacement local shell.
Closing an attached tab detaches; it does not stop its Job. Thread retry first reopens the original
owner/branch/operation through the Host. Attached Jobs are not persisted as restartable local shells.

Computer activity is an event projection of the Host operation. Its launcher does not probe/capture
screens or acquire control. Bot sleep/archive/delete progress is also Host-owned; opening history
never wakes a Bot. Ordinary navigation filters the native Catalog’s `bot_id` ownership before
displaying conversations.

Tool presentations use their recorded domain objects: material collections retain snapshot readers and
explicit family shares; forwarding distinguishes the service endpoint from the coordinating Host's
access address; extension review binds the original candidate integrity. Computer links open the exact
recorded desktop. Office comparisons require returned before/after readback, while export and the live
document's dirty flag remain separate. MCP task cancellation, executor stop, retained output and resource
notifications retain their separate meanings. Follow-up rows consume the existing snapshot and revisioned
control API; opening history never starts a renderer scheduler. Question choices use one wrapping
column with native radios/checkboxes, free text and explicit whole-request submission.

Source files, Git snapshots, material pages, and editor drafts retain their own identities. Explicit
resource roots resolve through Documents instead of borrowing a conversation's workspace. A file-change
preview only describes received arguments until a real result supplies its mutation outcome.
File write/edit previews appear while arguments stream, even when content precedes the path;
the completed path fills the same preview without resetting its reading position. Wrapped,
measured rows keep long lines within the viewport, and the inner scroll follows incoming
content until the user scrolls up. Explicit navigation resumes following or jumps between edits.

## Settings and authoring conventions

Settings UI consumes shared catalog identities and the original domain APIs. Device-local entries use
`client-settings-bridge.ts` and acknowledge what the target Surface actually applied. Forms preserve
unsaved field drafts and their opened revisions across refresh; conflict is not an instruction to
resubmit an entire old document. Same-owner and cross-owner results retain their real atomicity.

The settings shell provides grouped navigation, a compact location header, local tabs, disclosures,
and an action dock outside the scroller. Editors stay mounted across local tabs; scope/object changes
use the original draft guards. Appearance, chat, editor, terminal, and notification previews use
inert samples. Voice model cards and storage cleanup keep their existing domain interactions.
See [settings composition](src/components/sections/shared/DOCUMENTATION.md).

Project trust is managed in the selected project's identity/defaults page, per canonical folder.
Skills and MCP settings do not duplicate the grant controls. Project creation reviews previously
untrusted folders before activation; the explicit choice may grant trust or keep existing decisions.
Already trusted folders reuse their decision. Multi-folder grants re-read the shared trust revision
and retain the reviewed canonical path; cancelled or retired Host views cannot grant trust.
Conversation defaults edit Host-global values. Project model and thinking overrides live with the
project and restore inheritance by deleting overrides.

Model services open on their model collection with separate connection/authentication and request
configuration tabs. MCP settings project tool declarations from the retained live connection or the
original directory cache, labeling their source. Configuration, authorization, and connection state
remain distinct. The tool settings page lists the actual registered catalog; native tool selection is
edited in Agent profiles rather than through the obsolete global tool-name toggles.

`components/sections/agents` uses `AgentProfilesAPI` for native profiles and exact registered tool names.
Host changes retire old reads and drafts; omitted tools, empty selection, and reset are distinct.
Accepted Runs are not rewritten by editing a default. Functional models stay with their owning settings domains.

Agent avatars share one role-independent library: `components/ui/agent-avatar-art.ts` owns the SVG paths
and `AgentAvatar` renders them at every size. Stable IDs come from the protocol registry. Native dispatch
persists a random choice on the child relation, or uses the profile's fixed choice; reuse and rename retain it.
The profile picker controls future dispatches. Legacy identities use the frozen identity-based palette in
`@varin/protocol`, so expanding the library does not change their appearance. Existing status indicators remain
separate from avatars; displaying a message does not fetch an extra profile or image.

Provider editing separates connection configuration, model discovery, and authentication. Discovery
and login have different interaction identities and cancellation. Saving a configuration is not
successful login. Credentials stay in their native owner, never renderer settings. See
[provider authority](../web/application-host/lib/models/DOCUMENTATION.md) and
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
