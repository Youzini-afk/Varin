# External product marks

These bundled marks identify the actual execution product, not a model provider or a task role.
`HarnessIcon` consumes the existing harness and configuration/profile identity. A custom display name
must never select a brand. Marks remain the property of their respective owners; use does not imply
endorsement. Sources checked 2026-11-15.

| File | Official source / permission | Presentation |
| --- | --- | --- |
| `codex.svg` | [OpenAI's AGENTS.md project](https://github.com/agentsmd/agents.md/blob/main/public/logos/codex.svg), MIT, Copyright (c) 2025 OpenAI | Unchanged dedicated Codex mark; monochrome, inverted only in dark theme. |
| `pi.svg` | [Pi website](https://github.com/earendil-works/pi-website/blob/main/src/logo.svg), MIT, Copyright (c) 2026 Earendil Inc. and contributors | Official outline unchanged; viewBox cropped from `0 0 800 800` to `140 140 520 520` to remove artboard whitespace in small slots. White paths invert only in light theme. |
| `opencode.svg` | [OpenCode Mark](https://github.com/anomalyco/opencode/blob/dev/packages/ui/src/components/logo.tsx), MIT, Copyright (c) 2025 opencode | Standalone extraction of the official Mark paths/viewBox. Theme variables resolved to black and gray; dark theme inverts this monochrome mark. |
| `gemini.png` | [Gemini CLI IDE companion](https://github.com/google-gemini/gemini-cli/blob/main/packages/vscode-ide-companion/assets/icon.png), Apache-2.0 | Unchanged official PNG, also published at `https://geminicli.com/icon.png`; original color in both themes. |
| `kimi.png` | [Kimi Code CLI](https://github.com/MoonshotAI/kimi-cli/blob/main/web/public/logo.png), Apache-2.0, Copyright 2025 Moonshot AI | Unchanged official PNG; original colors in both themes. |
| `cursor.svg`, `cursor-dark.svg` | [Cursor brand guidelines and download](https://cursor.com/brand), Anysphere, Inc.; provided to represent Cursor | Unchanged `CUBE_2D_LIGHT.svg` and `CUBE_2D_DARK.svg` from the official brand ZIP. Use the supplied theme variant, not color inversion. |

Claude Code reuses `../provider-logos/claude.svg`, the already-attributed LobeHub MIT SVG of the Claude
mark. No fonts are used to approximate a product logo. No downloaded code or scripts are executed.
All SVGs are local drawing-only resources, with no script, event handler, external reference or embedded
image. PNGs retain the official source bytes.

The original MIT/Apache license texts are shipped in `packages/web/public/licenses` as
`agentsmd-LICENSE.txt`, `pi-website-LICENSE.txt`, `opencode-LICENSE.txt`, `gemini-cli-LICENSE.txt`,
`kimi-LICENSE.txt`, and `lobe-icons-LICENSE.txt`; Kimi's upstream `NOTICE` is preserved as
`kimi-NOTICE.txt`. The root `THIRD_PARTY_NOTICES.md` links this inventory.


## Additional product marks

### Codeg product marks

These SVGs are unchanged copies of
[docs/images/agents/](https://github.com/spacering-net/codeg/tree/4991406e6/docs/images/agents)
in Codeg (reference commit `4991406e6`, Apache-2.0).
The source license is shipped in `packages/web/public/licenses/codeg-LICENSE.txt`.
These marks are used by the product catalogue and conversation `HarnessIcon`
(`packages/ui/src/components/thread/HarnessIcon.tsx`).
Product names and marks belong to their respective owners and do not imply endorsement.

Upstream [Codeg agent-icon.tsx](https://github.com/spacering-net/codeg/blob/4991406e6/src/components/agent-icon.tsx)
records additional mark provenance:
Antigravity and Qoder from the ACP registry; Kiro from kiro.dev/icon.svg;
ZCode from zai-org/ZCode; Command Code from its published extension icon;
TRAE from LobeHub's MIT icon set, whose license is shipped in `packages/web/public/licenses/lobe-icons-LICENSE.txt`.
Existing Varin marks keep their original notices in `packages/ui/src/assets/harness-logos/README.md`.

Theme variants are preserved unchanged.
