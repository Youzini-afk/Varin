import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareWorkspaceComponent } from './prepare-workspace-component.mjs';

const require = createRequire(import.meta.url);
test('workspace page compiles in every installer language and reads real child exit codes without installing WinFsp', { skip: process.platform !== 'win32' }, async () => {
  await prepareWorkspaceComponent();
  const builder = createRequire(require.resolve('electron-builder'));
  builder('app-builder-lib');
  const library = createRequire(builder.resolve('app-builder-lib'));
  const { getMakeNsisPath, getNsisPluginsPath } = library('./toolsets/windows');
  const { bundledLanguages } = library('./util/langs');
  const { createAddLangsMacro } = library('./targets/nsis/nsisLang');
  let languageLines;
  createAddLangsMacro({ macro: (_name, lines) => { languageLines = lines; } }, { langs: bundledLanguages });
  const compiler = await getMakeNsisPath();
  const pluginDirectory = path.join(await getNsisPluginsPath(), 'x86-unicode');
  const includeDirectory = path.join(path.dirname(builder.resolve('app-builder-lib/package.json')), 'templates/nsis/include');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'varin-workspace-component-'));
  const native = value => value.replaceAll('/', '\\').replaceAll('$', '$$');
  try {
    const output = path.join(temporary, 'component.exe');
    const script = path.join(temporary, 'component.nsi');
    const childScript = path.join(temporary, 'receipt-child.nsi');
    const child = path.join(temporary, 'receipt-child.exe');
    const receipt = path.join(temporary, 'receipt.txt');
    const include = fileURLToPath(new URL('../resources/installer-workspace.nsh', import.meta.url));
    const exec = promisify(execFile);
    const compile = source => exec(compiler.path, ['/WX', '/V2', source], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    // This child only returns its argument as an exit code. It installs nothing.
    await writeFile(childScript, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      'Name "Workspace receipt child"', `OutFile "${native(child)}"`, '!include "FileFunc.nsh"',
      'Section', '${GetParameters} $0', 'SetErrorLevel $0', 'SectionEnd', '',
    ].join('\n'));
    await compile(childScript);
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off', 'Name "Varin component compile check"',
      `!addincludedir "${native(includeDirectory)}"`, `!addplugindir /x86-unicode "${native(pluginDirectory)}"`,
      `OutFile "${native(output)}"`, '!include "MUI2.nsh"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"', '!include "nsDialogs.nsh"',
      'Var VarinPage', '!macro VarinPageHeader TITLE SUBTITLE', 'nsDialogs::Create 1018', 'Pop $VarinPage', '${NSD_CreateLabel} 0 0 100% 12% "${TITLE}"', 'Pop $0', '!macroend',
      'Function VarinStylePage', 'FunctionEnd', `!include "${native(include)}"`, '!insertmacro VarinWorkspaceFunctions',
      'Page custom VarinWorkspaceCreate VarinWorkspaceLeave', '!insertmacro MUI_PAGE_INSTFILES', 'Section',
      `FileOpen $9 "${native(receipt)}" w`,
      'StrCpy $R0 "preserved-0"', 'StrCpy $R1 "preserved-1"',
      ...[0, 3010, 1603].flatMap(code => [
        `!insertmacro VarinWorkspaceExec $VarinWorkspaceResult "${native(child)}" "open" "${code}"`,
        'FileWriteUTF16LE $9 "$VarinWorkspaceResult$\\r$\\n"',
      ]),
      'FileWriteUTF16LE $9 "$R0$\\r$\\n$R1$\\r$\\n"',
      'FileClose $9', 'SectionEnd',
      ...languageLines, '',
    ].join('\n'));
    await compile(script);
    assert((await stat(output)).size > 0);
    await exec(output, [], { cwd: temporary, windowsHide: true });
    const lines = (await readFile(receipt, 'utf16le')).trimEnd().split('\r\n');
    assert.deepEqual(lines.slice(0, 3), ['0', '3010', '1603']);
    assert.deepEqual(lines.slice(3), ['preserved-0', 'preserved-1']);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
