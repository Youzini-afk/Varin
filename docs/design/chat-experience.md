# Pi-native conversation experience

Status: delivered; real-device and browser profiling remain release hardening

Last updated: 2026-08-30

## 1. Outcome

Varin's Agent workspace must make sending, switching sessions, reading long histories, and following
live work feel immediate without restoring OpenCode state or copying OpenChamber's large chat
components. The current Pi protocol already carries the necessary authority: session entries,
streaming deltas, queue/steer state, runtime snapshots, and read-only cold previews. This work turns
those facts into one coherent client-side conversation model.

The OpenChamber checkout is a behavioral reference. Varin adopts its proven interaction invariants
— transactional sends, turn projection, session materialization, one virtual list, and one scroll
owner — while implementing them directly over Pi DTOs.

## 2. Non-negotiable ownership

- Pi's session JSONL and live worker remain the message/tree authority.
- `usePiSessionStore` is the one renderer projection for every open, previewed, or optimistic session.
- Pi's `followUp` and `steering` arrays are the only queue authority. The retained OpenChamber local
  queue data model must not become a second queue.
- A read-only `session.entries.preview` result may make a cold session presentable but cannot accept a
  prompt, mutate the tree, or claim execution readiness.
- Workbench extensions may replace the Composer, timeline, message, tool, and session-decoration
  seams. Built-in presentation must not bypass those seams.
- Session/runtime generation bounds every asynchronous completion. A late send, preview, projection,
  or activation result cannot update a different selected runtime or session.

## 3. Conversation record

Each session record owns four distinguishable layers:

1. `preview`: persisted branch entries read without starting the worker;
2. `live`: worker snapshot plus canonical entry stream;
3. `submission`: renderer-owned pending user submission until Pi appends or rejects it;
4. `view`: entry intent, scroll mode, active turn, observed leaf, viewport checkpoint, and stale-command
   generation.

Preview and live entries merge by entry ID while preserving entries appended during an in-flight read.
An optimistic submission is never written to JSONL by the renderer. It reconciles only after a new Pi
user entry appears beyond the captured branch baseline.

Submission states are `preparing`, `dispatching`, `accepted`, `uncertain`, and `failed`. Deterministic
failure restores exactly the consumed draft, images, instructions, editor attachments, inline comments,
and Goal arm. An ambiguous transport result remains visible as `uncertain`; automatically resending it
would risk a duplicate Pi turn.

## 4. Turn projection

The timeline renders turns, not a flat dump of entries. A visible user message starts a turn. Following
assistant messages, thinking, tool calls and results, bash execution, visible extension messages, and
runtime summaries belong to it until the next visible user message. Entries that precede the first user
message remain ungrouped system/history records.

Tool results are indexed by `toolCallId` and rendered by their owning call. Model and thinking-level
changes become turn metadata rather than independent chat bubbles. Static completed turns keep stable
object identities; only the live tail turn consumes high-frequency streaming/tool execution updates.

## 5. Timeline and scroll ownership

The built-in timeline uses one virtual list for completed history and the live tail. A second DOM tail,
small-list implementation, or competing scroll writer is not permitted.

The scroll controller has three modes:

- `following-end`: stay at the live edge while new content arrives;
- `anchoring-new-turn`: park a newly sent user turn near the top and let its response grow below it;
- `free-scrolling`: user navigation owns the viewport until an explicit return-to-latest action.

Sending arms the anchor before the optimistic row commits. Real wheel/touch/keyboard navigation cancels
automatic movement. Row measurement, list data changes, and Composer height changes are handled by the
list/controller pair rather than independent effects.

The footer keeps additional space available for manual scrolling. Automatic following measures the
content edge before that spacer, including any compaction status row and the normal bottom padding.
If the user scrolls into the extra space, the viewport stays put while new output fills it, then
advances with the content edge. Return-to-latest targets that content edge; entry intents apply once
per epoch, and the virtual list's physical-end following is disabled to avoid competing scroll writes.

On session re-entry, a busy session, a session with unseen attention, or a session updated since its last
view opens at the live edge. Otherwise Varin restores the last visible turn plus its viewport offset.

## 6. Session switching

Selection changes immediately. If cached preview/live entries exist, they paint in the same commit. A
cold selection starts worker activation and a read-only branch preview in parallel. Until entries arrive,
the timeline shows a message-shaped hydration skeleton rather than a blank application spinner. Preview
content can render while model controls and other worker-only actions remain disabled.

Pointer focus/hover and settled neighboring-session selection may request a low-priority preview. Requests
are deduplicated and superseded by runtime/session generation; the implementation does not invent a fixed
queue cap or start background workers merely to prefetch UI.

## 7. Composer behavior

- Idle Enter sends a new turn.
- Busy Enter follows the selected Pi-native Queue or Steer behavior.
- Stop is a separate action and remains available while a draft can be queued or steered.
- Pi's authoritative queued/steering messages appear as typed rows above the Composer. Controls must map
  to atomic Pi operations: Pi 0.84.3 supports clearing the queue as a whole, so Varin does not simulate
  single-row editing or removal by clearing and racing messages back into the runtime.
- The Composer clears after a local submission transaction is committed, refocuses on desktop, and remains
  available for the next follow-up.
- Up/Down recalls local sent drafts only when autocomplete is closed and the caret is at the appropriate
  boundary.
- New-session and existing-session Composer shells are identical; only welcome/project selectors outside
  the shell differ.

Goal, permission, extension, queue, context attachment, and suggestion presentation form one ordered
accessory stack. There is no independent bar for each feature.

