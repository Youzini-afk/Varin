# Seated work source checkpoint 1

These are source keyposes, not production accepted animation. No fixed FPS requirement and no runtime business-state inference.

## Typing six v2
- Whole-character image generation, 6 source cels; source PNG genuinely alpha transparent despite grey hidden RGB.
- Integer translation only against stable boot ROI, no per-frame scale, no bone deformation or body crossfade.
- Explicit 240/100/110/130/120/300 ms draft timing, no loop claim. Finger lift visible; far-hand press attribution remains visually weak.
- Local white skirt-tip speck removed using restricted region/color selection, preserving blue skirt. Cleanup counts 95–107 pixels per cel.
- Coordinates for seat/laptop are estimates, not contact-validated. Normal-speed temporal approval still required.
- Reproduce extraction with register_typing.py then cleanup_typing.py. Raw cel PNGs are intermediate crops of source.

## Opening six v1
- Actual successive closed lid, grip, partial raise, upright raise, release, keyboard-ready drawings.
- Source sheet not truly equal-cell spaced. Connected-alpha main bodies extracted with 3 px fringe; every body complete and isolated.
- Shared 16 px vertical padding prevents bottom-row head clipping. No scale or anatomical warps.
- Explicit 300/140/140/160/140/300 ms timing; no loop. Requires intermediate motion, especially partial-to-upright lid and release-to-keyboard.
- Hand/lid contact visually plausible in keyposes, but cross-frame hinge and body registration provisional. Do not auto-connect to typing because pose identities and registrations differ.

## Excluded candidates
Original typing12 sheet crosses grid and clips outermost hair; kept outside checkpoint.
Trackpad-read six candidate shows read lean but not a clearly valid trackpad scroll; not counted as completed scroll.
New opening intermediate drawings continue in a later version; frozen files here will not be overwritten.
