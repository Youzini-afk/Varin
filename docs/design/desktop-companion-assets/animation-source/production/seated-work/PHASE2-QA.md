# Shared-baseline hand-motion checkpoint

This checkpoint replaces the earlier independently generated seated anatomy for typing/scrolling. It does not mark final temporal acceptance or runtime integration.

- Exact shared 512 px canonical alpha baseline is used for full-body static pixels; each frame outside the local hand-context mask is byte-identical to that baseline.
- Actual index/middle-finger anatomy is newly generated and registered from close-up drawings. No bone motion, body scaling, body-frame blending, or repeated unrelated full-character poses generates these actions.
- First and last frames are the exact canonical baseline. All clips are deliberately non-looping in source manifests until the playback composition is reviewed.
- Typing is 990 ms; scroll is 1220 ms; single key tap is 640 ms. The key tap reuses the real index-finger drawings with separate authored timing; no new-art claim.
- Scroll uses a local two-finger move/contact/release near the visible palm-rest. It is not repeated typing mislabeled as scrolling.
- Original white sleeve/blue cuff continuity is protected; enlarged hand crops were used to correct a doubled wrist outline and small mismatched cuff pixels.
- `qa.json` records changed-pixel tests. The common alpha file is an external shared dependency, not privately recreated.
- 320 px MP4s are internal native-size motion-review aids. Their container frame-rate handling is not a production FPS requirement; source JSON millisecond durations remain authoritative.
- Still pending: normal-speed aesthetic review, assembly with non-keying reading/observation/idle motion, Electron integration. Executing/waiting states must not display continuous invented keyboard activity.
- Lid/closed redraw studies continue separately and are excluded from this motion checkpoint; closed endpoint is an internal production candidate supplied to REST, not an accepted finished opening/closing action.
