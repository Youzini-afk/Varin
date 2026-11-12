# Composer helpers and native input

`components/thread/ThreadConversation.tsx` owns input delivery. `ThreadComposer` presents its draft
through the shared CodeMirror editor, model/thinking controls, dictation, file attachments and
editor context. This directory holds reusable attachment, text, language and editor helpers; the
editor does not own Thread submission. Work controls live in the conversation's work overview.
Direct Bot chats and Bot drafts do not offer the project selector beneath the composer.

The footer's permission shield edits the Host's global `harness.permissions.mode` through the shared
settings controller. It remains available during execution and preserves existing rules. Its displayed
mode includes trusted project constraints for the execution workspace; a pending source change does
not replace the running workspace. Settings events refresh the control across views and reconnects.

## Ownership

| Area | Owner |
| --- | --- |
| Draft text, original file Blobs, fixed attachment references, images, material references, model choice and prepared source | `useThreadDraftStore` |
| Selected conversation and branch | `useThreadStore` and the native Thread Catalog |
| Current Run, history, queue and model selection | `ThreadsAPI` and `ThreadProjection` |
| Delivery observation and uncertain retry | `lib/agent-runtime/threadInputDelivery.ts` |
| Editor attachments and unsaved text | `lib/agent-editor` and the Document Registry |
| Registered models and skills | Authenticated Host model/resource APIs |

Drafts are in-memory and keyed by Host plus Thread/branch. They are not persisted conversation history.
Host replacement, branch changes and unmount fence asynchronous file reads and presentation updates.
The selected model's supported thinking levels and image capability govern the controls; live model
selection goes through the Run owner and its desired/active selection projection.

## External composer

External conversations use the same footer positions: backend-native modes and other options on the
left, separate thinking/model menus beside the Harness selector on the right. The project action and
connection details live below the input. Only the left group collapses when its measured content no
longer fits. Boolean options toggle directly and retain an inheritance menu. These controls edit the
next input, not the backend session; accepted and queued requests keep their original choices.

Opening a draft only reads/observes an existing binding. Explicit Harness selection, focus, typing or
opening a selector starts deduplicated preparation once a local directory is known; first send awaits
that same operation. Cancellation resolves an in-flight create's identity before disconnecting. Backend
or directory changes only delete a confirmed empty binding. Errors and login actions remain in the
connection popover. Reconnect stops the old connection before restoring its native session; metadata
model retries do not restart a healthy process.

New drafts seed optional Host-configured defaults once, otherwise inheriting the Agent configuration.
Cached capabilities are selectable and labelled; only a live catalogue invalidates stale choices.
A failed model catalogue does not erase retained model/effort overrides. Attachment pickers and
paste/drop enforce reported capabilities before upload, and send rechecks live capabilities.

## Input composition and delivery

`CommandAutocomplete` exposes the original Workbench registry and one separate skill group. Only
explicit composer contributions appear. Extensions keep their owner/activation path and namespaced
invocations; backend commands retain their negotiated Harness/session as an editor reference. Exact
whole-input commands execute locally, but ordinary prose and unknown commands remain ordinary input.
Actions consume just the active fragment after success, never the rest of the draft. Subview controls
cannot submit the surrounding message form; they receive real focus and keep their ordinary semantics.

Skill candidates come from `resources.skills` for the actual execution or `draftSkills` for an explicit
pending source. Selection keeps resource ID, version and optional pending-source locator, not a name
lookup. The Host validates exact owner/workspace/domain/path/content identity and freezes ordered
multi-skill activation at native admission. Accepted submit/enqueue/continuation retries reuse the
original frozen body and receipt, including object references and attachment selections.

`FileMentionAutocomplete` reads metadata from `sources.files` / `draftFiles`, typed attachment holders,
and the actual task-family directory. Every type has its own paging, cancellation and error state.
Only matching-source editor files contribute recency. Source paths remain relative to the admitted
source, including managed and fixed sources; a navigation directory never grants read access.

`editor/references` maps exact UTF-16 ranges through CodeMirror changes and undo/redo. Editing the
visible text drops the old binding; copying plain text does not transport hidden authority. File choices
also remain in `selectedAttachments`, a visible path/ref strip independent from inline marks. Submission
validates its captured Host/source before the original attachment owner reads bytes. Removing a mark
does not remove that strip, and no Blob is fabricated for a path or retained ref. Only the real receipt
clears captured selections. Native selections unsupported by an external Harness are rejected visibly.

Editor attachment chips and inline comments retain their Host, Thread/branch and document revisions.
Submission projects captured context into the input while keeping unsaved content explicitly identified.
A confirmed receipt acknowledges only the captured attachments and comments, so later edits remain.

An idle root Thread uses `submit` with a stable command key and expected head. A running Thread uses
`enqueue` with `boundary`, `interrupt`, or `next_run` delivery. A settled delegated child uses
`collaboration.continueChild` with its exact previous Run and expected head; active delegated children
use boundary/interrupt input. Queuing input does not resume an explicit policy Pause.

