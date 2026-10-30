# Companionship and local attention v3

Candidate source closure on unchanged `varin-upright-v2` identity. Parent visually approved the complete contact sheet direction: supported small covered yawn, own-skirt hand rest, readable doze/wake, forward hover attention and warm tap response. This does not claim final native timing, hitmask or full interaction acceptance.

13 actual new sources are enumerated by `manifest.json.runtimeSourceNames`; only those PNGs and the exact mechanical closed anchor are reachable. `*-normalized-reference.png` files are registration intermediates, not runtime assets. The first stool-contact rest raw is rejected and excluded. Original v2 artifacts are untouched.

The supported yawn starts from mechanical closed: character-right/image-left hand raises, while the other hand stays on the laptop. A true early contact-release drawing avoids jumping straight from lid to mouth. The arm returns through real drawings before the other hand rests on her own skirt. Computer and knees continue supporting each other; no scene props are baked into the character.

Rebuild: `python register_pose.py && python build_handoff.py`. Dependencies: Python, Pillow, NumPy, SciPy. Raw imagegen outputs, exact prompts, local references, authored-region masks, source SHA and reproducible processing are included. Whole raw viewport is resized to 512; only generated fringe contamination is cleaned. No full-body rig, affine head rotation, bbox fitting, morph or crossfade creates motion frames.

`manifest.json` splits rest entry, stable doze hold and actual wake exit. It also supplies closed-only hover/tap and tap-from-hover. Every actual source has a short normal recovery to the exact mechanical closed endpoint; current long holds are interruptible. Runtime must reset idle eligibility on input/wake/tap so a new task or touch cannot fall back into sleep next frame. Runtime also gates 5-minute clear idle, actual-alpha hover dwell/cooldown, hidden resets and priority dragging. No OS sleep, Host status, authorization or completion is inferred from these local emotions. Open hover is not fabricated by closing the laptop; existing v2 open tap remains valid.

`qa/all-poses-v1.jpg` preserves the compact contact sheet. Rebuilding generates normal-exposure GIF studies; generated previews and normalized registration caches are omitted from this archive. The finite 1.5-second doze shown there is a preview device, not an automatic runtime wake timer. Grab coverage is tracked separately by relocation owner against every current actual source SHA.
