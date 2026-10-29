# Upright family: fixed-hinge laptop opening and closing

Status: internal motion candidate, not a replacement for accepted runtime assets.

Current sequence: `sequence-source-v3.json`; normal-speed review: `opening-normal-speed-v3.webp` and `closing-normal-speed-v3.webp`. Twelve exposures include rest, contact, seven angle/contact drawings, release travel, and open rest. Closing reverses the same supported path. Timing is explicit; no whole-character crossfade or body rig is used.

The lid is a rigid prop textured from the shared upright mother drawing. Hinge and base do not change between angles. Hand/cuff contact changes are image-generated original drawings, locally registered; the common right supporting hand remains stable. Head, hair, clothing, legs, and seat are preserved outside actual arm changes. This solves identity drift but is not a claim that every interval is already final-smooth.

Rebuild order (Pillow, numpy, scipy):
0. `prepare_crops.py`
1. `build_prop_fixture.py`
2. `register_contacts_v2.py`
3. `compose_endpoints_and_review.py`
4. `add_release_bridge.py`
5. `fix_closed_hand_layers.py`
6. `fix_contact_hand_layers.py`

`contact-015-crop-placed.png` is a fixed-viewport placement of the raw 260-square crop; preserve it alongside raw. Source provenance and hashes are in `source-manifest-v3.json`. Rejected whole-frame attempts remain identified in sequence metadata; they are not animation exposures. A model-generated 20-degree hand was registered to the compatible fixed 30-degree prop; the final angle label describes the actual deterministic prop, not the original prompt.

The mechanical `closed-rest-rigid-v1.png` is a new candidate endpoint, not byte-identical to the earlier shared static closed anchor. Do not connect it under the old exact-source identity without an approved transition.

Final closed endpoint after complete hand-silhouette repair: `frames/closed-rest-rigid-v2.png`, SHA256 `d029c4fc7e78432f465781669f978c96980e34fce0d9a81756abe3aca35064bb`. The earlier v1 skin-key matte defect is rejected; dark finger outlines must not be holes.
