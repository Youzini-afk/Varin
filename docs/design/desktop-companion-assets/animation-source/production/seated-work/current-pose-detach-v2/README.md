# Short supported pickup recovery v2

Uses the 43 detached current-exposure entries and original art from v1, but replaces v1's overlong ordinary-closing recovery policy. v1's images remain valid; its long idle/read/closing queues are historical, not the integration route.

Typing/scroll retains actual hand-release and gaze drawings, with passive exposure holds trimmed to at most 45 ms: 185–320 ms reaches the already authored supported-open pickup pose. Then use the shared half-open detach/knee-gather/carry chain. No full ordinary seated closing is queued.

For a lid already held, use the real reverse-compatible contact trajectory only to the <=35-degree half-open handoff. If the current hand is retracting, use its authored reverse reach first. These render exposures are at most 32 ms each, with no new poses invented. The longest recovery segment before the common pickup chain is 800 ms; many are much shorter. Low-angle poses finish only the remaining short closed tail before the existing reverse-settling hand bridge. Window movement begins immediately for every route, independent of this pose recovery.

`handoff-review.jpg` shows actual ~35-degree contact followed by the authored supported half-lid pose and knee-gather frames. At 320px, both hands/leg support remain legible, the prop does not become unsupported, and body geometry is not normalized or warped. This is a candidate handoff, not a claim of final polished cadence.

Every actual source recovery exposure preserves originalSeatedSource/SHA; original current-exposure early release can seat that same supported pose without first closing/curling/hugging. The special supported-open handoff uses an explicit releaseNext path rather than falsely naming a generated fullbody reference as a pixel-identical seated equivalent. Lid recoveries retain their exact source angle/contact metadata under motion.
