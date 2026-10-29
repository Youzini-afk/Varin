# Upright-family relocation production sources

Current integration handoff: `core-transition-contract-v3.json`, `current-source-detached-index-v4.json`, and `lid-support-bridge-v1.json`. The parent has accepted the upright identity, supported closed-laptop carry direction, and core contact drawings for integration testing. This is not native runtime acceptance.

New no-stool current sources are explicit SHA-indexed drawings. There is no family-name wildcard, no old 134-source mapping, no whole-character crossfade, and no old tilted-head artwork. Same-pose removal uses actual generated hidden-surface drawings, not a generic RGB transparency deletion. Current foreground differences remain protected. The known brown seat wedge behind the sleeve is specifically located in a restricted seat region and replaced with the authored clean plate.

The motion keeps the laptop closed and supported in front of the character. It does not reproduce the old long vertical-hug sequence. Hand silhouettes preserve all original dark outlines and shadows, rather than using a skin-color key that punches holes through fingers.

## Rebuild order

First rebuild `../shared` and `../lid` using their instructions. In this directory:

1. `register_secure.py`
2. `register_detach.py`
3. `register_airborne_response.py`
4. `fix_secure_hand_layers.py`
5. `register_land_contact.py`
6. `register_lap_release.py`
7. `register_stool.py`, `register_stool_v2.py`, `align_stool_geometry.py`, `finish_stool_legs.py`
8. `register_no_stool_v3.py`, `register_contact_no_stool_v2.py`, `prepare_no_stool_donor.py`
9. `derive_core_no_stool.py`, `derive_airborne_lid.py`, `refine_stool_mask.py`, `derive_airborne_lid_v2.py`
10. `derive_lid_contact_support.py`, `build_core_contract_v3.py`, `compose_core_review_v2.py`
11. `derive_ordinary_current_sources_v2.py` consumes the frozen `ordinary-source-inventory-snapshot-v1.json`, ordinary art sources and author foreground-protection masks. Then `append_closed_idle_sources.py` and `apply_foreground_tail_cleanup.py` produce the final 55-source index.

The original `closed-reference.png` is retained as a source dependency for initial hand/stool registration. It is not the final closed endpoint. Final closed endpoint is `../lid/frames/closed-rest-rigid-v2.png`.

## Rejected or superseded studies

- `detach-onset-study-v1.png`: duplicate boot fragments from an invalid partial composite; not used.
- `detach-onset-lower-v2-raw.png`: the model repeated an existing dangling pose rather than drawing a useful inbetween; not used.
- `airborne-response-v2.png`: seated stool accidentally retained by a hand-layer update; replaced by v3; never consume.
- `world-stool-candidate-v1.png`: seam fragments; superseded.
- `world-stool-aligned-v3.png`: accepted as a test plate for alignment, but peer found short hidden legs. `world-stool-grounded-v4.png` addresses this with real new leg artwork and prop-only registration; finite peer review passed for the hidden-leg geometry; native seat takeover remains to validate.
- Initial no-stool v1/v2 masks left small stool remnants near boots. Current routing uses refined v4 bodies / v5 canonical mask and contact-no-stool-v3.

Normal-speed WebP files are art-sequence reviews, not native recordings. World-seat motion, pointer response, cancellation, release, and regrab must be validated by the integration owner against the exact source SHA table.

## Verified snapshot

`CURRENT_ART_SOURCE_SELECTION_V4.json` lists 228 selected source/derived files (about64MB) and exact external dependencies in other portable art folders, without obsolete failed generation attempts or bulky preview movies. `portable-rebuild-verification-v1.json` records an independent rebuild after deleting frame outputs: 91/91 final PNG files reproduced byte-for-byte.
