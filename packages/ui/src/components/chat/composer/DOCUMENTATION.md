# Composer helpers and native input

`components/thread/ThreadConversation.tsx` owns input delivery. `ThreadComposer` presents its draft
through the shared CodeMirror editor, model/thinking controls, dictation, file attachments and
editor context. This directory holds reusable attachment, text, language and editor helpers; the
editor does not own Thread submission. Work controls live in the conversation's work overview.

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

## Input composition and delivery

`ThreadResources` supplies skill selection. Choosing one inserts `/skill:<name>` into the draft; the
Host resolves the resource against the real execution checkpoint. History projects skill metadata
separately from the unchanged user text, and `ThreadSkillMaterials` reads the original resource.

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
and retires its unstarted successor atomically. Only the newly accepted promotion interrupts the
current model generation; running tools continue. Retries retain the input identity and cannot
interrupt another generation again. Changing the default does not alter an outstanding send receipt.

`deliverThreadInput` joins an already-running observation for the same original command. An uncertain
response retains the exact input, model, source, media and key. Explicit retry uses that intent; it does
not capture a newer draft or resend under a new key. Only an explicit first-attempt `not_started`
rejection can release the pending input. A real receipt clears only the original captured draft values.
If separate Goal registration is still pending after submit acceptance, retry retains the accepted Run
and does not submit the message again.

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
