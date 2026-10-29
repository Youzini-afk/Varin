# Upright character identity anchors (v2)

Three internally reviewed base endpoints: `upright-open-neutral-v2.png`, `open-screen-read-v2.png`, `closed-neutral-v1.png`. Fixed 512×512 full viewport; do not bbox-fit individual frames. This artwork is not yet a replacement runtime bundle.

The master and two local derivatives are authored raster outputs. Source image bytes, generation prompts, local registration masks, edge-cleanup script and provenance are retained. `open-screen-gaze-v1.png` is a side-glance reference, not the reading anchor. The earlier perpetual tilted-head family is not a valid visual bridge into these endpoints.

Reproduce normalized master with `python clean_anchor.py`, local endpoint registration with `python register_derivatives.py`, and reading gaze with `python register_screen_read.py`. Requires Pillow, numpy, scipy. Generation prompts describe the reference roles; existing raw files are retained, no regeneration needed for reconstruction. Exact invocation for the v2 anatomical correction is prompt-v2-exact.txt. The preceding first attempt is historical, not required to reproduce these accepted raster endpoints.

Keep same material palette, hair strand organization, compact boot volume, stool support and laptop footprint. Action-driven head pitch, shoulder response, true folds and leg movement remain allowed. Do not use a rigid rotated head or copy frozen pixels into regions that physically need to move. `anchor-contract.json` supplies approximate drawing landmarks, not an animation rig.
