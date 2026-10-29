# Whole-body response motion layout — internal calibration only

This is **not final Varin art, not a production renderer, not a proposal to ship an SVG character, and not a rig applied to existing raster art**. No production source, bundle, application code or public selection was modified. The motion is a new schematic drawing of masses, lines and contact constraints. It cannot automatically paint a consistent anime sequence.

## Open
- `index.html`: self-contained play-once animation and frame scrubber, no application/Host connection.
- `motion-layout.mp4`: 4.208s, 960×660, 24 sampled guide frames/s. These samples visualize coordinate paths only; 24fps is not a claim that final drawings exist.
- `guide-{rest,brace,release,approach,peak,return,lower,contact,settle}.png` and `.svg`: representative full-layout guides.
- `pose-time-data.json`: key intent times, 101 sampled poses, shoulder/elbow/wrist positions, head/chest/pelvis positions, contact state, and depth ordering.
- `build.py`, `render.mjs`: reproducible independent guide generator/rendering.

## Reference and handedness
Inspected the approved `production-v2/shared/upright-open-neutral-v2.png` (512 square) and the provisional `production-v4/calibration-probe-20261029/shared/raw/open-common-rest-v2.png` (1254 square). The latter is NOT accepted as a new endpoint. The schematic uses manually estimated 512-space **skull/body** landmarks (not hair silhouette tracing): head centre about(262,105), shoulders(204,215)/(304,216), pelvis(254,324), lap around y315–335; fixed screen corners follow the current 512-space reference geometry. These are layout proportions, not claimed precision measurements of hidden anatomy.

Handedness is always **picture-right supports, picture-left expresses**. Right wrist stays at(282,307), contacting the near/right base edge. Laptop weight remains on thighs; the right hand stabilizes it, rather than alone suspending the laptop. Left wrist initially(143,319). The screen/base and seated pelvis do not scale or translate. Supporting shoulder/elbow can accommodate trunk motion while the wrist stays registered; freezing the wrist is NOT freezing the whole arm.

## Phrase
- 0–0.45s: shared comfortable rest.
- 0.45–0.65s: chest/shoulder support becomes attentive while **both hand contacts remain**. Right support is established before release.
- 0.65–1.10s: left wrist releases and moves around the exposed screen edge; no teleport to chest height.
- 1.10–1.70s: elbow/wrist arc rises; chest/head follow as one body, small torso extension/forward intent rather than a replacement downward face.
- 1.70–1.90s: short open attention beat, no directional project target.
- 1.90–2.70s: independently specified turn/lower/arrival path, not reversed incoming samples.
- 2.70–2.90s: palm arrives, then resumes support; chest/shoulder unload.
- 2.90–3.20s: tiny lag-marker settling; no final hair/cloth animation claimed.
- 3.20–4.20s: quiet rest, same coordinates as start.

Orange and olive dotted wrist paths distinguish outward and return trajectories. Cyan marks the support chain. The separate side inset documents depth/load intention, not a second character or an anatomical final drawing.

## What is specified vs still unresolved
Numerical layout checks confirm a stationary support wrist/pelvis, consistent schematic arm lengths, and identical resting endpoints. See `layout-validation.json`. This establishes a continuous, reviewable **motion specification**, not an automatic aesthetic pass.

The revised narrow path stays on the **body side** of the screen, never flips a hidden forearm to the front. In screen-local depth coordinates the rigid screen is z=0; shoulder, elbow, wrist and their connecting segments stay z=-12 throughout. The screen hinge is the projected segment (138,303)→(240,307). The palm leaves the lower/base edge, moves below and around the left silhouette, then makes a modest side response; it does not have to cross the screen or rise above it. A single screen-outline mask clips the full upper-arm, forearm, cuff and palm masses, including their thickness. There is no foreground arm override. The revised cuff/palm outlines specify a consistent three-quarter palm rather than an unconstrained wrist dot.

This explicit ordering rules out the earlier behind-elbow/front-forearm discontinuity in this layout. It is not a complete 3D anatomy simulation: screen-relative coordinates are an authoring convention; actual forearm volume, finger wrap at the base, shoulder silhouette, perspective foreshortening and sleeve folds still need rough-drawing review. The side inset marks which side of the screen contains the arm; it is a load/depth diagram, not a precise second-camera anatomical view. Secondary hair/cloth is only a lag marker. The common rest remains proposed, not accepted production art.

PCHIP coordinate curves and a two-segment schematic arm constraint make this internal layout legible. They do not justify interpolating final anime pixels, warping an old face/body, or reusing a bad rig. Before final painting, the layout must be judged at normal speed and revised where the body/hand path is unconvincing. Only then should continuous rough drawings, cleanup/appearance, and later runtime/source/drag closure follow. The five-family design scope is unchanged; this is the common response calibration, not a per-clip user approval gate.

## Narrow art review (2026-10-29, revised low-elbow route)
The art owner inspected rest/approach/peak/return after the screen-ordering and low-elbow corrections. Verdict: this modest side route may proceed to **whole-phrase rough drawing**, not a final animation or character-quality acceptance. The elbow can remain hidden; visibility must not force a raised shoulder/elbow. At peak the left shoulder is(205.75,211), elbow(170.67,276.16), wrist(106,263): wrist above a relaxed low elbow.

Mandatory rough-drawing questions: show whether the resting palm supports the base's lower edge or wraps its side corner; draw finger release, the continuous sleeve volume behind the screen, the palm orientation and return wrist rotation; replace the right wrist contact marker with an actual palm/base contact patch. A fixed coordinate alone does not prove friction or load transfer. These are deliberate next-stage drawing requirements, not solved by the numeric guide.

Final guide MP4 SHA256: `720fda42caddff452090a53313d1dc5ebba8bf67dc9e11f92924303c4aa2d148`. Full decode passed. No final artwork, public resource, runtime or Git changes.
