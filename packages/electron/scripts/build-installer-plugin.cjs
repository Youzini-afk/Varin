const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createRequire } = require('node:module');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const quote = value => `"${value.replaceAll('"', '""')}"`;

async function prepareInstallerUI(destination) {
  await fs.mkdir(destination, { recursive: true });
  const builder = createRequire(require.resolve('electron-builder'));
  const library = createRequire(builder.resolve('app-builder-lib'));
  const { bundledLanguages, lcid } = library('./util/langs');
  const messages = JSON.parse(await fs.readFile(path.join(root, 'installer/messages.json'), 'utf8'));
  const strings = [];
  for (const [key, translations] of Object.entries(messages)) {
    for (const lang of bundledLanguages) {
      const text = translations[lang === 'zh_CN' ? 1 : lang === 'zh_TW' ? 2 : 0];
      strings.push(`LangString ${key} ${lcid[lang]} "${text.replaceAll('$', '$$').replaceAll('"', '$\\"')}"`);
    }
  }
  for (const appearance of ['light', 'dark']) {
    const { colors } = JSON.parse(await fs.readFile(path.join(root, `../ui/src/lib/theme/themes/varin-${appearance}.json`), 'utf8'));
    for (const [key, value] of Object.entries({
      BACKGROUND: colors.surface.background, FOREGROUND: colors.surface.foreground,
      MUTED: colors.surface.mutedForeground, SURFACE: colors.surface.elevated,
      PRIMARY: colors.primary.base, ON_PRIMARY: colors.primary.foreground,
    })) strings.push(`!define VARIN_${appearance.toUpperCase()}_${key} "${value.slice(1)}"`);
  }
  await fs.writeFile(path.join(destination, 'installer-generated.nsh'), '\uFEFF' + strings.join('\n') + '\n');
  // Render the same vector mark as the product, without a second hand-copied logo.
  const glyph = await fs.readFile(path.join(root, 'resources/icons/tray/tray-glyph.svg'), 'utf8');
  const polygons = [...glyph.matchAll(/<path d="([^"]+)"/g)].map(([, data], index) => {
    if (/[a-z]/i.test(data.replace(/[MLZ]/g, ''))) throw new Error('Installer glyph requires polygon paths.');
    const numbers = data.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
    if (numbers.length < 6 || numbers.length % 2) throw new Error('Invalid installer glyph polygon.');
    const points = [];
    for (let i = 0; i < numbers.length; i += 2) points.push(`{${numbers[i].toFixed(3)}f, ${numbers[i + 1].toFixed(3)}f}`);
    return `static const Gdiplus::PointF brand${index}[]{${points.join(',')}};`;
  });
  if (polygons.length !== 2) throw new Error('Expected the two-part Varin brand mark.');
  await fs.writeFile(path.join(destination, 'installer-brand.h'), polygons.join('\n') + '\n');
  if (process.platform !== 'win32') throw new Error('Building the Windows installer UI requires the Windows MSVC toolchain.');
  const source = path.join(root, 'installer/VarinSetup.cpp');
  const definitions = path.join(root, 'installer/VarinSetup.def');
  const output = path.join(destination, 'VarinSetup.dll');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const { stdout } = await exec(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true });
  const candidates = [stdout.trim(), ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .flatMap(base => ['BuildTools', 'Community', 'Professional', 'Enterprise'].map(edition => path.join(base, 'Microsoft Visual Studio/2022', edition)))].filter(Boolean);
  let installation;
  for (const candidate of candidates) {
    if (await fs.access(path.join(candidate, 'Common7/Tools/VsDevCmd.bat')).then(() => true, () => false)) { installation = candidate; break; }
  }
  if (!installation) throw new Error('MSVC x86 build tools are required for the Unicode NSIS UI plugin.');
  const developer = path.join(installation, 'Common7/Tools/VsDevCmd.bat');
  const host = process.arch === 'arm64' ? 'arm64' : 'x64';
  const command = `call ${quote(developer)} -arch=x86 -host_arch=${host} && cl /nologo /LD /std:c++17 /W4 /O2 /MT /utf-8 /DUNICODE /D_UNICODE /I${quote(destination)} ${quote(source)} /Fo${quote(path.join(destination, 'VarinSetup.obj'))} /link /OUT:${quote(output)} /DEF:${quote(definitions)} user32.lib gdi32.lib comctl32.lib uxtheme.lib dwmapi.lib gdiplus.lib`;
  const built = await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    windowsHide: true, windowsVerbatimArguments: true, cwd: destination, env: { ...process.env, VSLANG: '1033' },
  });
  if (built.stderr.trim()) process.stderr.write(built.stderr);
  const binary = await fs.readFile(output);
  const pe = binary.readUInt32LE(0x3c);
  if (binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x14c) throw new Error('The NSIS UI plugin must be a Windows x86 DLL.');
  return output;
}
module.exports = { prepareInstallerUI };
if (require.main === module) {
  prepareInstallerUI(path.join(root, 'resources/installer-tools'))
    .then(file => console.log(`[electron] installer UI prepared: ${file}`))
    .catch(error => { console.error(error.stdout || '', error.stderr || '', error); process.exitCode = 1; });
}
