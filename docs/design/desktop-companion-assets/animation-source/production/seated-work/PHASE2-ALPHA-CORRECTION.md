# Phase 2 mixed alpha-version correction

Exact file verification identifies two baselines in the frozen phase-2 checkpoint:

- `canonical-typing-v1/frame-001.png` and `canonical-key-tap-v1/frame-001.png` are byte-identical to the historical draft alpha, SHA256 `fde8b3f8710b8deed3d8b197eb92a3b8d296c522acf78c51ecc9159a7232a44b`. The root preserved that exact file as `shared/seated-open-canonical-alpha-draft-v0.png` for reproduction.
- `canonical-scroll-v1/frame-001.png` is byte-identical to final alpha SHA256 `25eead33dd408600be423882ce7921a561b8fdb006642fe6f07b2f8580f65721`.

The phase-2 frozen inventory listing only the final shared alpha dependency was incomplete. Its QA JSON records 2127 outer-alpha differences for typing against the final file; the prose that generalized the earlier zero-difference check to all final-alpha groups was incorrect. The draft-alpha groups are historical candidates, not current runtime entry poses. No signed/frozen source file is overwritten.

The v2 typing/scroll/key-tap variants are rebuilt on the actual current read-screen image, copying only the local real hand drawings. Their builder asserts exact first/last read-screen pixels and zero changes outside the hand mask. The exact current read-screen source is recorded by hash in every v2 QA file. Both historical alpha sources are retained rather than pretending a later source reproduces earlier frames.
