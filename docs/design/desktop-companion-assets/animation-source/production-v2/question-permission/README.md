# Question / Permission source bundle v2

Portable internally reviewed artwork; runtime integration remains pending. NOT runtime accepted. All references are bundled under `references/`. No old tilted-head fallback is used.

Rebuild (Python + Pillow + NumPy):
```
python process.py
python manifest-build.py
python qa-build.py
python blink-build.py
python wave-build.py
python freeze-source.py
```

`manifest.json` owns poses, genuine key drawing exposures, event guards, entry/return sources. `blink/manifest.json` owns optional eye-only blink; it is NOT a business state and must not emit response/approval events. The still head geometry stays fixed during blinking; use only neutral/listen-rest/permission hold derived from that same head. Never use on nod/turned/leaning artwork. Sparse 4–7 second gaps, 45/75/45ms half/closed/half exposure. Any real event can interrupt it.

`raw/attend.png` is rejected wrong-arm generation. `poses/nod.png` is a retained processing source only, superseded by `nod-soft`; never expose the cold expression as a runtime frame. `nod-soft` uses that genuine pitched-head source with a new image-generated soft expression, and is used only after actual answer/allow. Deny/cancel is neutral.

`listen-rest` is the final event-controlled ATTEND/UNRESOLVED hold: no perpetual pointing or palm demanding a response. ASK/OFFER and the intermediate frames are brief entry gestures. Symbols/cards/locks remain independently code-rendered and are never baked into character art.

QA: sequence contact sheets and exposure GIFs under `qa/`; fixed-region pixel checks in `qa/verification.json` and `blink/manifest.json`. Soft-nod fixed-region checks compare to its exact pitched-head source, while all other fixed-region checks compare to frozen neutral. All reported outside-mask modifications are zero.

Shared local wave extension: `python wave-build.py`, contract `wave/manifest.json`. One actual facing-viewer wave drawing pair serves welcome/tap/completion with separate event semantics; tap is shorter, welcome once, completion strictly real successful receipt. Closed derives from owner rigid mechanical closed-rest, never old static closed. Generated wrong-hand closed attempt retained/rejected. Mechanical lid alpha is honored (transparent pixels contain irrelevant transformed RGB).

## Closed base freeze
The only current closed base is `references/closed-rest-rigid-v2.png`, SHA256 `d029c4fc7e78432f465781669f978c96980e34fce0d9a81756abe3aca35064bb`. This is the parent-reviewed complete hand-matte repair. v1 is retained solely as an exact historical imagegen input; no sequence or rebuild uses it as its base. Closed support fingers retain their complete outline/shadow; no skin-color threshold is applied.
