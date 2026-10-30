# Current-exposure SEATED_WORK pickup entries

43 previously missing exact source hashes are covered (35 lid/contact/retraction drawings and 8 typing/scroll hand differences). The output contains 46 work source hashes and 51 unique detached exposures including recovery bridges. These are **composites of existing authored art**, not new independent drawings.

The exact current image's upper region and every pixel outside the replacement mask are retained. The replacement is an actual no-stool hidden-garment drawing from relocation, not an alpha-only deletion. The common exclusion mask preserves the right sleeve; head, actual hands and lid are unchanged through y=327. Seven 320px dark-background representatives were visually inspected: no old stool legs remain, no finger/lid identity change. Other exposures share the same proven static replacement geometry; this is not blanket final animation acceptance.

`currentPoseEntries` covers the 43 missing hashes in the recorded global coverage report. `additionalEntries` supplies three other existing work endpoints for optional deduplication; do not blindly replace another accepted exact-source entry. Every path is relative to the production root.

## Immediate movement and recovery

The OS character window follows the pointer **from the initial detached exposure**. Recovery can proceed during movement; it is not a movement permission gate.

For a lid pose, use the exact-pixel counterpart in the original closing sequence and play only its remaining detached tail. This retains the existing hand/grip/lid-angle trajectory rather than restarting from fully open. For typing/scroll, finish the current short operator gesture, use the authored screen-to-user gaze bridge, then the detached closing trajectory. After the common closed endpoint, reverse existing near-settled/lap-release/contact hand art before gathering knees into the closed-carry sequence. All actual recovery sources and durations are explicit.

Each recovery exposure carries `originalSeatedSource` and its hash. If the user releases before the carry pose, restore that **actually displayed** seated equivalent when the independently placed world stool reaches contact. Do not force a complete closing, knee curl or hug before release. The same-canvas seated equivalent preserves current hand and lid pose. This rule is deliberately data-backed, rather than inferred from an action-family name.

New source folder only; frozen canonical-lid-v2 and hand-v2 files are untouched. Rebuild with `python build.py` from this directory. The script asserts all required coverage hashes resolve and every outside-mask pixel remains exact.
