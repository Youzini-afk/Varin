# Pointer drag and pose readiness are independent

The frozen lid-v2 adapter used the name `canDrag` for a much narrower condition: the seated closed-rest drawing is ready to enter a closed-computer carry sequence. That name must **not** be wired to pointer capture, window position updates, or drag permission.

Use this adapter's `readyForClosedCarry` instead. On pointer pickup, follow the pointer immediately. Select an available half-open pickup/carry continuation for the current grip/lid phase; do not wait for the seated 1.9-second close sequence. `requestClosed()` remains useful for ordinary seated closing or choosing a closed-carry preparation when no immediate pickup is underway. It is not a drag event handler.

The old frozen files are retained as historical checkpoint data. This naming correction changes no pixels or exact-reversal metadata. The integration owner must use the corrected interface or apply the same semantics in its existing player.