While a task runs, new messages follow the Queue / Add to current task setting. The composer has
no per-message delivery selector. A queued next-Run message can be sent now from its queue row:
native admission moves that same input to the current Run, preserves its captured media/materials,
and retires its unstarted successor atomically. Both interjections and promoted inputs wait for the
next model-request boundary without interrupting the current generation or any running tools.
They belong to the current Run, not to the queued next-Run feature. Admission is immediately visible
as an accepted input in the current conversation; it joins committed history at the next request
boundary. Even an in-flight final answer without tools is followed by that request in the same Run.
Retries retain the input identity and do not deliver it twice. Changing the default does not alter
an outstanding send receipt.

`deliverThreadInput` joins an already-running observation for the same original command. An uncertain
response retains the exact input, model, source, media and key. Explicit retry uses that intent; it does
not capture a newer draft or resend under a new key. Only an explicit first-attempt `not_started`
rejection can release the pending input. A real receipt clears only the original captured draft values.
If separate Goal registration is still pending after submit acceptance, retry retains the accepted Run
and does not submit the message again.

## Interactive content

HTML and declarative content share `lib/interactive-ui/compose`. Explicit fills target the source
Host and Thread/branch, insert at the last available cursor without replacing a selection, and never
focus the editor. CodeMirror tracks untouched source ranges through edits and isolated undo/redo.
Another fill updates an untouched range; editing or deleting it releases replacement ownership while
its fixed source remains a reference. IME fills wait for composition to finish. If navigation unmounts
the editor first, they finish in the original in-memory draft at its captured cursor.

Platform-rendered Send buttons register with `ThreadConversation`, which freezes only the action's
text and reference and uses `deliverThreadInput` with the existing submit/enqueue/child-continuation
rules. It does not take the composer's text, files, goals, or pending source selection. Each source keeps
its latest action attempt in the same Host/branch draft domain, never a second durable queue. Double
clicks join the original observation; uncertain retries keep its original body, model and command key.
A confirmed receipt replaces that attempt and deduplicates the unchanged action. Changing the action
can create a new attempt after acceptance. Draft removal releases this transient state.

Fixed interaction snapshots are explicitly projected as assistant-content source material. User-edited
message text remains the final expression, not the old values in that snapshot. Existing attachment
chips remain visible and removable through their original owner.

## File attachments

Picker, paste and drop accept arbitrary files without a document-format allowlist. Native and external
composers and the collaboration composer use the same in-memory selection model. Every selection keeps
its original Blob and stable upload key; picking a file is not an upload or a delivery. The selected
model does not prevent an image file from being handed off as a reference.

At send time `prepareThreadFiles` or the external owner's `prepareDraftFiles` adapter uploads original
bytes through the authenticated binary API. The client never encodes these files into base64 JSON or
parses their contents. A successful upload fixes a typed reference, scoped to its original Host and
conversation. Repeated preparation reuses that receipt; another conversation or Host cannot inherit
its authority. Preparation joins concurrent attempts for the same upload key.

All selected files must prepare before submitting the message. Failure keeps text, each original
Blob, successful references, and the failing file's error. Retrying reuses successful captures and
the failed upload's key. The UI distinguishes selected, preparing, prepared-but-unsent, failed and
accepted states. An uncertain delivery retains the original message key and complete selections;
only a confirmed receipt removes the captured draft. Multi-recipient sends prepare once and retry
only unconfirmed recipients with their original keys. Empty text with files is a valid message.

`ThreadAttachments` renders typed file descriptors in history, queues, collaboration feeds and reports.
Attachment actions remain outside the collapsed text region. Preview and download read the fixed
original through the real enclosing native or external owner, not a guessed file path. Images and PDFs
have browser previews; text is escaped, and other formats remain downloadable without a parser.
Executable content is never opened under the application Blob origin. Unmounting an attachment view releases
its client object URL, not the durable attachment. Closing its preview may keep the thumbnail cached. Copy-reference preserves the original file identity.

Existing retained material references, image inputs, and editor selections remain readable through
their original owners. Inline image selections keep their stable message-local reference numbers;
text-only queue edits preserve original media and file references. Removing a local draft chip is
not deletion of retained content.

## Verification

`ThreadConversation.behavior.test.tsx` covers native composition and delivery behavior;
`ThreadMaterials.behavior.test.tsx` covers material integration. Use focused helper tests when changing
this directory. Reference grammar is verified at `tokenizeComposer` / `tokenizeMentions`; markdown
syntax at `tokenizeMarkdown`; the CodeMirror adapter tests only document/context transactions. Avoid
repeating the same grammar examples for each scanner, mapper and editor layer. Autocomplete has its
own caret/paste behavior. Rendering, focus, IME, mobile keyboards and real clipboard/drop behavior still require
a browser or shell check; type-checking alone does not establish them.

## Focused verification boundaries

The menu/controller, editor state mapping, source-query generations and composer routing have portable
behavior tests. Native integration covers frozen skills/object references, attachment receipt normalization,
and explicit User dispatch. Export, memory CAS, separate recipient drafts and handoff/model-assist tasks
have focused owner and UI tests. Browser-only checks still require real Chromium or a product shell:
focus/implicit form actions, geometry, interrupted exit animation, actual IME, touch scrolling and visual
viewport changes. Linkedom event assertions do not establish those browser behaviors.
