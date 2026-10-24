import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'packages/web/package.json'));
const { detectKernelBinaryIdentity } = createRequire(import.meta.url)('./kernel-binary-identity.cjs');

/** Copy the locked native target package; no install-time download or JS shim. */
export function prepareRipgrep({ platform = process.platform, arch = process.arch, stage }) {
  const binary = platform === 'win32' ? 'rg.exe' : 'rg';
  const fromPackage = createRequire(require.resolve('@vscode/ripgrep'));
  let source;
  try { source = fromPackage.resolve(`@vscode/ripgrep-${platform}-${arch}/bin/${binary}`); }
  catch { throw new Error(`Missing native ripgrep ${platform}-${arch}. Install the locked optional target dependency before packaging.`); }
  const identity = detectKernelBinaryIdentity(fs.readFileSync(source));
  if (identity.platform !== platform || identity.arch !== arch) throw new Error('Native ripgrep target does not match the package target');
  fs.mkdirSync(stage, { recursive: true });
  fs.rmSync(path.join(stage, platform === 'win32' ? 'rg' : 'rg.exe'), { force: true });
  fs.copyFileSync(source, path.join(stage, binary));
  if (platform !== 'win32') fs.chmodSync(path.join(stage, binary), 0o755);
  fs.copyFileSync(path.resolve(path.dirname(source), '..', 'LICENSE'), path.join(stage, 'ripgrep-LICENSE'));
  for (const license of ['ripgrep-MIT-LICENSE.txt', 'pcre2-LICENSE.txt']) {
    fs.copyFileSync(path.join(root, 'packages/web/public/licenses', license), path.join(stage, license));
  }
  return path.join(stage, binary);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const stage = argument('--stage');
  if (!stage) throw new Error('--stage is required');
  console.log(prepareRipgrep({ stage: path.resolve(stage), platform: argument('--platform'), arch: argument('--arch') }));
}
