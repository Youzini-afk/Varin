const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
} = require('../../../scripts/kernel-binary-identity.cjs');

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const unpackedNodeModulesPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules');
  const kernelExecutable = context.electronPlatformName === 'win32' ? 'varin-kernel.exe' : 'varin-kernel';
  const packagedKernelPath = path.join(resourcesPath, 'kernel', kernelExecutable);
  const kernelManifestPath = path.join(resourcesPath, 'kernel', 'manifest.json');
  if (!fs.existsSync(packagedKernelPath) || !fs.existsSync(kernelManifestPath)) {
    throw new Error(`Missing packaged Rust kernel or manifest at ${path.join(resourcesPath, 'kernel')}`);
  }
  let kernelManifest;
  try {
    kernelManifest = JSON.parse(fs.readFileSync(kernelManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read packaged Rust kernel manifest at ${kernelManifestPath}: ${error.message}`);
  }
  const kernelBytes = fs.readFileSync(packagedKernelPath);
  const kernelDigest = crypto.createHash('sha256').update(kernelBytes).digest('hex');
  const binaryIdentity = detectKernelBinaryIdentity(kernelBytes);
  const targetArchitecture = normalizeKernelArchitecture(process.env.VARIN_TARGET_ARCH || process.arch);
  const expectedTargetTriple = process.env.VARIN_TARGET_TRIPLE || defaultKernelTargetTriple(context.electronPlatformName, targetArchitecture);
  if (kernelManifest.schema !== 3 || kernelManifest.executable !== kernelExecutable || kernelManifest.sha256 !== kernelDigest
    || kernelManifest.protocolVersion !== 1 || kernelManifest.platform !== context.electronPlatformName
    || kernelManifest.arch !== targetArchitecture || kernelManifest.targetTriple !== expectedTargetTriple
    || kernelManifest.binaryFormat !== binaryIdentity.format
    || binaryIdentity.platform !== context.electronPlatformName || binaryIdentity.arch !== targetArchitecture
    || typeof kernelManifest.buildIdentity !== 'string' || !kernelManifest.buildIdentity
    || kernelManifest.kernelVersion !== '0.1.0') {
    throw new Error(`Packaged Rust kernel manifest does not match ${packagedKernelPath}`);
  }
  const trivium = path.join(unpackedNodeModulesPath, 'triviumdb');
  const suffix = context.electronPlatformName === 'win32' ? '-msvc' : context.electronPlatformName === 'linux' ? '-gnu' : '';
  const triviumBinary = 'triviumdb.' + context.electronPlatformName + '-' + targetArchitecture + suffix + '.node';
  if (!fs.existsSync(path.join(trivium, triviumBinary))) throw new Error('Missing target TriviumDB binary: ' + triviumBinary);
  for (const name of fs.readdirSync(trivium)) if (name.endsWith('.node') && name !== triviumBinary) fs.rmSync(path.join(trivium, name));
  for (const optional of ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web']) {
    if (fs.existsSync(path.join(unpackedNodeModulesPath, optional))) {
      throw new Error(`Optional local inference dependency entered the base installer: ${optional}`);
    }
  }
  for (const legacy of ['node-pty', 'bun-pty', 'better-sqlite3']) {
    if (fs.existsSync(path.join(unpackedNodeModulesPath, legacy))) throw new Error('Obsolete native authority entered release: ' + legacy);
  }

  const packagedWebDistPath = path.join(resourcesPath, 'web-dist');
  if (!fs.existsSync(path.join(packagedWebDistPath, 'index.html'))) {
    throw new Error(`Missing packaged web UI at ${packagedWebDistPath}`);
  }
  const packagedPdfjsRoot = path.join(unpackedNodeModulesPath, 'pdfjs-dist');
  for (const relativePath of [
    path.join('legacy', 'build', 'pdf.mjs'),
    path.join('legacy', 'build', 'pdf.worker.mjs'),
    path.join('cmaps', 'Adobe-GB1-0.bcmap'),
    path.join('standard_fonts', 'FoxitDingbats.pfb'),
    path.join('wasm', 'openjpeg.wasm'),
    path.join('wasm', 'qcms_bg.wasm'),
  ]) {
    const packagedPath = path.join(packagedPdfjsRoot, relativePath);
    let complete = false;
    try {
      const details = fs.statSync(packagedPath);
      complete = details.isFile() && details.size > 0;
    } catch {
      // Report the same actionable path below for missing and unreadable files.
    }
    if (!complete) {
      throw new Error(`Missing unpacked PDF.js runtime file at ${packagedPath}`);
    }
  }
  fs.rmSync(
    path.join(unpackedNodeModulesPath, '@varin', 'web', 'dist'),
    { recursive: true, force: true },
  );

  const requiredApplicationHostFiles = [
    path.join('node_modules', '@varin', 'pi-host', 'dist', 'host-bootstrap.js'),
    path.join('node_modules', '@varin', 'runtime-broker', 'dist', 'index.js'),
    path.join('node_modules', '@varin', 'extension-host', 'dist', 'index.js'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'varin-builtin-fingerprint.txt'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'varin.extension.json'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'host.cjs'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'varin-builtin-fingerprint.txt'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'varin.extension.json'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'host.cjs'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript-language-server.mjs'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'package.json'),
    path.join('node_modules', '@varin', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'lib', 'tsserver.js'),
    path.join('node_modules', '@varin', 'web', 'server', 'production-boundary.json'),
  ];
  for (const relativePath of requiredApplicationHostFiles) {
    const packagedPath = path.join(resourcesPath, 'app.asar.unpacked', relativePath);
    let complete = false;
    try {
      const details = fs.statSync(packagedPath);
      complete = details.isFile() && details.size > 0;
    } catch {
      // Report the same actionable path below for missing and unreadable files.
    }
    if (!complete) {
      throw new Error(`Missing unpacked application-host runtime file at ${packagedPath}`);
    }
  }
  const bundledModelDirectory = path.join(unpackedNodeModulesPath, '@varin', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime');
  if (fs.existsSync(bundledModelDirectory)) throw new Error('Local model weights entered the base installer');

  const packagedHostEntry = path.join(
    unpackedNodeModulesPath,
    '@varin',
    'pi-host',
    'dist',
    'host-bootstrap.js',
  );
  const packagedBrokerEntry = path.join(
    unpackedNodeModulesPath,
    '@varin',
    'runtime-broker',
    'dist',
    'index.js',
  );
  const packagedExecutable = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'MacOS', context.packager.appInfo.productFilename)
    : path.join(context.appOutDir, context.electronPlatformName === 'win32'
      ? `${context.packager.appInfo.productFilename}.exe`
      : context.packager.appInfo.productFilename.toLowerCase());
  execFileSync(packagedExecutable, [
    path.join(__dirname, 'verify-packaged-pi-host.mjs'),
    packagedBrokerEntry,
    packagedHostEntry,
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });

  execFileSync(packagedExecutable, [
    path.join(__dirname, 'verify-packaged-typescript.cjs'),
    path.join(unpackedNodeModulesPath, '@varin', 'extension-builtins', 'dist', 'builtin-packages',
      'typescript-language', 'runtime', 'typescript', 'lib', 'typescript.js'),
  ], {
    cwd: context.appOutDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });

  const packagedPdfjsEntry = path.join(packagedPdfjsRoot, 'legacy', 'build', 'pdf.mjs');
  const pdfRuntimeSmoke = `
    import { createRequire } from 'node:module';
    import { existsSync } from 'node:fs';
    import path from 'node:path';
    import { sep } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const pdfjsEntry = ${JSON.stringify(packagedPdfjsEntry)};
    const pdfRequire = createRequire(pdfjsEntry);
    const canvas = pdfRequire('@napi-rs/canvas');
    const pdfjs = await import(pathToFileURL(pdfjsEntry).href);
    if (typeof pdfjs.getDocument !== 'function') {
      throw new Error('PDF.js legacy runtime could not be loaded.');
    }
    const packageRoot = path.resolve(path.dirname(pdfjsEntry), '..', '..');
    const unpackedRoot = packageRoot.replace('app.asar' + sep, 'app.asar.unpacked' + sep);
    const assetRoot = existsSync(path.join(unpackedRoot, 'standard_fonts')) ? unpackedRoot : packageRoot;
    const cMapUrl = pathToFileURL(path.join(assetRoot, 'cmaps') + sep).href;
    const standardFontDataUrl = pathToFileURL(path.join(assetRoot, 'standard_fonts') + sep).href;
    const content = 'q\\n0 0 1 rg\\n20 20 60 40 re\\nf\\nBT /F1 14 Tf 20 90 Td (packaged PDF render) Tj ET\\nQ\\n';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Length ' + Buffer.byteLength(content, 'ascii') + ' >>\\nstream\\n' + content + 'endstream',
    ];
    let source = '%PDF-1.4\\n';
    const offsets = [0];
    for (let index = 0; index < objects.length; index += 1) {
      offsets.push(Buffer.byteLength(source, 'ascii'));
      source += (index + 1) + ' 0 obj\\n' + objects[index] + '\\nendobj\\n';
    }
    const xrefOffset = Buffer.byteLength(source, 'ascii');
    source += 'xref\\n0 ' + (objects.length + 1) + '\\n0000000000 65535 f \\n';
    for (const offset of offsets.slice(1)) source += String(offset).padStart(10, '0') + ' 00000 n \\n';
    source += 'trailer\\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\\nstartxref\\n' + xrefOffset + '\\n%%EOF\\n';
    const loading = pdfjs.getDocument({
      cMapPacked: true,
      cMapUrl,
      data: new Uint8Array(Buffer.from(source, 'ascii')),
      standardFontDataUrl,
      wasmUrl: pathToFileURL(path.join(assetRoot, 'wasm') + sep).href,
      iccUrl: pathToFileURL(path.join(assetRoot, 'iccs') + sep).href,
    });
    let document;
    try {
      document = await loading.promise;
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const surface = canvas.createCanvas(width, height);
      await page.render({ canvas: surface, canvasContext: surface.getContext('2d'), viewport }).promise;
      const png = surface.toBuffer('image/png');
      if (width !== 200 || height !== 120 || !Buffer.isBuffer(png) || png.length <= 8) {
        throw new Error('Packaged PDF.js returned an empty or incorrectly sized render.');
      }
      console.log('[electron] rendered the embedded PDF with packaged PDF.js and native Canvas');
    } finally {
      await loading.destroy();
    }
  `;
  execFileSync(packagedExecutable, ['--input-type=module', '-e', pdfRuntimeSmoke], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    stdio: 'inherit',
    windowsHide: true,
  });

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
