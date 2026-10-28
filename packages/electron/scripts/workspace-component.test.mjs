import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareWorkspaceComponent } from './prepare-workspace-component.mjs';

const require = createRequire(import.meta.url);
test('optional workspace component page compiles against the actual pinned MSI without installing it', { skip: process.platform !== 'win32' }, async () => {
  await prepareWorkspaceComponent();
  const builder = createRequire(require.resolve('electron-builder'));
  builder('app-builder-lib');
  const library = createRequire(builder.resolve('app-builder-lib'));
  const { getMakeNsisPath } = library('./toolsets/windows');
  const { bundledLanguages } = library('./util/langs');
  const { createAddLangsMacro } = library('./targets/nsis/nsisLang');
  let languageLines;
  createAddLangsMacro({ macro: (_name, lines) => { languageLines = lines; } }, { langs: bundledLanguages });
  const compiler = await getMakeNsisPath();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'varin-workspace-component-'));
  const native = value => value.replaceAll('/', '\\').replaceAll('$', '$$');
  try {
    const output = path.join(temporary, 'component.exe');
    const script = path.join(temporary, 'component.nsi');
    const include = fileURLToPath(new URL('../resources/installer-workspace.nsh', import.meta.url));
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SetCompress off', 'Name "Varin component compile check"',
      `OutFile "${native(output)}"`, '!include "MUI2.nsh"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"', '!include "nsDialogs.nsh"',
      'Var VarinPage', '!macro VarinPageHeader TITLE SUBTITLE', 'nsDialogs::Create 1018', 'Pop $VarinPage', '${NSD_CreateLabel} 0 0 100% 12% "${TITLE}"', 'Pop $0', '!macroend',
      'Function VarinStylePage', 'FunctionEnd', `!include "${native(include)}"`, '!insertmacro VarinWorkspaceFunctions',
      'Page custom VarinWorkspaceCreate VarinWorkspaceLeave', '!insertmacro MUI_PAGE_INSTFILES', 'Section', 'SectionEnd',
      ...languageLines, '',
    ].join('\n'));
    await promisify(execFile)(compiler.path, ['/WX', '/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    assert((await stat(output)).size > 0);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
