# Seated art integration v3

`real-art-normal-range-v3.mp4` is an 8-second, 480-frame, 800×800 offline Canvas study. It combines a moderate in-plane head roll and 5-source-pixel lift, newly painted half/closed eyes, continuous near-hand pose interpolation and generated neck/shoulder backing. It is a quiet seated study, not completed character performance, true head pitch, a seamless loop or native runtime performance evidence.

## What changed

- Corrected 2,868 actual silver-hair pixels mistakenly owned by the rigid torso and 728 garment pixels owned by deforming hair.
- Continuous front lock has its own attachment falloff. Generated neck/shoulder artwork covers newly exposed regions; source visible body artwork stays the basis.
- Eye-local open/half/closed artwork is warped toward a shared interpolated lid contour before blending, rather than swapping three held frames. Intermediate texture alignment still needs refinement.
- Three newly drawn near-hand poses are registered. The wrist stays fixed and the active digit shape interpolates continuously. This short lower-palm digit may be the thumb; earlier experimental names `indexTip` are historical approximate landmark names, not an anatomical assertion. Most of its motion is occluded by the laptop, so it does not yet create visibly convincing typing.
- Actual keyboard/lid projection checked before planning a visible key-contact pose. Do not draw hands on the screen to expose them.

## Verification

23 focused Node tests passed, including two typing morph constraints. 480 output frames and a numerical adjacent-frame report were produced. The parent visually reviewed the contact sheet and closed-eye frame. Neither statistics nor still images replace full playback review.

Neutral v3 differs from the source at 1,929 pixels by >5 RGBA levels, maximum117, because of changed overlap ownership/backing. No new opaque pixels extend outside original zero-alpha silhouette. The exact zero-error static-partition result belongs to the older unmodified partition test and must not be reused as a claim about v3.

## Reproduce

Run `npm run prepare:art` and `npm run render:art-v3` from the lab after installing its existing development dependencies. The first command reuses byte-identical repository assets; the second runs `test/art-v3-record.mjs` with the complete provided runtime inputs. Encode `evidence/art-study/v3-frames/%04d.png` at 60 fps with ffmpeg/libx264/CRF18/yuv420p. Raw 480 PNGs are local intermediate files and omitted except for representative closed-eye frame 0231. `v3-recording-provenance.json` binds the recorded video to runtime source and assets.

Source-generation registration is in the art source packages. `test/prepare-art-v3.py` documents the semantic reassignment recipe against that sibling art workspace; packaged runtime assets do not require rerunning it.

The source-registration workspace is not bundled here, so that recipe is not a complete source-generation rebuild command from a fresh checkout. Likewise, `test/art-blink.mjs` is an earlier probe requiring unbundled v1 face experiments, not a v3 entry point. The current runtime reproduction uses only the files supplied or materialized by `prepare:art`.

Packaging adds repository command aliases to `package.json`; its exact recording-time version is preserved as `evidence/art-study/recorded-package-v3.json` and explicitly mapped in the provenance. Runtime source, tested code and video bytes are unchanged by packaging.

Next work: true pitched head geometry, visibly effective contact poses and shoulder/eye texture polish. No business event semantics or production Run/Operation integration changed.
