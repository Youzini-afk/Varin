# Relocation production work — 2026-10-28

All work here is **authored motion-study / keypose candidates**, not final accepted animation. No frame count, atlas, or variable timing implies smoothness or accepted identity continuity.

## Retained sources

- `lift-nine-v1/v2`: closure → grip → lift source studies. Not production-approved: generated cushion behind hips, proportions drift, crowded grid, computer transform insufficiently coherent. Keep for provenance, do not pack as release frames.
- `landing-nine-v1`: early descending/putdown study. Not production-approved: generated stool and coarse transfer. Superseded for study use by contact and transfer sheets.
- `airborne-six-v1`: six actual direction-response drawings, real alpha. Contains natural hair/cloth changes but cross-family identity proportions drift; current status keyposes.
- `landing-contact-three-v2`: three whole-body airborne/contact posture drawings, no attached stool. This is not a complete landing: stool seat world anchor and contact geometry remain to be validated.
- `laptop-transfer-six-v1`: rejected black-vest hallucination. Retained to document correction.
- `laptop-transfer-six-v2`: original blue sweater and hollow-diamond pendant restored using original costume reference. Six real transfer drawings; not yet spatially registered into common canonical rig-free family.

Each source has adjacent `.prompt.txt`; tool was built-in imagegen. Original generated outputs retained in workspace generated_images. No rig, morph, whole-body crossfade or generated interpolation was used.

## Extraction

`extract_sources.py` labels alpha>5 connected character components and copies the whole component into a padded cell. This is necessary: generated hair extends outside nominal grid cells. It removes only near-zero-alpha background residues, never resizes or warps artwork. Each source image is retained unchanged. Frame canvases are 576² for airborne and laptop-transfer; 788² for contact. These different native scales are deliberately **not automatically normalized by bounding box**.

## Known acceptance issues / next work

1. Root/design cross-family QA demonstrates different head/body and laptop proportions across the newly generated families. Fix from a shared single-frame approved 01 canonical, not by forcing sheets together with bbox scaling.
2. Existing short sheets need real additional intermediates, grip continuity and natural timing before motion acceptance. 3 contact pictures do not by themselves show convincing weight.
3. Contact coordinate records are intentionally not fabricated. Need matched original stool anchor and pelvis/seat evidence. Stool belongs to world space, never attached to airborne sprite.
4. Early release, regrab, direction reversal and latest-intent restoration need compatible authored entry/exit drawings, not playback of an uninterruptible clip or wholebody crossfade.
5. Closure-entry from actual open-working pose remains missing at canonical quality.
6. Directional response sheet is not claimed seamless. Do not auto-ping-pong or auto-loop.

No user-facing completion claim made. No git operations performed by this worker.

## Canonical rebase phase, 21:09 UTC

Parent froze `shared/seated-open-canonical-v1.png` (390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b), alpha variant25eead33dd408600be423882ce7921a561b8fdb006642fe6f07b2f8580f65721. `canonical-v1` now uses single-frame directed edits, normalized by full square viewport to512 (never body-bbox scaling): close-start, close-half, closed, diagonalturn, seatedhug, earlylift, airborne, stoolplate, newlygrip-lift. Sources and prompts retained. `canonical-registered-v1` uses scriptstatichead restoration and targeted color cleanup; those earlier mattes still had fringing.

`airborne-clean-v2.png` is newest clean airborne candidate: generated opaque-white cleanup drawing then reproducible controlled matte via `derive_clean_airborne.py`. Parent viewed actual three-background QA and accepted progress as reasonable candidate, NOT final motion. Source SHA recorded alongside reviewed hole IDs in alpha-provenance. Do not repeatedly erode hair to chase residual subpixel brightness. Next prioritize contact/landing and stool world anchor plus motion review. Keep old files as provenance; do not overwrite clean candidate by re-running `preserve_static.py` (it writes airborne.png, not clean-v2).

## 21:40 scene registration

- `canonical-static-v1` protects the actual unchanged head/hair/legs/stool pixels while inserting genuine authored arm/computer changes. `protect_seated_static.py` applies a spatial edit-support polygon, not animation blending. Initial mask left a fragment of old laptop; mask was enlarged and source alpha retained, verified corrected in `reviews/static-closed-dark.png`.
- `reviews/close-to-hug.html` is packed7-frame485ms **keypose review**, not smoothness acceptance.
- `relocation-route-candidates.json` records physical early-release and regrab paths with missing art explicit, latest-semantic-intent not queued replay.
- `stool-world-candidate-v2.png` is a fixed world plate registration. Its inferred hidden perspective is still a candidate; no claim exact original reconstruction. Original visible cushion right and leg-bottom anchors manually inspected.
- `preland-no-stool-white-alpha.png` and `contact-skirt-restored-v3.png` are independent person layers. The latter restores actual original garment pixels after model stool removal wrongly erased right outer skirt (`restore_contact_skirt.py`, manually traced garment boundary). Corresponding world composites have been viewed.
- `airborne-right-lag-white.png` is a new direction-response source but **not approved**: larger-than-requested lag and hair touches right edge. Do not pack/loop until corrected.
