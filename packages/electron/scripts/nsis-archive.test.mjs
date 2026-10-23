import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
builderRequire('app-builder-lib');
const library = createRequire(builderRequire.resolve('app-builder-lib'));
const { NsisTarget } = library('./targets/nsis/NsisTarget');
const { createBlockmap } = library('./targets/differentialUpdateInfoBuilder');
const { getPath7za } = library('./toolsets/7zip');
const { getMakeNsisPath, getNsisPluginsPath } = library('./toolsets/windows');
const { NsisScriptGenerator } = library('./targets/nsis/nsisScriptGenerator');
const exec = promisify(execFile);
const configuration = require('../package.json').build;
const resources = fileURLToPath(new URL('../resources/', import.meta.url));
const extractorInclude = path.join(resources, 'installer-extract.nsh');
const builderRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
const nsisPath = (value) => value.replaceAll('/', '\\').replace(/\$/g, () => '$$');

test('install locations preserve drive roots instead of using the installer working directory', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-install-directory-'));
  try {
    const cases = [
      ['C:\\', 'C:\\Varin'],
      ['D:\\', 'D:\\Varin'],
      ['D:', 'D:\\Varin'],
      ['D:\\Apps\\', 'D:\\Apps\\Varin'],
      ['D:\\Apps\\Varin\\', 'D:\\Apps\\Varin'],
      ['D:\\中文 工作\\', 'D:\\中文 工作\\Varin'],
      ['\\\\server\\share\\', '\\\\server\\share\\Varin'],
    ];
    const script = path.join(root, 'directories.nsi');
    const program = path.join(root, 'directories.exe');
    const output = path.join(root, 'locations.txt');
    const freshParent = path.join(root, '尚未创建的安装目录');
    const icon = path.join(resources, 'icons/icon.ico');
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      'Name "Varin install directory regression"', `OutFile "${nsisPath(program)}"`,
      '!define PRODUCT_FILENAME "Varin"', 'Var VarinDesiredDirectory',
      `!include "${nsisPath(path.join(resources, 'installer-directory.nsh'))}"`,
      '!insertmacro VarinDirectoryFunctions', 'Section',
      `FileOpen $9 "${nsisPath(output)}" w`,
      ...cases.flatMap(([input]) => [
        `StrCpy $VarinDesiredDirectory "${nsisPath(input)}"`,
        'Call VarinResolveInstallDirectory',
        'FileWriteUTF16LE $9 "$INSTDIR$\\r$\\n"',
      ]),
      'FileClose $9',
      `StrCpy $VarinDesiredDirectory "${nsisPath(freshParent)}"`,
      'Call VarinResolveInstallDirectory',
      'IfErrors 0 +3', 'SetErrorLevel 1', 'Quit',
      'SetOutPath $INSTDIR',
      `File /oname=uninstallerIcon.ico "${nsisPath(icon)}"`,
      'SectionEnd',
    ].join('\n'));
    const compiler = await getMakeNsisPath();
    await exec(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    // Write the first installer asset only inside this test's temporary directory.
    await exec(program, [], { cwd: root, windowsHide: true });
    assert.deepEqual((await readFile(output, 'utf16le')).trimEnd().split('\r\n'), cases.map(([, expected]) => expected));
    assert.deepEqual(await readFile(path.join(freshParent, 'Varin/uninstallerIcon.ico')), await readFile(icon));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function buildArchive(root) {
  const source = path.join(root, 'app');
  const deepPath = 'resources/app.asar.unpacked/node_modules/@varin/extension-builtins/dist/builtin-packages/language-servers/runtime/dist/typeshed-fallback/stubs/oauthlib/oauthlib/oauth2/rfc6749/grant_types/resource_owner_password_credentials.pyi';
  await mkdir(path.dirname(path.join(source, deepPath)), { recursive: true });
  await writeFile(path.join(source, deepPath), 'runtime type library');
  await writeFile(path.join(source, '中文 file.txt'), 'Unicode filename and contents');
  const events = [];
  const packager = {
    config: { nsis: configuration.nsis },
    compression: 'normal',
    appInfo: { sanitizedName: 'varin-archive-test', version: '1.0.0' },
    info: { metadata: {}, emitArtifactBuildCompleted: async (event) => events.push(event) },
  };
  const target = new NsisTarget(packager, root, 'nsis', { refCount: 0 });
  const result = await target.buildAppPackage(source, 1);
  return { target, result, packager, events, deepPath };
}

test('the installer retains 7z compression and differential blockmaps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-nsis-archive-'));
  try {
    const { target, result, packager, events } = await buildArchive(root);
    assert.equal(target.isBuildDifferentialAware, true);
    assert.equal(path.extname(result.path), '.7z');
    assert.equal((await readFile(result.path)).subarray(0, 6).toString('hex'), '377abcaf271c');
    const unpacked = path.join(root, 'unpacked');
    await exec(await getPath7za(), ['x', '-y', `-o${unpacked}`, result.path], { windowsHide: true });
    assert.equal(await readFile(path.join(unpacked, '中文 file.txt'), 'utf8'), 'Unicode filename and contents');
    await createBlockmap(result.path, target, packager, null);
    assert.equal(events.length, 1);
    const map = JSON.parse(gunzipSync(await readFile(`${result.path}.blockmap`)));
    assert.equal(map.files.reduce((sum, file) => sum + file.sizes.reduce((a, b) => a + b, 0), 0), result.size);
    assert(events[0].updateInfo.sha512);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the actual NSIS extraction hook preserves long Unicode paths and rejects corrupt payloads', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-nsis-extract-'));
  try {
    const { result, deepPath } = await buildArchive(root);
    const tools = await require('./prepare-installer-tool.cjs').prepare(path.join(root, 'project'));
    const compiler = await getMakeNsisPath();
    const destination = path.join(root, '安装目录 with spaces', 'nested-parent', 'Varin');
    assert(path.join(destination, deepPath).length > 260);
    const run = async (archive, name) => {
      const script = path.join(root, `${name}.nsi`);
      const program = path.join(root, `${name}.exe`);
      await writeFile(script, '\uFEFF' + [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
        'Name "Varin extraction regression"', `OutFile "${nsisPath(program)}"`,
        '!include "LogicLib.nsh"', 'LangString decompressionFailed 1033 "Payload extraction failed"',
        `!define VARIN_INSTALLER_7ZA "${nsisPath(path.join(tools, '7za.exe'))}"`,
        `!define VARIN_INSTALLER_UI_DIR "${nsisPath(tools)}"`,
        `!include "${nsisPath(extractorInclude)}"`,
        `!include "${nsisPath(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'))}"`,
        'Section', `SetOutPath "${nsisPath(destination)}"`,
        `!insertmacro extractUsing7za "${nsisPath(archive)}"`, 'SetErrorLevel 0', 'SectionEnd', '',
      ].join('\n'));
      await exec(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
      return exec(program, [], { windowsHide: true, timeout: 30_000 });
    };
    await run(result.path, 'valid');
    assert.equal(await readFile(path.join(destination, deepPath), 'utf8'), 'runtime type library');
    assert.equal(await readFile(path.join(destination, '中文 file.txt'), 'utf8'), 'Unicode filename and contents');
    const invalid = path.join(root, 'corrupt.7z');
    await writeFile(invalid, 'not a 7z archive');
    await assert.rejects(run(invalid, 'invalid'), (error) => error.code === 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installation removal handles long paths and restores locked files without crossing the temp drive', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.varin-removal-test-'));
  const runner = await mkdtemp(path.join(os.tmpdir(), 'varin-removal-runner-'));
  try {
    const tools = await require('./prepare-installer-tool.cjs').prepare(path.join(runner, 'project'));
    const compiler = await getMakeNsisPath();
    const source = path.join(root, '安装应用');
    const external = path.join(root, 'project');
    const longFile = path.join(source, 'resources/app.asar.unpacked/node_modules/@varin/extension-builtins/dist/builtin-packages/language-servers/runtime/dist/typeshed-fallback/stubs/oauthlib/oauthlib/oauth2/rfc6749/grant_types/resource_owner_password_credentials.pyi');
    assert(longFile.length > 260);
    await mkdir(path.dirname(longFile), { recursive: true });
    await mkdir(external);
    await writeFile(longFile, 'long path runtime');
    await writeFile(path.join(source, 'a-first.txt'), 'restore me');
    await writeFile(path.join(source, 'z-locked.txt'), 'locked contents');
    await writeFile(path.join(external, 'user.txt'), 'project data');
    await symlink(external, path.join(source, 'linked-project'), 'junction');
    const script = path.join(runner, 'remove.nsi');
    const program = path.join(runner, 'remove.exe');
    const result = path.join(runner, 'result.txt');
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      'Name "Varin installation removal regression"', `OutFile "${nsisPath(program)}"`,
      `!addplugindir /x86-unicode "${nsisPath(tools)}"`, '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
      'Section', 'StrCpy $2 0', '${GetParameters} $0', '${GetOptions} $0 "/LOCK" $1',
      '${IfNot} ${Errors}',
      `System::Call 'kernel32::CreateFileW(w "${nsisPath(path.join(source, 'z-locked.txt'))}", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r2'`,
      '${EndIf}', `VarinSetup::RemoveInstall "${nsisPath(source)}"`, 'Pop $0', 'Pop $1',
      `FileOpen $3 "${nsisPath(result)}" w`, 'FileWriteUTF16LE $3 "$0$\\r$\\n$1"', 'FileClose $3',
      '${If} $2 != 0', "System::Call 'kernel32::CloseHandle(p r2)'", '${EndIf}', 'SectionEnd',
    ].join('\n'));
    await exec(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    await exec(program, ['/LOCK'], { windowsHide: true, timeout: 30_000 });
    const failure = await readFile(result, 'utf16le');
    assert.match(failure, /^(32|5)\r\n.*z-locked\.txt/);
    assert.equal(await readFile(path.join(source, 'a-first.txt'), 'utf8'), 'restore me');
    assert.equal(await readFile(longFile, 'utf8'), 'long path runtime');
    assert.equal(await readFile(path.join(external, 'user.txt'), 'utf8'), 'project data');
    assert.deepEqual((await readdir(root)).sort(), ['project', '安装应用']);
    await exec(program, [], { windowsHide: true, timeout: 30_000 });
    assert.equal(await readFile(result, 'utf16le'), '0\r\n');
    await assert.rejects(access(source), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(external, 'user.txt'), 'utf8'), 'project data');
    assert.deepEqual(await readdir(root), ['project']);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(process.cwd(), '.varin-removal-test-')));
    assert(path.resolve(runner).startsWith(path.resolve(os.tmpdir(), 'varin-removal-runner-')));
    await rm(root, { recursive: true, force: true });
    await rm(runner, { recursive: true, force: true });
  }
});

