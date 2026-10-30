# USER_ATTENTION current study candidates — dependency-closed rebuild

Status: authored candidates, not smooth production accepted. Do not treat art review acceptance as runtime authorization or motion-quality acceptance.

Required Python packages: Pillow, NumPy, SciPy. No neural interpolation or video model, no bones. Run from this directory (parent of metadata):

```sh
mkdir -p registered/attention-lift-v1
python register_single_v1.py
python register_attention_sequence_v1.py
python register_attention_sequence_v2.py
python register_permission_v1.py
python register_permission_v2.py
python register_completion_wave_v1.py
python clean_wave_local_alpha_v2.py
```

These scripts rebuild intermediary v1 directories as local build outputs. They need not be committed alongside current v2 frames; v1 scripts remain necessary provenance. Only current `attention-sequence-v2`, `permission-cycle-v2`, and `completion-wave-v2` are selected runtime-study artifacts. GIF/large contact sheets are reproducible previews, not selected repository duplicates.

Shared input: sibling `../shared/seated-open-canonical-alpha-v1.png`, SHA256 `25eead33dd408600be423882ce7921a561b8fdb006642fe6f07b2f8580f65721`. The fixed geometry source `sources/click-open-single-master-v1.png` has SHA256 `390be1c39ac6cf1398492de22bcf3155f4c97cde41271b371a8c44e82f6a307b`. Parent shared artifact is an explicit external dependency of this scoped package, part of the same repository checkpoint.

The baseline's source image chain and prompts are in `shared-canonical-origin.json`; raw click-closed/open sheets and their prompts are included in this selection. Cropping/alpha derivation is reproducible with `extract_keyposes.py` (the fixed top-left 512 square); baseline itself is retained, not regenerated.

Important semantic correction: original baseline has a lowered head but eyes still generally toward user, NOT established reading-screen gaze. Historical attention sequence names saying gaze-screen are descriptive mistakes, not visual evidence. Upcoming READ_SCREEN eyes are owned by observation family; use baseline as seated-open-neutral until explicit gaze asset is connected.

Permission current candidate has short entry + ask + exit; actual wait must not time out into an approval or automatically return. Runtime event/state handling must own hold/exit; long relaxed watching-user hold remains separate ongoing artwork. Completion requires actual success before playing.

Or run `python rebuild_current.py` to create required intermediate directories and run the exact order.
