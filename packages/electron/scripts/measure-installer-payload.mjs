#!/usr/bin/env node
// Measure the actual NSIS payload codecs without installing, registering or stopping any application.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Run the NSIS payload measurement on Windows.');
const inputs = process.argv.slice(2).map((value) => path.resolve(value));
if (inputs.length !== 3 && inputs.length !== 5) {
  throw new Error('Usage: node measure-installer-payload.mjs [OLD.exe OLD_UNPACKED] NEW.exe NEW_UNPACKED REPORT.json');
}
const report = inputs.at(-1);
const cases = inputs.length === 3
  ? [['candidate', inputs[0], inputs[1]]]
  : [['baseline', inputs[0], inputs[1]], ['candidate', inputs[2], inputs[3]]];
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const library = createRequire(builderRequire.resolve('app-builder-lib'));
const builderRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
const sevenZip = await library('./toolsets/7zip').getPath7za();
const { getMakeNsisPath, getNsisPluginsPath } = library('./toolsets/windows');
const compiler = await getMakeNsisPath();
const plugins = path.join(await getNsisPluginsPath(), 'x86-unicode');
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const extractorInclude = path.resolve(scriptsDirectory, '..', 'resources', 'installer-extract.nsh');
const installerToolDirectory = await require('./prepare-installer-tool.cjs').prepare(path.resolve(scriptsDirectory, '..'));
const installerSevenZip = path.join(installerToolDirectory, '7za.exe');
const exec = promisify(execFile);
const nsisPath = (value) => value.replaceAll('/', '\\').replace(/\$/g, () => '$$');
const sampleCount = Math.max(1, Number.parseInt(process.env.VARIN_INSTALLER_MEASURE_SAMPLES ?? '3', 10) || 3);
const sampleTimeoutMs = Math.max(1_000, Number.parseInt(process.env.VARIN_INSTALLER_MEASURE_TIMEOUT_MS ?? '300000', 10) || 300_000);
const extractorMode = (process.env.VARIN_INSTALLER_MEASURE_EXTRACTOR ?? 'auto').trim().toLowerCase();
if (!['auto', 'direct', 'stock'].includes(extractorMode)) {
  throw new Error('VARIN_INSTALLER_MEASURE_EXTRACTOR must be auto, direct, or stock.');
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventory(root) {
  const files = new Map();
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.set(path.relative(root, filename), {
        bytes: (await stat(filename)).size,
        sha256: await digest(filename),
      });
      else throw new Error(`Unexpected non-regular packaged entry: ${filename}`);
    }
  }
  await visit(root);
  return files;
}

