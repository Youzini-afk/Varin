import { createHash } from 'node:crypto';
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { c as createTar } from 'tar';
import { parseVarinExtensionReleaseManifest, type VarinExtensionReleaseManifest } from '@varin/extension-contract';
import { buildProject } from './build.js';
import { checkProject } from './project.js';

/** Explicit files form the runtime payload; dependency installation is never a consumer step. */
export async function releaseProject(directory = '.', options: { output?: string; platform?: string; arch?: string } = {}) {
  const { project, outputs } = await buildProject(directory);
  const checked = await checkProject(directory);
  if (checked.missingFiles.length || checked.incompatibleContributions.length) throw new Error('Release requires complete, compatible entrypoints');
  const platform = options.platform ?? 'any';
  const arch = options.arch ?? 'any';
  if (!/^[a-z0-9_-]+$/.test(platform) || !/^[a-z0-9_-]+$/.test(arch)) throw new Error('Invalid release platform or architecture');
  const output = resolve(options.output ?? join(project.directory, 'release'));
  const root = await mkdtemp(join(tmpdir(), 'varin-release-build-'));
  try {
    const packageRoot = join(root, 'package');
    await mkdir(packageRoot);
    const selected = new Set(['varin.extension.json', ...outputs.map(item => item.file)]);
    for (const file of checked.referencedFiles) selected.add(file);
    for (const item of outputs) {
      const css = item.file.replace(/\.[^.]+$/, '.css');
      try { await access(join(project.directory, css)); selected.add(css); } catch { /* no emitted stylesheet */ }
    }
    const metadata = JSON.parse(await readFile(project.packageJsonPath, 'utf8')) as { files?: unknown };
    if (metadata.files !== undefined) {
      if (!Array.isArray(metadata.files) || metadata.files.some(file => typeof file !== 'string')) throw new Error('package.json files must be an array of package-relative files or directories');
      for (const file of metadata.files as string[]) selected.add(file);
    }
    const physicalRoot = await realpath(project.directory);
    const copy = async (file: string): Promise<void> => {
      const source = resolve(project.directory, file);
      const logical = relative(project.directory, source).replaceAll('\\', '/');
      if (!logical || logical.startsWith('../') || logical.includes(':') || logical.split('/').some(part => ['.git', 'node_modules'].includes(part) || part.startsWith('.env'))
        || [...'*?[]{}'].some(character => file.includes(character))) throw new Error(`Release files must be explicit safe relative paths: ${file}`);
      const actual = await realpath(source);
      const physicalRelative = relative(physicalRoot, actual);
      if (physicalRelative === '..' || physicalRelative.startsWith('../') || physicalRelative.startsWith('..\\')) throw new Error(`Release file escapes project: ${file}`);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Release files cannot contain links: ${file}`);
      if (info.isDirectory()) { for (const entry of await readdir(source)) await copy(`${logical}/${entry}`); return; }
      if (!info.isFile()) throw new Error(`Unsupported release file: ${file}`);
      const target = join(packageRoot, logical);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    };
    for (const file of selected) await copy(file);
    // Build metadata/development scripts and dependencies are not runtime requirements of bundled entrypoints.
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: project.packageJson.name, version: project.manifest.version, type: project.packageJson.type, engines: project.manifest.engines }, null, 2));
    const file = `${project.manifest.id}-${project.manifest.version}-${platform}-${arch}.tgz`;
    await mkdir(output, { recursive: true });
    const archive = join(output, file);
    await createTar({ cwd: root, file: archive, gzip: true, portable: true, noMtime: true }, ['package']);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const manifest: VarinExtensionReleaseManifest = parseVarinExtensionReleaseManifest({ schemaVersion: 1, extensionId: project.manifest.id,
      version: project.manifest.version, engines: project.manifest.engines, assets: [{ file, sha256, platform, arch }] });
    const manifestPath = join(output, 'varin.release.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { archive, manifestPath, manifest };
  } finally { await rm(root, { recursive: true, force: true }); }
}
