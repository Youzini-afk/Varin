# Desktop Companion Animation Tooling

Offline Python/Pillow pipeline for packing authored full-frame sprite sequences into PNG atlases and building review/candidate bundles for the Electron desktop companion. This tool never generates in-between frames, binds rigs, or modifies runtime business state.

Source artwork lives in the sibling repository [Varin-companion-assets](https://github.com/Youzini-afk/Varin-companion-assets) (`../Varin-companion-assets` or `VARIN_COMPANION_ASSETS`). Published selected packs write to `packages/web/public/companion-assets/`; see [packages/electron/README.md](../../packages/electron/README.md#optional-desktop-companions) for locking and release delivery.

## Core Packing & Review Commands

Requires Python 3.10+ and Pillow.

```sh
# Pack a single sequence.source.json into PNG atlas + sequence.json (crops transparent margins, never resizes)
python tools/desktop-companion-animation/pack_sequence.py path/to/sequence.source.json path/to/output

# Generate standalone HTML review player (--stage keyposes | motion-candidate)
python tools/desktop-companion-animation/make_review.py path/to/output/sequence.json path/to/review.html --stage keyposes

# Render review MP4 with burned stage labels & exact ms timestamps
python tools/desktop-companion-animation/render_review_video.py path/to/output/sequence.json review.mp4 --stage keyposes

# Build catalog-wide coverage & pose-bridge diagnostic page (32 intents in coverage.json)
python tools/desktop-companion-animation/make_catalog_review.py review.html \
  --asset completion=path/to/completion/sequence.json
```

Key authored contracts:
- `sequence.source.json` specifies `canvas`, `entryPose`, `exitPose`, optional `loop: [start, endExclusive]`, and per-frame `durationMs`, `offset`, `phase`, `pose`, `contacts`, `exitTo`.
- Pose names and `geometryReference` hashes represent real visual alignment on the registered canvas; bridges (`kind: "bridge"`) must be authored frames, never alpha cross-fades.

## Opt-In Electron Review Consumer

Launch Electron dev with `VARIN_COMPANION_REVIEW=1` to open the standalone `companion.html` review window (excluded from packaged builds and main-window focus/geometry). Select an existing thread/branch to observe `ThreadProjection` read-only, or pick a local `sequence.json` + PNG pages via browser file handles to inspect playback.

Focused tests: `cd packages/ui && bunx vitest run src/components/companion/companion.test.ts`.

## v5 Explicit Baseline Build & Selection

Build the portable v5 candidate bundle from `Varin-companion-assets` (~178 MiB fresh build; deterministic with Python 3.12 / Pillow 12.3.0):

```sh
python tools/desktop-companion-animation/build_interaction_expansion.py \
  --baseline-manifest ../Varin-companion-assets/source/animation-source/production-v5/runtime-baseline.json \
  --output /tmp/varin-v5-candidate
```

- **Seated foreground prep (`--prepare-seated`)**: Scales 1254×1254 RGBA seated foregrounds to 512×512 over the frozen `world-stool-grounded-v4.png` and records counterpart SHAs in `detached-index.json`.
- **Manifest rules**: `--baseline-manifest` compiles an explicit self-contained bundle (`canvas: [512, 512]`, `canonicalSources`, `worldStool`, `sequences`, `nodes` with complete ordered `grabNext`/`releaseNext` lists, `counterparts`, and `endpoints` for open/closed lids). Output always stays `candidateOnly` until explicitly selected.
- **Isolated selection**:
  ```sh
  python tools/desktop-companion-animation/select_interaction_bundle.py \
    /tmp/candidate/bundle.json /tmp/selected-proposal \
    --explicit-baseline ../Varin-companion-assets/source/animation-source/production-v5/runtime-baseline.json \
    --build-receipt /tmp/candidate/build-receipt.json \
    --rebuild-receipt /tmp/candidate-prepared/rebuild-receipt.json \
    --review-record /tmp/exact-artifact-review.json
  ```
- **Regression checks**:
  - `python tools/desktop-companion-animation/test_prepare_seated.py`
  - `python tools/desktop-companion-animation/test_explicit_baseline.py`
  - `python tools/desktop-companion-animation/test_pack_sequence.py`
  - `node tools/desktop-companion-animation/check_completion_routes.mjs` (verifies all v5 playback/pickup/recovery routes against the real player package)
