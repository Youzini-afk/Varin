# Editing / dispatch — portable source candidate

Latest source candidate: editing 20 timed exposures; collaboration 15. Source stage preservation is not complete runtime acceptance. No new image generation is required to rebuild.

Run `python scripts/rebuild.py` after installing `requirements.txt`. All inputs live under this directory: references, raw, clean, masks, exactprompts, frames, scripts, qa, and JSON manifests. No external anchor directory or private path is needed.

`sequence-manifest.json` contains per-exposure PNG SHA, hold, cue, entry/exit and geometry reference. Engineering public poses: editing open-screen → open-screen; dispatch open-user → open-screen. Directions are viewer coordinates: DISPATCH_A right; DISPATCH_B inner-left; GAZE_A right; GAZE_B_TRANSIT inner-left.

Typing enters forward posture once. The repeating A/B pair is type-forward / type-forward-hands-b: identical non-hand pixels, independently drawn fingers/wrists. Use type-prepare only for entry/exit, not to simulate keypresses. Dispatch episode is one-shot; sustain WATCH/read/work, never repeated waving.

## Superseded trials — single authoritative exclusion note
The original head-bobbing 18-exposure editing preview is superseded and intentionally excluded from this portable bundle. Original outputs remain untouched in their original archive. Never alternate type-prepare and type-forward within a typing burst. Raw dispatch-b swapped hands and is retained only as generation history, never consumed. review-v2 is preparatory/return hover, not the editing review peak; review is the short chin-touch thinking peak.

The immutable screen panel is excluded from registration masks. Lower body/boots remain anchor pixels; forward upper anatomy is genuinely drawn, not mechanically transformed. `typing-exposure-provenance.json` proves non-hand lock. `generation-provenance.json` retains raw/input lineage and exact prompts. PNG and timed-exposure independent rebuild verification is in `portable-verification.json`.