## 8. Message presentation

- A user prompt is the visual turn anchor and may stick at the top on desktop; mobile uses normal flow.
- One assistant header identifies the turn. The actual provider/model appears once; trustworthy tool and
  token facts appear in the footer. Varin does not infer a fake duration from Pi's request-start timestamp.
- Each completed turn aggregates the exact positive usage fields Pi reported: input, output,
  reasoning, cache read, cache write, optional one-hour cache write, and the provider-owned total. Missing
  or all-zero usage stays absent; these cumulative request totals do not represent current context use.
  One footer below the entire turn places actions on the left and statistics on the right, wrapping
  when necessary. Intermediate assistant messages have no individual action rows. Copy uses all built-in
  assistant prose in chronological order, including the live tail, excluding thinking and tool output.
  Discussion and fork keep their native entry contract and target the turn's last persisted assistant
  message with text. Memory extraction belongs to the text-selection menu; there is no per-message or
  turn-level remember button. User-message actions and extension-owned rendering remain independent.
- Conversation prose defaults to 16px with pixel-rounded 1.75 line height, 12px paragraph spacing and
  distinct heading/list spacing. The 48rem reading column and explicit wide layout remain available;
  code, tools and reasoning retain their compact presentation. Built-in sans-serif stacks include
  Chinese system-font fallbacks while honoring the user's selected font and scale.
- Built-in tool calls start as compact disclosure rows, including while running. Consecutive known
  read-only calls show read/search/inspection counts in either presentation mode; writes and unknown
  tools remain separate. Calls never group across intervening text or thinking. Success stays neutral,
  while failures remain visible even when another call in the group is still running. Explicit disclosure
  choices survive a live-to-persisted message handoff within the mounted turn, and are not reset by status
  changes. Extension tool renderers retain ownership of their presentation.
- Before the first assistant entry arrives, the newest unanswered turn shows the session model and a neutral
  working animation. It is presentation state, not a fabricated assistant message or progress phase.
- Chat presentation never changes Pi's live event transport. Live mode renders assistant text, thinking,
  and tools in arrival order. Sorted mode streams thinking, tool calls, and tool-use justification into one
  turn Activity group, with the terminal answer rendered after that group; unfinished answer text is withheld
  from the sorted body rather than turning the whole response into a non-streaming request.
- User-message recovery and branching keep their original entry targets; turn-footer discussion and
  branching use the final persisted text reply. These actions call native session operations. Varin does
  not pin messages or inject a second context layer over Pi packages.
- Streaming text is throttled and revealed by committed blocks. Virtualized remounts do not replay reveal
  animations.
- Unknown Pi/extension entries remain usable through generic renderers and raw detail disclosure.

### Chat context menu and selected memory

The shared timeline owns one context-menu controller across its virtualized turns. Right-click and the
standard menu primitive's touch long-press use the clicked object: selection, user message, Agent turn,
code block, file reference, hyperlink or image. Selection has priority. Editable fields retain their
native menu. A visible More action exposes the same controller without requiring right-click.

Copy, quote and menu actions capture their target before focus changes. Quoting appends to the current
runtime/session draft, leaves attachments intact, never sends, and focuses the Composer after menu
closure. Its source link navigates through the timeline's existing scroll owner. Runtime changes close
open menus/previews; stale actions cannot write to a newly selected runtime.

Extract memories works on the selected text, not the whole turn. Text wrappers register their native
entry and content position without putting raw source into DOM attributes. The selection mapper tracks
Markdown formatting, links, entities, lists, tables and code to exact UTF-16 source ranges. Unmapped
rendered regions and an unsaved live reply remain copyable/quotable, but cannot claim a verified memory
source. An open menu keeps a highlight over its captured selection.

The authenticated Host validates every passage against the current native branch before asking the
existing memory-organizer model (or its existing Bot-model fallback) for editable drafts. Explicit
extraction does not require automatic memory to be enabled, does not advance background coverage and
does not write memories. Empty results and malformed/failed results are distinct. Closing the preview
cancels inference through the existing batch cancellation path.

The preview shows content, recall cue, original passages and the actual destination: project, Bot or
session memory, with personal memory as an explicit alternative. Save uses the unified MemoryService,
rechecks the source revisions and owner, and commits accepted user-extracted records. Successful rows
remain visible if a later save fails. Undo is offered only for newly created rows and checks the saved
revision; duplicates are never silently retired. No second knowledge store or per-row review queue is
introduced.

## 9. Delivery phases

1. Delivered: submission transaction and authoritative Queue/Steer presentation.
2. Delivered: preview-backed switching, prefetch, hydration skeleton, and worker-readiness gates.
3. Delivered: Pi turn projector, tool-result ownership, and one virtualized timeline.
4. Delivered: session-scoped view state, a single scroll controller, send anchoring, viewport restore, and
   tokenized return-to-latest navigation.
5. Delivered: turn header/footer, copy actions, sent-prompt history, real mobile-mode behavior, and one
   ordered Composer accessory region.
6. Release hardening: real-device touch/pixel review and browser render-count/timing profiles. These
   measurements may tune presentation and estimates but must not create guessed hard ceilings.

Each phase lands independently on `main`. Focused tests must cover stale completion, rapid session switch,
optimistic reconciliation, deterministic failure restoration, ambiguous send, turn grouping, tool/result
ownership, scroll-mode transitions, and virtualized remount behavior. Performance decisions use measured
session sizes and first-visible/send-to-row/switch-to-paint timing rather than guessed hard ceilings.
