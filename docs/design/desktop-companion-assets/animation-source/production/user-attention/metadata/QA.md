# USER_ATTENTION source drawing review — 2026-10-28

Built-in imagegen, full-character drawings. No cutout rig, optical flow, crossfade, or generated video. All sequences are keypose reviews, not smooth final animation.

## Current source paths
- `permission-open-cycle-v2`: 6 complete figures, left palm-up request/hold/return. Earlier 9-grid rejected for cramped crop/alpha artifacts.
- `query-nod-open-cycle-v2`: 6 complete figures, right-hand chin query, acknowledgment nod. v1 frame4 switched moving arm incorrectly; v2 fixes wrong-side hand but skips half-return, which still needs intermediate drawings.
- `welcome-closed-cycle-v2`: 6 complete figures, closed-laptop welcome. v1 returned gray vignette despite transparency request, v2 removes it and improves raise/lower poses.
- `completion-open-cycle-v1`: 6 complete figures, right-hand pleased wave. Frame5 right hand appears to contact lid upper edge; needs corrected free descending forearm and occlusion.
- `click-closed-cycle-v1`: 6 complete figures, no-hand-lift attentive gaze/nod. Model added panel borders; extraction removes only outer10px cell border where character is not present.
- `click-open-cycle-v1`: same 6 facial beats with open laptop. Separate drawings preserve computer state instead of automatic prop paste.

## Not yet accepted
None of these sequences has passed smooth animation acceptance. Six poses do not constitute final fluent motion. Interior drawings/inbetweens, authored holds, neutral registration, contact inspection and connection to live states remain production work.

## Image processing
`extract_keyposes.py` cuts exact 3x2 cells at native scale. Removes only border-connected near-white background (min channel >238, chroma<14), preserving enclosed white clothing. Uses Pillow, NumPy and scipy.ndimage. No whole-body per-frame transform, rescale, or image synthesis. Does not remove enclosed background gaps; edge quality remains a review item. Source images immutable; derived PNGs separate.

## Known visual risks
- Across cells the stool/boot/laptop position drifts. Need seat/laptop-hinge registration, NOT bounding-box/head normalization or global scaling.
- Some hair approaches sheetcell margins. Verify no clipped strands before approving.
- Pose semantics are recognizable but several hold or small-angle drawings are too similar while other arm changes are too abrupt; fill intentional gaps rather than uniform repeat-rate.
- Pendant, asymmetric costume, five fingers and hand ownership need per-pose enlarged QA.
- Open-laptop pose needs exactly two hands: keyboard hand occlusion must not be interpreted as or accidentally create a third hand.

## Runtime semantics
Permission is awaiting consent, not granted by nod/gesture; question is waiting answer; completion only after actual successful result. Click response is non-destructive and cannot dismiss permission/error. Attention animations are interruptible but drag/cancel semantics owned by coordinator.
