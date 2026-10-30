# Task reactions v3

Parent reviewed direction; runtime/no-stool integration remains pending. All art is full 512 viewport, frozen upright v2 identity, default blue and hollow diamond. No whole-body affine animation or old tilted art.

## Rebuild
Python + Pillow + NumPy:
```
python process.py
python manifest-build.py
python qa-build.py
python integration-support/build-tail-support.py
python freeze-source.py
```
Preview images/GIFs are generated QA cache, excluded from repository archive and SHA inventory. All references bundled; paths are relative to manifest directory. Original v2 files untouched. `raw/` and `prompts/` preserve built-in imagegen outputs and exact prompt. `assets` records each exact input SHA.

## Four real new motion groups
- Arrival: read → look user → existing real low hand lift → new light chest touch → low lift → neutral. Receipt/attention only, never implies parsed/understood without fact.
- Thought: actual left hand lift → chin contact with slightly left/upward thoughtful head → unique matching-head eye blink → lower → screen. Not v2 REVIEW and never permanent tilted head. Blink only for this head geometry. Sustained think holds the same body with sparse blink; lower/return is on factual exit, not a repeated full sentence.
- Output: low hand lift → retracted content pointer → full content-directed finger/open mouth → closed-mouth pointer → lower → screen. Full open mouth only 430 ms, not indefinite speaking.
- Issue observation: visible paused hand and mild concern → real lowered locating finger → relaxed listen. Raw locating face was too stern; frozen gentle reading face is intentionally reused and documented. No angry/failure melodrama.

Completion uses v2 reviewed wave honestly. Cancel/unknown/reconnect use existing neutral body honestly, with independent truthful external cues. Cancel requested is NOT stopped; reconnect is NOT completion; retry wait is NOT success. All public `accept` pose variants choose compatible actual open/closed endpoint, never force an unnecessary close.

`ordinaryRecoveryBySourceSHA` covers every actual exposure, including all reused references and thoughtful blink. Short events withdraw through that exact source's return prefix; do not replay receipt tails or reset to neutral. `pauseSafe` is explicit per exposure. Matching controller holds require actual facts, not elapsed-time business inference.

Masks are edit masks, NOT full foreground masks: right sleeve moves can expose seat/background. No-stool integration must register exact sourceSHA and inspect actual silhouette. All frozen fixed regions outside masks are verified unchanged; thoughtful blink compares to its exact thoughtful anchor.
