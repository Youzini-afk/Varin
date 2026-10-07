# Composer

The shared Pi prompt composer is orchestrated by
`components/pi-session/PiComposer.tsx`. Agent Profile, IDE Profile, desktop,
Web, mobile, and mini chat all reach the same component
through `PiChatView`; they do not own separate send semantics.

## Ownership

| Area | Owner |
|---|---|
| Prompt text, images, and pending first-turn configuration | `usePiDraftStore` |
| Existing session model and thinking level | Pi runtime `SessionSnapshot` |
| Provider/model catalog | `usePiProviderStore` and `ModelPickerList` |
| New-session defaults | Pi settings, with Varin project metadata allowed to override the model |
| Prompt parsing and rendering | `language/` and `editor/`; sends use the composed draft directly |
| Process execution and model mutation | Pi Host through `usePiSessionStore` |

The UI may stage a model or thinking choice for a session that does not exist
yet. It must not pretend that choice is live: `PiChatView` creates the session,
applies the staged model, applies a compatible explicit thinking level, and
only then sends the first prompt. Once the session exists, the returned
`SessionSnapshot` is authoritative.

`undefined` in a pending draft means “inherit”. It is not copied into a second
global settings system. The composer displays the effective Pi/project default
while retaining that distinction, so selecting “Default” remains meaningful.

## Prompt language and editor

`language/` is the single source of truth for composer syntax. It recognizes
known `/command`, `/skill`, and `#snippet` tokens plus prompt markdown and path
references. Unknown tokens remain ordinary prose.

`editor/ComposerEditor.tsx` wraps CodeMirror, but its document is still a plain
string. The imperative surface is intentionally limited to caret operations
needed by autocomplete, dictation, and restored drafts; model selection and
send policy stay outside the editor.

CodeMirror owns text, selection, wrapping, undo history, and prompt
decorations. The native-selection overlay in `editor/theme.ts` is retained for
iOS handles and for selections over decorated tokens. Do not replace it with a
textarea/mirror pair: those two layers drift when typography changes and on
mobile wrapping.

## Model and thinking controls

`PiComposerModelControls` is part of the composer rather than the chat header.
The model trigger reuses the shared searchable model catalog, favorites,
recents, provider ordering, availability filtering, and mobile overlay. The
thinking menu is derived from the effective model's
`supportedThinkingLevels`; a stale explicit level is cleared when the user
chooses a model that cannot run it.

The global `open_model_selector` shortcut controls the picker anchored to the
active composer. Inactive profile surfaces must not mount a competing modal.

## Layout and motion

The footer separates configuration controls from the action corner. Container queries use the
composer's actual width in either shell; a narrow model row moves above the leading/actions row rather
than moving Send between columns. `PiChatView` supplies a view-scoped motion identity for the first-send
transition. Text, selection, queued revisions and attachments retain the owners listed above.

The pending draft, history hydration and live conversation share one mounted composer shell.
Its placement moves between the centered Agent start screen and the bottom of the conversation;
the inner editor resets only when its runtime/session draft owner changes. Loading does not replace
the input with a skeleton: the selected draft remains editable, known configuration stays visible,
and unresolved configuration shows a local loading label. Sending into an existing session waits
for its native worker, while a pending draft can still create a session using runtime defaults.
`PiConversationSurface` retains only the previous painted scene while the target history is pending,
keeps that scene inert, and crossfades when the target is available. Runtime changes discard that
projection. It does not introduce another history, draft or scroll authority.

Native queue changes animate by message identity. An exiting queue row is inert and releases its edit
form immediately, so a draft retained after dequeue is not displayed or editable twice.

The input surface uses a subtle top highlight and soft downward shadows for elevation in both themes.
Focus adds a low-opacity blurred halo without changing the border or adding a sharp focus ring.
The working sweep is diffuse as well; it does not use a masked outline around rounded corners.
These effects are paint-only and retain the composer dimensions and existing reduced-motion behavior.

`usePiMessageHandoff` binds paint-only transfers to the enclosing view. Draft transfers use the existing
submission ID and its native timeline anchor; queue transfers use the admitted queue ID forwarded on
native user-message events, including the persisted entry handoff. Equal message text never selects an
origin. The short overlay clips the visible content without scaling text, receives no input and leaves
submission, draft recovery and scrolling with their existing owners. Navigation, manual scrolling,
resize, failure and reduced motion release the projection. Offscreen sources use destination arrival.

## PDF attachments

Pi Composer accepts PDFs through its file picker and drop target. It uploads
each PDF through the existing Workspace API into the session's actual `cwd`:
`.varin/attachments/<safe-session-or-pending-scope>/<upload-uuid>/<original-basename>`.
The Host-returned absolute path and a Markdown link using the original filename
are inserted into the draft. The built-in PDF reader can open that local path.
A pending first-turn draft uses a stable `pending-<uuid>` scope, so creating its
Pi session needs no file move.

The PDF remains a regular workspace file and is not encoded as a Pi image
attachment or JSONL image record. Removing its draft reference, cancelling a
draft, or switching sessions does not delete the uploaded file. The unique
per-file directory avoids overwriting a same-named PDF without inspecting or
rewriting the user's `.gitignore`.

PDF upload is unavailable while the selected child thread reads from a virtual
WorkingState view: Workspace API writes to disk, while that thread's
`document.readSource` reads its immutable WorkingState snapshot. Materialized
thread sessions and ordinary disk-backed Pi sessions continue to use the
workspace upload path.

## Submission order

For a first prompt:

1. Create the Pi session in the chosen workspace.
2. Transfer the pending draft to the new session so a later configuration
   failure cannot orphan the user's text.
3. Apply the explicit draft model, or the Varin project model when present.
4. Apply an explicit thinking level after checking the selected model.
5. Compose the user's draft, snippets, inline comments, editor context, and
   goal state.
6. Send through Pi `prompt`.

For an existing busy session, the configured follow-up behavior decides between
Pi `steer` and `followUp`. The composer never emulates those queues locally.

## Verification

Pure configuration/default resolution and submission assembly are unit tested.
Rendering, focus, IME, mobile keyboards, clipboard images, and overlay handoff
still require a real browser or shell check; type-checking alone does not prove
those behaviors.
