# Composer editing

This is the existing CodeMirror prompt editor, not a second rich-text model. `ComposerReference`
continues to own every explicit range. Quote/image targets point to a stable `ComposerMarkerObject`;
the reference ID identifies one occurrence, while the object number is only its displayed label.
Typed or external plain-text labels never create bindings. Language highlighting does not resolve
image identity by regular expression.

`markers.ts` owns insertion, Unicode grapheme/marker boundary snapping, atomic edits, movement and
object removal/relabeling. One committed operation changes text, occurrences, selection and retained
objects together. The corresponding state effects participate in CodeMirror history, including
image bytes, selected file Blobs and exact stored-media holders. Deleting an occurrence keeps its
object; removing an object deletes every bound occurrence. Relabeling touches only bound ranges.
Queued edits can preserve the accepted numbers with `renumber: false`.

The draft owns its in-memory `EditorState`. Reopening a view reconfigures that state with the new
view callbacks, preserving history and selection. An explicit transition from a retained state to
`undefined` ends the previous draft's undo lifetime, as on acceptance/discard. Configuration-only
transactions do not write the draft back. Unmount does not recreate a draft its owner removed.
`markerComposerRegistry.ts` only resolves currently mounted handles by their original scoped key.

Insertion handles capture a cursor, not a replacement selection, and map it through subsequent
transactions. IME insertion waits for composition end. If the original view closes, preparation
uses the original draft's independently tracked anchor and retained state, never an active-tab
fallback. Interactive fill composes its editable source range and fixed quote in one undo step.

`markerDrag.ts` owns transient gesture geometry. It preserves the source placeholder, paints a
small floating marker/drop caret and scrolls only the editor viewport. It dispatches no document
changes until a valid, nonempty drop. Pointer movement before the hold belongs to ordinary text
selection/scroll. Touch uses a separate nonpassive `touchmove` sensor that calls `preventDefault`
only after the hold, without globally disabling native touch scrolling. Escape, touch/pointer
cancellation, source changes and view teardown cancel the gesture. Explicitly focused marker
Enter/Space opens its preview before the normal Composer keyboard routing.

`markerClipboard.ts` writes a custom same-runtime clipboard token and a readable external fallback.
The token resolves the last copied objects in memory, including original Blobs without JSON
serialization or another upload. Pasted occurrences get new IDs and target-draft numbers. Other
Hosts, missing session tokens and unsupported queued-file imports do not acquire resource authority.
The clipboard exposes its captured references to the existing selection lifetime owner; replacing
or clearing that clipboard releases the prior clipboard roots. Cross-process/Host clipboard import
is not a new material-transfer protocol and falls back or reports unavailable explicitly.

Behavior tests exercise real CodeMirror state/view transactions, clipboard events, pointer/touch
hold cancellation and edge scrolling, IME, unmount/remount and acceptance history reset. Geometry is
injected for the DOM tests; they are not a substitute for physical iOS/Android or visual browser QA.
