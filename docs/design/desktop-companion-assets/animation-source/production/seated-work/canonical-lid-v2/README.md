# Fixed-hinge opening / closing candidate v2

This is a reproducible motion-candidate checkpoint, not visual acceptance. Opening has 38 exposures over 1950 ms; closing has 37 over 1945 ms. These are render exposures, not independent illustrations: there are four real grip drawings, one release drawing, and one hidden-arm clean plate. The laptop is a rigid projection of the canonical prop texture. Shoulder-pinned registration moves local drawn cloth/hand content; the rest of the character is protected.

## Rebuild
From this directory, run `python render_sequences.py`, `python check_motion_contract.py`, `python add_reversible_metadata.py`, then `node verify-interrupt.mjs`. Python requires Pillow, NumPy and SciPy. `render_sequences.py` invokes `build_contact_poses.py` and overwrites generated motion data; reversible metadata must be added afterwards.

The frozen closed endpoint is supplied by `../closed-endpoint-frozen-inventory.json`; the final open alpha is `../../shared/seated-open-canonical-alpha-v1.png`. The old draft alpha is not a dependency of this version. Source drawing prompts and the exact fixture references are included in the lid-v2 frozen inventory. Older six-pose/context studies are not inputs.

## Integration
`interrupt-controller.mjs` is a small source-exposure adapter, not an alternative animation framework. A production player can instead directly consume `frames[].motion.reverseFrom` from each source JSON. At interruption, retain the current exposure's pixels and switch to the listed exact-matching exposure in the opposite sequence; play the remaining tail with that sequence's explicit durations. Do not restart the opposite animation from frame zero. Each record also contains angle, grip/contact, art provenance and reverse-tail duration.

`requestClosed()` reverses opening or lets closing finish. Drag is allowed only at the actual closed-rest endpoint, never merely because the nominal angle is zero: acquire-grip is still holding the lid. Reversing rest endpoints does not invent a new transition. The adapter resets the new exposure dwell at reversal; it does not assume sub-exposure interpolation or a fixed FPS. A stalled real-time renderer may choose to cap time advancement to avoid visual skipping; that is a playback scheduling policy, not a new drawing.

75 exposure-midpoint interruptions verify exact entry pixels, recorded tail timing and reaching closed rest before drag. This is a technical contract check only. Exact skin/lip proximity does not certify hand anatomy. Remaining native-size visual review points are acquisition from the frozen closed drawing, grip-art switches, uncurl/retraction, and final keyboard return. No per-pixel transparent hidden-RGB feature is treated as a visible defect without compositing.
