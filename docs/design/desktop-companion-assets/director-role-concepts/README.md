# Varin director / project captain — archived design candidate

**Current status: the generated figure-1 capelet direction was endorsed by the user at 2026-10-29 11:42:38 UTC; the figure-2 generic vector clothing fit was rejected. Corrected per-identity shape-fit remains a candidate pending review, not a runtime sprite.** The generated captain exploration and variant comparison were delivered by the parent assistant on 2026-10-29 at approximately 11:35 UTC (message `Sentinel_2e3872ebe3888191a4b2d6bf053362e7`). At that delivery moment approval had not yet been received; the later direction endorsement and fit rejection are recorded below.

`generated-captain-concept.png` is built-in image-generation exploration from `lead-variants.png`, using the exact `generated-captain-prompt.txt`. It explores cape fabric, collar and clasp; generated lavender/coral eye details visibly deviate from the saved avatar paths. **Never extract those generated faces as replacement identity art.** Production, if approved, must reuse the exact existing AgentAvatar paths and apply a separate role wrapper. See `archive-manifest.json` for hashes and generation provenance.


## Recommendation

**A / 领航短披肩**. The main agent is the project's working captain, not a second executive. Keep its saved AgentAvatar silhouette, color, eyes and accent paths; add a short double-shoulder capelet, ivory collar, hollow-diamond clasp and small document tag. A tiny asymmetric cape tail gives a single finite dispatch accent. Children keep the uncostumed existing avatar.

The distinction remains visible at equal 24px size: the captain has a clear shoulder/base silhouette and a document-carrying role; a child remains an unadorned light spirit. Size or color is not the sole rank marker. No crown, face replacement, humanoid redesign or automatic global avatar update.

Historical alternatives compared (B/C are not current recommendations):
- **B / 侧系派遣带**: suitable as a temporary courier accessory. The side folio and tail lose clarity at 24px; weaker permanent role marker.
- **C / 项目工装襟**: readable but too administrative/formal. Risks making every main agent another secretary/manager.

## Role hierarchy

1. **Varin**: overall executive director / personal secretary. Receives accepted projects, reviews briefings, assigns/follows up, forwards decisions, receives scoped reports.
2. **Project folder + captain**: one actual thread/branch project; main identity resolves with `agentAvatarForIdentity(branch.threadId, branch.avatar)`. Current run determines activity, not the existence of a new child execution. An idle project can retain a static responsible avatar without pretending it is working.
3. **Child squad**: exact existing child avatars, connected to their actual project lead through parent branch/execution relations.

Two or three project docks retain their positions. Rapid tool changes belong inside the relevant folder/lead's small detail, not in Varin's whole-body action. A selected project expands inspection, not a role transfer into Varin. A's current-run result does not finish B; B permission and C question remain separately identified packets, not a global lock.

## Current shape-fit repair

User feedback: “嗯图1不错，图2的你放在一起反而穿模了” (`Sentinel_7bba8eec8afc8191ab32fdf574768dd7`). Keep `lead-variants.png` byte-identical as the historical image-generation input and rejected generic-fit record; do not silently overwrite it.

The repair is in [fit-repair/README.md](fit-repair/README.md). Parent has accepted the static fit direction. The clean user-facing comparison is [main-agent-captain-family-clean.png](fit-repair/main-agent-captain-family-clean.png); audit overlays remain separate. Coverage is explicitly 4 of 64 unique shapes, not a whole-library fix. Four actual saved avatar silhouettes now have individually authored shoulder/neckline/garment profiles. No more clothing animation or runtime promotion until shape-fit review passes.

## Prior layout and motion concepts

The earlier storyboards/HTML below retain the **rejected generic clothing fit** for history and management-layout discussion only. They are not the current captain-fit recommendation. `director-five-scenes.png` likewise documents role/layout semantics, not approved fitted clothing. The corrected static A-family takes priority over these old motion prototypes.


- `lead-variants.png`: three thoughtful alternatives beside unchanged child art.
- `recommended-family.png`: four existing identities, child vs captain at literal 24/32/48px.
- `director-storyboards.png`: four 360px compositions: portfolio; assign captain then child squad; receive one current-run result; forward B approval and C question separately.
- `motion-concepts.html`: locally browser-playable **design concept**, four side-by-side vignettes, pause control. 700ms anticipation, 1900ms finite travel, 2400ms quiet hold before presentation-loop reset. No encoder needed.
- `motion-sequence-proof.png`: 12 frames from executing the actual embedded HTML animation script with deterministic clock.
- `motion-validation.json`: validation details.

Character plates are exact existing approved selected-bundle exposures (dispatch / understood / permission), not newly authored director choreography. The motion concept animates role accessories, packets and squad trajectories; final body-management actions still need the runtime/art integration pass. All project labels/events are explicitly illustrative.

## Implementation boundary

This directory is a **prototype only**. No production renderer, runtime, protocol, observer, native geometry, saved avatar or global app avatar was changed for this role redesign. `design.mjs` directly consumes the repository's `agent-avatar-art.ts`; the build temporarily strips TypeScript for Node import and then deletes that cache. The archived `plates/` files are exact selected-bundle frame composites used by the compact motion HTML; no full atlas or runtime bundle is duplicated.

Rebuild boards with `node design.mjs [repo-root]`; validate the embedded motion script with `node verify-motion.mjs [repo-root]`. Relative defaults resolve this repository. No browser service or image-generation call is needed to reproduce the vector boards. Reproducing the generated exploration image itself requires a separate generation request; the saved prompt is provenance, not a deterministic raster build.

Before promotion, integrate the portfolio/attention contract and project lead identity mapping; retain read-only lifecycle, missing-count neutral withdrawal, quiet stable slots, reduced motion and independent real pending decisions. Do not resume the earlier “every project tool drives Varin's personal tool action” model.

The result vignette uses “本轮结果”, not a claim that a report file/artifact exists. “报告/文件已收到” requires an actual corresponding artifact fact; ordinary Run completion alone does not prove that.
