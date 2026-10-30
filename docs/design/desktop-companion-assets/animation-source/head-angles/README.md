# Head pitch source study

The two generated drawings add actual out-of-plane pitch references. They are not complete runtime sprites and have not passed animation integration review.

- `head-neck-source.png` is an unscaled crop `[350, 100, 1030, 700]` of `../stage1/canonical-seated-clean-v3.png`.
- `head-pitch-up-generated.png` introduces more visible neck and a lifted chin/face perspective.
- `head-pitch-down-generated.png` introduces more visible crown and reduced neck exposure.
- Both preserve the selected restrained expression style, blue eyes, silver hair, character-left bun, folded clip, ribbon and rhombus pendant. Generated sources remain unchanged.
- The prompts request 7° up and 6° down, but those numbers are artistic direction, not measured or certified 3D angles.

## Alignment and visual review

`register_head_angles.py` uses a small similarity transform fit to lower-torso texture after matching the original crop dimensions. It does not warp the head or synthesize pitch. `registration-report.json` records the fit. The up-pose torso RGB residual is high: approximately 0.247 on [0,1] RGB. Therefore neither output is accepted as a precisely registered production cutout. The down residual is approximately 0.094; this is also not pixel preservation.

The `*-registered-reference.png` files are only references placed on the common 1382×1382 canvas; the `*-registered-crop.png` files and `pitch-comparison-qa.jpg` support side-by-side review. They must not replace the stationary body. Generated garment and hair details differ slightly, and bright fringe artifacts remain in the original generated alpha edges. Those require local extraction and cleanup before runtime use.

Canonical neck pivot: `(738, 510)` in full-canvas coordinates, `(388, 410)` in crop coordinates. The original head root/back-hair follows the shared transform through y=550 and fades to y=850; front-lock attachment fades by y=680. A pitch asset must include its exposed neck support and matched front/back hair attachments, rather than cutting at a fixed horizontal line.

## Integration boundary

1. Extract only the moving head, face, neck support and appropriate hair, leaving canonical torso and pendant unchanged.
2. Establish correspondences for eye corners, nose, mouth, chin, ear, fringe roots, bun and neck base separately for each pose.
3. Intermediate geometry must preserve features and silhouette. A whole-crop alpha crossfade would double eyes and hair; do not ship that.
4. Test natural motion and a modest diagnostic margin at actual desktop size and enlarged inspection. These references alone do not prove smoothness or lack of seams.

Generated through the built-in image tool. Exact prompts are in `prompts.json`. These source references are archived independently from runtime-accepted animation resources.