test('uninstall keeps data by default and during upgrades; explicit cleanup leaves junction targets intact', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-uninstall-data-'));
  const product = path.basename(root);
  const data = path.join(process.env.APPDATA, product);
  try {
    await require('./prepare-installer-tool.cjs').prepare();
    const compiler = await getMakeNsisPath();
    const plugins = path.join(await getNsisPluginsPath(), 'x86-unicode');
    const header = new NsisScriptGenerator();
    header.addIncludeDir(path.join(builderRoot, 'templates/nsis/include'));
    header.addPluginDir('x86-unicode', plugins);
    header.include('StdUtils.nsh');
    header.flags(['updated', 'delete-app-data', 'no-desktop-shortcut']);
    const uninstaller = path.join(root, 'uninstall.exe');
    const installation = path.join(root, 'application');
    const creator = path.join(root, 'creator.exe');
    const script = path.join(root, 'cleanup.nsi');
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      `Name "${product}"`, `OutFile "${nsisPath(creator)}"`,
      '!define BUILD_UNINSTALLER', `!define PRODUCT_FILENAME "${product}"`, `!define PRODUCT_NAME "${product}"`, '!define VERSION "1.0.0"',
      header.build(), '!include "MUI2.nsh"', 'Var installMode',
      `!include "${nsisPath(path.join(resources, 'installer.nsh'))}"`,
      '!insertmacro VarinThemeFunctions "un."', '!insertmacro VarinUninstallFunctions',
      'UninstPage custom un.VarinReadyCreate un.VarinReadyLeave',
      '!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VarinProgressShow', '!insertmacro MUI_UNPAGE_INSTFILES',
      'UninstPage custom un.VarinFinishCreate', '!insertmacro MUI_LANGUAGE "English"',
      'Function un.onInit', 'StrCpy $installMode "CurrentUser"', '!insertmacro customUnInit', 'FunctionEnd',
      'Section', `WriteUninstaller "${nsisPath(uninstaller)}"`, 'SectionEnd',
      'Section "Uninstall"', '!insertmacro customRemoveFiles', '!insertmacro customRemoveAppData', 'SectionEnd',
    ].join('\n'));
    await exec(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    await exec(creator, ['/S'], { windowsHide: true });
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'conversation.txt'), 'retained conversation');
    await mkdir(path.join(root, 'project'));
    await writeFile(path.join(root, 'project/user-file.txt'), 'user project');
    await symlink(path.join(root, 'project'), path.join(data, 'linked-project'), 'junction');
    const uninstall = async (...args) => {
      await mkdir(installation, { recursive: true });
      await writeFile(path.join(installation, 'application.txt'), 'application file');
      await exec(uninstaller, ['/S', ...args, `_?=${installation}`], { windowsHide: true, timeout: 30_000 });
      await assert.rejects(access(installation), { code: 'ENOENT' });
    };
    await uninstall();
    assert.equal(await readFile(path.join(data, 'conversation.txt'), 'utf8'), 'retained conversation');
    await uninstall('--updated', '--delete-app-data');
    assert.equal(await readFile(path.join(data, 'conversation.txt'), 'utf8'), 'retained conversation');
    // An upgrade embeds the new remover; an unusable installed remover must
    // not prevent applying the fix to an existing installation.
    const upgrade = path.join(root, 'upgrade.exe');
    const upgradeScript = path.join(root, 'upgrade.nsi');
    await writeFile(upgradeScript, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      `Name "${product}"`, `OutFile "${nsisPath(upgrade)}"`,
      `!define PRODUCT_FILENAME "${product}"`, `!define PRODUCT_NAME "${product}"`, '!define VERSION "1.0.0"',
      `!define UNINSTALLER_OUT_FILE "${nsisPath(uninstaller)}"`,
      header.build(), '!include "MUI2.nsh"', 'Var installMode',
      `!include "${nsisPath(path.join(resources, 'installer.nsh'))}"`, '!insertmacro VarinThemeFunctions ""', '!insertmacro MUI_LANGUAGE "English"',
      'Section', 'InitPluginsDir',
      `!insertmacro customUninstallOldVersion "${nsisPath(installation)}" "/currentuser --keep-shortcuts --updated" "$0"`,
      'SetErrorLevel $0', 'SectionEnd',
    ].join('\n'));
    await exec(compiler.path, ['/V2', upgradeScript], { env: { ...process.env, ...compiler.env }, windowsHide: true });
    await mkdir(installation);
    await writeFile(path.join(installation, 'uninstall.exe'), 'old remover must not run');
    await exec(upgrade, [], { windowsHide: true, timeout: 30_000 });
    await assert.rejects(access(installation), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(data, 'conversation.txt'), 'utf8'), 'retained conversation');
    await uninstall('--delete-app-data');
    await assert.rejects(access(data), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(root, 'project/user-file.txt'), 'utf8'), 'user project');
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
