# Composer helpers and native input

`components/thread/ThreadConversation.tsx` owns input delivery. `ThreadComposer` presents its draft
through the shared CodeMirror editor, model/thinking controls, dictation, image/PDF attachments and
editor context. This directory holds reusable attachment, text, language and editor helpers; the
editor does not own Thread submission. Work controls live in the conversation's work overview.

## Ownership

| Area | Owner |
| --- | --- |
| Draft text, images, material references, model choice and prepared source | `useThreadDraftStore` |
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

`deliverThreadInput` joins an already-running observation for the same original command. An uncertain
response retains the exact input, model, source, media and key. Explicit retry uses that intent; it does
not capture a newer draft or resend under a new key. Only an explicit first-attempt `not_started`
rejection can release the pending input. A real receipt clears only the original captured draft values.
If separate Goal registration is still pending after submit acceptance, retry retains the accepted Run
and does not submit the message again.

## PDF and image attachments

The native picker, clipboard and drop target accept images and PDFs. Images remain explicit inline
image inputs and require an image-capable model.

PDFs use `ThreadsAPI.materials.upload(identity, { filename, mimeType: 'application/pdf', data })`.
The client encodes the original bytes as base64; the authenticated Host's document reader and
MaterialStore retain them and return a fixed PDF snapshot. The composer keeps its `snapshotId`, filename
and optional source hash. It does not upload into the workspace or extract PDF text in the browser.

Submit, all three queue modes and child continuation carry that same retained snapshot reference.
An uncertain input locks further PDF upload/removal so a retry cannot silently replace its material.
Removing a draft chip is a local draft change, not deletion of the retained material. `ThreadMaterials`
provides the enclosing reader and region destination; selected regions return only to that guarded
Thread/branch composer.

## Verification

`ThreadConversation.behavior.test.tsx` covers native composition and delivery behavior;
`ThreadMaterials.behavior.test.tsx` covers material integration. Use focused helper tests when changing
this directory. Rendering, focus, IME, mobile keyboards and real clipboard/drop behavior still require
a browser or shell check; type-checking alone does not establish them.
