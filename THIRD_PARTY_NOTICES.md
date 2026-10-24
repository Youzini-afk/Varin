# Third-party notices

Varin as a combined work is licensed under `AGPL-3.0-only`. The notices below apply to incorporated
upstream portions and do not make Varin as a whole available under the MIT License. Dependencies,
fonts, icons, and other separately distributed components remain under the licenses shipped with
their respective packages or source files.

## OpenChamber-derived product code

Portions of Varin are derived from OpenChamber material carrying these notices:

Copyright (c) 2025 Bohdan Triapitsyn

Copyright (c) 2024 OpenChamber contributors

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Open Computer Use platform drivers

The Windows and Linux runtime files in `packages/computer-driver` incorporate
portions of [open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use),
baseline `51f3a59`, modified for Varin's resident driver protocol and input handling.

MIT License

Copyright (c) 2026 Leo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## noVNC desktop viewer

The browser desktop viewer bundles noVNC 1.7.0 core JavaScript, Copyright
(C) 2022 the noVNC authors, under MPL-2.0. Its upstream notice is distributed
at `packages/web/public/licenses/novnc-LICENSE.txt`; the corresponding source is
available from the pinned `@novnc/novnc` dependency and
[noVNC upstream](https://github.com/novnc/noVNC/tree/v1.7.0).

Desktop artifact downloads use `@noble/hashes` 2.4.0 to verify SHA-256
before saving. Its MIT license is distributed at
`packages/web/public/licenses/noble-hashes-LICENSE.txt`.

Interactive content module imports use `es-module-lexer` 2.3.2, Copyright
(C) 2018-2022 Guy Bedford, under the MIT License. Its license is distributed at
`packages/web/public/licenses/es-module-lexer-LICENSE.txt`.

## TypeScript language service

Varin's first-party TypeScript/JavaScript language extension distributes
`typescript-language-server` 5.3.0 and TypeScript 5.9.3 as immutable runtime assets. Their complete
MIT/Apache-2.0 licenses and TypeScript third-party notice are stored alongside those assets in every
distribution artifact.

## Monaco Editor

Varin's desktop/Web file-editor runtime incorporates Monaco Editor.

Copyright (c) Microsoft Corporation.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Office format libraries and embedded browser automation

Office file creation uses `docx` (Copyright 2016 Dolan), `exceljs` (Copyright
2014–2019 Guyon Roche) and `pptxgenjs` (Copyright 2015–2022 Brent Ely), under
the MIT License. OOXML structure editing uses `@xmldom/xmldom`, Copyright
2012–2017 @jindw and 2019–present Christopher J. Brody and contributors,
also under the MIT License. Their unchanged license texts are distributed
in `packages/web/public/licenses/{docx,exceljs,pptxgenjs,xmldom}-LICENSE.txt`.

The embedded browser uses `puppeteer-core`, Copyright 2017 Google Inc.,
under Apache-2.0. `packages/electron/browser-transport.ts` adapts Puppeteer's
ExtensionTransport (Copyright 2024 Google Inc.) to Electron's debugger
transport and restricts its connection to the owned page. The full license
is distributed in `packages/web/public/licenses/puppeteer-LICENSE.txt`.
Puppeteer connects to Electron's existing Chromium; no additional browser
distribution is bundled by this integration.

## models.dev metadata and model brand icons

The bundled `deepseek.svg` in `packages/ui/src/assets/provider-logos` comes from
[models.dev](https://github.com/anomalyco/models.dev/blob/dev/logos/deepseek.svg),
Copyright (c) 2025 models.dev, under the MIT License. The bundled `claude.svg` and
`qwen.svg` come from [LobeHub icons](https://github.com/lobehub/lobe-icons),
Copyright (c) 2023 LobeHub, under the MIT License. The unchanged license texts are
distributed at `packages/web/public/licenses/models-dev-LICENSE.txt` and
`packages/web/public/licenses/lobe-icons-LICENSE.txt`. Brand marks identify model
families and do not imply endorsement. Model-family matching is original Varin code.

`packages/web/application-host/lib/models/directory-snapshot.ts` also bundles model metadata from
[models.dev](https://github.com/anomalyco/models.dev), under the same MIT License. Its public model
list snapshots come from the documented OpenCode, Command Code and Cline model-directory APIs.
The runtime normalizes this data with Varin's own installed protocol and channel implementations.

## Pi model metadata and account protocols

The curated model presets and device authorization integrations in
`packages/web/application-host/lib/models`, and Copilot request-header handling in
`kernel/crates/varin-runtime/src/providers`, adapt portions of
[Pi](https://github.com/earendil-works/pi), revision
`698a2d23b86a5045dd54554354a5e0cb7e466795`.

Copyright (c) 2025 Mario Zechner

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
