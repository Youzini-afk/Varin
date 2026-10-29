# Captain role: 64 silhouette role library

The user approved the role/color direction and requested all64 library assets plus commit/push at12:33:23 on2026-10-29 (Sentinel_96f16eacf2e08191b8a0642d48423765). Parent reviewed the all64 contact sheet and four-color comparison statically. This archive does not modify runtime, global avatar settings, or the historical four-profile checkpoint. Static approval is NOT animation/native acceptance; the complete director scene remains separate work.

## Coverage and depth

64 existing AgentAvatarIds have 64 explicit profile entries. There is no generic fallback: an unknown ID throws. The original avatar body/accent/face paths are reused, not redrawn. Garment depth is back cape + inset lining → original body clipped only behind its fitted collar seam → front ivory collar → hollow gold clasp → pinned folio. Geometry for ribbon-blue, scoop-pistachio, lens-lilac and overlap-coral remains identical to the reviewed four-profile source.

The other60 profiles derive shoulder contacts and lower neckline limits from the actual composite silhouette at4× raster resolution. Fifteen shape exceptions account for narrow/low/asymmetric/compound bodies; curve-mint and fold-sage additionally have authored smooth neckline overrides instead of pixel-following kinks. See derivation-audit.json and authored-overrides.json. Derivation is an authoring step, not a runtime generic costume algorithm.

## Identity-linked lining update

User requested that only the two lower diamond-like purple lining panels follow the avatar's color. The updated renderer uses78% existing avatar primary color plus22% ivory #fffaf0. Dark cape, ivory collar, gold clasp, folio, original eyes/body and every geometry coordinate remain unchanged. The original four checkpoint is deliberately not overwritten.

- lining-color-four-comparison.png: clear before/after four-avatar comparison, plus actual24/32/48px.
- all64-contact-sheet.png: original child → fitted captain overview.
- native-sizes-1.png through native-sizes-4.png: all64 at actual24/32/48px.
- exception-closeups.png: internal seam audit (not user-facing).

## Verification

All overview, four native-size sheets and exception closeups were visually inspected during fitting. Updated identity-colored overview and all four native-size sheets were inspected again. The garment remains secondary at24px; folio details intentionally simplify at this size rather than adding more strokes.

geometry-validation.json:64/64 unchanged face ROI, zero border-alpha clipping, unknown avatar rejection. This is a sparse sanity check, not a claim of exhaustive perceptual validation.

palette-validation.json:64/64 old/new pixel changes confined to the paired lining mask; zero changed pixels outside. Lowest lining/dark-cape contrast4.45:1. This contrast is material separation, not a text accessibility claim. Pale ivory and butter variants retain the navy boundary.

## Reproduction

Run from this folder with Node24 and the repository's installed sharp dependency:

1. `node derive-profiles.mjs` (authoring regeneration; uses the frozen four source plus explicit overrides)
2. `node render-audit.mjs`
3. `node palette-comparison.mjs`
4. `node verify-palette.mjs`

Scripts accept the repository path as first argument where relevant; default is resolved relative to this archive in the repository. avatar-art.mjs is a generated exact TS-stripped source dependency, not new artwork. Source SHA and geometry measurements are recorded in derivation-audit.json. No imagegen was used for these fits or palette edits. The earlier imagegen concept is a design reference only, never an identity/face source.


## Consumption and rebuilding

`identity-map.json` maps all64 original AvatarIds directly to `svg/<avatarId>.svg`. These80×80 SVG assets are the project-lead role presentation only; child sprites continue using their existing identity art. `render-role.mjs` is a finite local ES module with no Node, filesystem, network or sharp imports. It imports the explicit profiles JSON and exact stripped original avatar-art module. Exports: `fitted(id,x=0,y=0,size=80)` returns nested SVG markup; `captainLiningColor(id)` returns the coordinated lining color; `FITTED_AVATAR_IDS` is the complete allowlist. Reject unknown IDs before rendering; callers must constrain layout numeric inputs. The legacy lining option exists only for the comparison board, not intended as runtime preference.

`node build-library.mjs` regenerates64 standalone SVGs, ID mapping and library-validation.json from the checked-in profiles. The checked-in `avatar-art.mjs` is an exact stripped snapshot of the existing identity library, whose original source SHA is recorded; it is not a new face design. `derive-profiles.mjs` optionally regenerates the authoring profiles from repository source and preserved historical four; do not run it merely to consume assets. `node render-audit.mjs`, `node palette-comparison.mjs`, `node verify-palette.mjs` reproduce review evidence using the repository sharp dependency. No external downloads or imagegen calls are needed.

`manifest.json` freezes file sizes and SHA256 hashes; manifest itself is excluded from its file list. Four historical fit files remain unchanged in director-role-concepts/fit-repair. Full64 authored exceptions and source/provenance evidence are retained here.
