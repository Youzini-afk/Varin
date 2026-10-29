# Captain fit coverage audit

- Protocol AgentAvatarId values: **64**.
- Actual artwork entries: **64**.
- Named primitive body families: **64**; distinct body path geometries: **64**.
- Distinct body + accent composite geometries: **64** (7 entries include a separate accent shape).
- Authored and demonstrated fit profiles: **4**. Remaining **60** are **not fixed, not covered and must not receive a generic costume fallback**.

The four profiles are `ribbon-blue`, `scoop-pistachio`, `lens-lilac`, `overlap-coral`. Parent approved this static repair direction; user-facing shape approval and production eligibility remain separate. The clean board demonstrates these four only.

There are currently **no identical composite-geometry groups** to extend coverage automatically. Similar visual families (rounded, pointed, layered) are not interchangeable garment geometry. Future geometry-identical color/identity variants may reuse a profile only when both body and accent paths are identical, with saved face/color preserved and face/cloth overlap rechecked.

The prototype explicitly throws for every other ID. A future renderer should keep an unreviewed identity uncostumed (or use a separately approved non-body role marker), not silently apply this four-example cape. No such production fallback has been implemented here.

## Complete catalog

| Avatar ID | Body family | Fit coverage |
|---|---|---|
| slope-lilac | slope | unreviewed |
| dome-ivory | dome | unreviewed |
| taper-sage | taper | unreviewed |
| pebble-blue | pebble | unreviewed |
| overlap-coral | overlap | explicit profile |
| notch-ochre | notch | unreviewed |
| slant-mint | slant | unreviewed |
| round-lilac | round | unreviewed |
| tile-blue | tile | unreviewed |
| fold-sage | fold | unreviewed |
| cap-coral | cap | unreviewed |
| wave-ivory | wave | unreviewed |
| capsule-sky | capsule | unreviewed |
| pillar-lilac | pillar | unreviewed |
| lozenge-mint | lozenge | unreviewed |
| wedge-apricot | wedge | unreviewed |
| arch-butter | arch | unreviewed |
| oval-rose | oval | unreviewed |
| squircle-periwinkle | squircle | unreviewed |
| shield-sage | shield | unreviewed |
| sail-ivory | sail | unreviewed |
| lean-coral | lean | unreviewed |
| bridge-aqua | bridge | unreviewed |
| crest-lilac | crest | unreviewed |
| step-blue | step | unreviewed |
| offset-peach | offset | unreviewed |
| orbit-sage | orbit | unreviewed |
| cushion-ochre | cushion | unreviewed |
| curve-mint | curve | unreviewed |
| bevel-rose | bevel | unreviewed |
| drift-blue | drift | unreviewed |
| stack-ivory | stack | unreviewed |
| tilt-pistachio | tilt | unreviewed |
| fan-coral | fan | unreviewed |
| mound-lavender | mound | unreviewed |
| tab-butter | tab | unreviewed |
| span-jade | span | unreviewed |
| ripple-peach | ripple | unreviewed |
| facet-blue | facet | unreviewed |
| comma-lilac | comma | unreviewed |
| inset-sage | inset | unreviewed |
| pocket-rose | pocket | unreviewed |
| rise-ivory | rise | unreviewed |
| sweep-aqua | sweep | unreviewed |
| bend-ochre | bend | unreviewed |
| twin-periwinkle | twin | unreviewed |
| arc-apricot | arc | unreviewed |
| tuck-jade | tuck | unreviewed |
| plate-lavender | plate | unreviewed |
| drop-melon | drop | unreviewed |
| ribbon-blue | ribbon | explicit profile |
| cove-sage | cove | unreviewed |
| terrace-ivory | terrace | unreviewed |
| slide-rose | slide | unreviewed |
| ramp-mint | ramp | unreviewed |
| echo-ochre | echo | unreviewed |
| lens-lilac | lens | explicit profile |
| ledge-aqua | ledge | unreviewed |
| swell-apricot | swell | unreviewed |
| parcel-periwinkle | parcel | unreviewed |
| scoop-pistachio | scoop | explicit profile |
| beam-coral | beam | unreviewed |
| chamfer-jade | chamfer | unreviewed |
| float-butter | float | unreviewed |

Recompute with `node audit-coverage.mjs [repo-root]`. Machine-readable geometry hashes and exact source SHA are in `coverage-audit.json`.