await mkdir(path.dirname(report), { recursive: true });
const temporary = await mkdtemp(path.join(path.dirname(report), 'payload-measure-'));
const results = [];
try {
  for (const [label, installer, app] of cases) {
    // 7-Zip reports the offset and exact length of the embedded archive, avoiding a second compressor.
    const listing = await exec(sevenZip, ['l', '-slt', installer], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    const header = listing.stdout.split('----------')[0];
    const codec = /^Type = (7z|zip)\r?$/m.exec(header)?.[1];
    const offset = Number(/^Offset = (\d+)/m.exec(header)?.[1]);
    const size = Number(/^Physical Size = (\d+)/m.exec(header)?.[1]);
    if (!codec || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error(`Cannot locate the embedded payload in ${installer}: ${header}`);
    }
    const archive = path.join(temporary, `${label}.${codec}`);
    await pipeline(createReadStream(installer, { start: offset, end: offset + size - 1 }), createWriteStream(archive));
    const expected = await inventory(app);
    const destination = path.join(temporary, `${label}-安装目录`);
    const harness = path.join(temporary, `${label}.exe`);
    const script = path.join(temporary, `${label}.nsi`);
    const customDirect7z = codec === '7z' && (
      extractorMode === 'direct' || (extractorMode === 'auto' && label === 'candidate')
    );
    const extraction = codec === '7z'
      ? `!insertmacro extractUsing7za "${nsisPath(archive)}"`
      : `nsisunz::Unzip "${nsisPath(archive)}" "$INSTDIR"\nPop $0\nStrCmp $0 "success" +3\nSetErrorLevel 1\nQuit`;
    const customIncludes = customDirect7z ? [
      `!define VARIN_INSTALLER_7ZA "${nsisPath(installerSevenZip)}"`,
      `!define VARIN_INSTALLER_UI_DIR "${nsisPath(path.dirname(installerSevenZip))}"`,
      `!include "${nsisPath(extractorInclude)}"`,
    ] : [];
    await writeFile(script, '\uFEFF' + [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
      'Name "Varin payload measurement only"', `OutFile "${nsisPath(harness)}"`,
      `!addplugindir /x86-unicode "${nsisPath(plugins)}"`, '!include "LogicLib.nsh"', ...customIncludes,
      `!include "${nsisPath(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'))}"`,
      'LangString appCannotBeClosed 1033 "Payload measurement copy failed"',
      'LangString decompressionFailed 1033 "Payload extraction failed"',
      'Section', 'InitPluginsDir', `StrCpy $INSTDIR "${nsisPath(destination)}"`,
      'SetOutPath $INSTDIR', 'SetDetailsPrint none', extraction, 'SetErrorLevel 0', 'SectionEnd', '',
    ].join('\n'), 'utf8');
    await exec(compiler.path, ['/V2', script], {
      windowsHide: true, env: { ...process.env, ...compiler.env }, maxBuffer: 1024 * 1024,
    });
    const samplesMs = [];
    let timedOut = false;
    for (let sample = 0; sample < sampleCount; sample++) {
      await rm(destination, { recursive: true, force: true });
      const started = performance.now();
      try {
        await exec(harness, [], { windowsHide: true, timeout: sampleTimeoutMs, maxBuffer: 1024 * 1024 });
        samplesMs.push(Math.round(performance.now() - started));
      } catch (error) {
        const elapsed = Math.round(performance.now() - started);
        const timeoutLike = error?.killed === true || error?.signal === 'SIGTERM' || elapsed >= sampleTimeoutMs - 500;
        if (!timeoutLike) throw error;
        samplesMs.push(elapsed);
        timedOut = true;
        break;
      }
    }
    const ordered = [...samplesMs].sort((a, b) => a - b);
    const elapsedMs = ordered[Math.floor(ordered.length / 2)];
    const actual = timedOut ? null : await inventory(destination);
    if (actual) {
      const mismatches = [];
      for (const [file, expectedFile] of expected) {
        const received = actual.get(file);
        if (!received || received.sha256 !== expectedFile.sha256) mismatches.push(file);
      }
      for (const file of actual.keys()) if (!expected.has(file)) mismatches.push(file);
      if (mismatches.length) throw new Error(`NSIS payload differs from packaged files (${mismatches.length}): ${mismatches.slice(0,20).join(', ')}`);
    }
    const result = {
      label, installer, codec,
      extractor: customDirect7z ? 'varin-7za-direct' : codec === '7z' ? 'electron-builder-7z-temp-copy' : 'nsisunz-direct',
      installerBytes: (await stat(installer)).size,
      archiveBytes: size, files: expected.size,
      installedBytes: [...expected.values()].reduce((sum, file) => sum + file.bytes, 0),
      elapsedMs, samplesMs, timedOut, timeoutMs: sampleTimeoutMs,
      verifiedFileHashes: actual?.size ?? 0,
    };
    results.push(result);
    console.log(JSON.stringify(result));
    // Keep only reports, not a second installation or multi-gigabyte temporary payloads.
    await rm(destination, { recursive: true, force: true });
    await rm(archive);
  }
  await writeFile(report, `${JSON.stringify({
    measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    method: `Payload extraction only with the same NSIS toolchain as electron-builder. Extractor mode=${extractorMode}; auto means baseline 7z uses the stock temporary-tree + CopyFiles path while candidate 7z uses Varin's packaged x86 7za direct-to-INSTDIR hook. ZIP uses nsisunz directly. No registry, shortcuts, old-version uninstall, app shutdown or antivirus changes. SHA-256 verification is outside the timed interval for completed cases. Up to ${sampleCount} sequential samples per case; elapsedMs is the median, timeout=${sampleTimeoutMs}ms, and filesystem/antivirus caches are not controlled.`,
    results,
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
