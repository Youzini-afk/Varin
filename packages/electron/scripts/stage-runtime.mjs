import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const builderRequire = createRequire(require.resolve('electron-builder'));
const library = createRequire(builderRequire.resolve('app-builder-lib'));
const { FileMatcher, excludedExts } = library('./fileMatcher');
const { NodeModuleCopyHelper } = library('./util/NodeModuleCopyHelper');
const configuration = require('./package.json').build;
const onNodeModuleFile = require('./scripts/node-module-file-policy.cjs');
const metadata = new Set(['package.json', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE', 'THIRD_PARTY_NOTICES.md']);
const matches = (values, actual) => !Array.isArray(values) || !values.includes(`!${actual}`)
  && (!values.some(value => !value.startsWith('!')) || values.includes(actual));

export async function resolveRuntimePackage(name, importer) {
  const resolver = createRequire(path.join(importer, 'package.json'));
  for (const base of resolver.resolve.paths(`${name}/package.json`) ?? []) {
    const candidate = path.join(base, name);
    try { await fs.access(path.join(candidate, 'package.json')); return await fs.realpath(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Object.assign(new Error(`Missing runtime dependency ${name} required by ${importer}`), { code: 'MODULE_NOT_FOUND' });
}

/** Produce an ordinary, closed Node dependency tree from the installed lockfile graph. */
export async function stageRuntime({ repository, destination, hostDirectory, platform = process.platform, architecture = process.arch }) {
  const electron = path.join(repository, 'packages/electron');
  const app = JSON.parse(await fs.readFile(path.join(electron, 'package.json'), 'utf8'));
  const modules = path.join(destination, 'node_modules');
  const nodes = new Map();
  const direct = new Map();
  for (const name of Object.keys(app.dependencies)) direct.set(name, await resolveRuntimePackage(name, electron));
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(modules, { recursive: true });
  const add = async (name, source, parentModules = modules, optional = false) => {
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    if (!matches(manifest.os, platform) || !matches(manifest.cpu, architecture) || !matches(manifest.libc, 'glibc')) {
      if (optional) return null;
      throw new Error(`Runtime dependency ${name} does not support ${platform}/${architecture}`);
    }
    const parent = path.dirname(parentModules);
    for (const base of createRequire(path.join(parent, 'package.json')).resolve.paths(`${name}/package.json`) ?? []) {
      const ancestor = nodes.get(path.join(base, name));
      if (ancestor) { if (ancestor.source === source) return ancestor; break; }
    }
    let target = path.join(modules, name);
    if (direct.has(name) && direct.get(name) !== source || nodes.has(target) && nodes.get(target).source !== source) target = path.join(parentModules, name);
    if (nodes.has(target)) {
      if (nodes.get(target).source !== source) throw new Error(`Conflicting runtime dependency at ${target}`);
      return nodes.get(target);
    }
    const node = { name, source, target, dependencies: [], physical: name.startsWith('@varin/') || Boolean(manifest.bin) };
    nodes.set(target, node);
    const matcher = new FileMatcher(source, target, value => value, ['**/*', ...configuration.files.filter(value => value.startsWith('!'))]);
    const helper = new NodeModuleCopyHelper(matcher, { config: { onNodeModuleFile }, appInfo: { type: 'module' }, getWorkspaceRoot: async () => repository });
    const ignored = ['.o', '.obj', '.pdb', ...excludedExts.split(',').map(ext => `.${ext}`), ...(platform === 'win32' ? [] : ['.dll', '.exe'])];
    let files = await helper.collectNodeModules({ dir: source, name }, ignored, path.relative(destination, target));
    if (name.startsWith('@varin/')) files = files.filter(file => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      return metadata.has(relative) || (name !== '@varin/web' && relative.startsWith('dist/'));
    });
    if (!files.length) { nodes.delete(target); return null; }
    const directories = new Set(files.map(file => path.dirname(path.join(target, path.relative(source, file)))));
    await Promise.all([...directories].map(directory => fs.mkdir(directory, { recursive: true })));
    await Promise.all(files.map(async file => {
      const relative = path.relative(source, file);
      await fs.copyFile(file, path.join(target, relative));
      if (/\.(?:node|dll|exe|so(?:\.\d+)*|dylib|wasm)$/u.test(relative)) node.physical = true;
    }));
    if (name === '@varin/web') {
      await fs.cp(hostDirectory, path.join(target, 'server'), { recursive: true });
      delete manifest.bin; // Desktop embeds the Host; the separately built Web CLI remains a Web product.
    }
    delete manifest.devDependencies;
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const dependency of Object.keys(manifest[group] ?? {})) {
        if (group === 'dependencies' && dependency in (manifest.optionalDependencies ?? {})) continue;
        if (group === 'peerDependencies' && (dependency in (manifest.dependencies ?? {}) || dependency in (manifest.optionalDependencies ?? {}))) continue;
        const isOptional = group === 'optionalDependencies' || group === 'peerDependencies' && manifest.peerDependenciesMeta?.[dependency]?.optional === true;
        let child;
        try { child = await add(dependency, await resolveRuntimePackage(dependency, source), path.join(target, 'node_modules'), isOptional); }
        catch (error) { if (!isOptional || error.code !== 'MODULE_NOT_FOUND') throw error; }
        if (!child) {
          if (!isOptional) throw new Error(`Runtime dependency ${dependency} has no distributable files`);
          delete manifest[group][dependency]; continue;
        }
        node.dependencies.push(child);
        if (manifest[group][dependency].startsWith('workspace:')) manifest[group][dependency] = JSON.parse(await fs.readFile(path.join(child.source, 'package.json'), 'utf8')).version;
      }
    }
    await fs.writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    return node;
  };
  for (const name of Object.keys(app.dependencies)) {
    const node = await add(name, direct.get(name));
    if (!node) throw new Error(`Missing distributable application dependency ${name}`);
    if (app.dependencies[name].startsWith('workspace:')) app.dependencies[name] = JSON.parse(await fs.readFile(path.join(node.source, 'package.json'), 'utf8')).version;
  }
  delete app.devDependencies; delete app.build; delete app.scripts;
  await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(app, null, 2) + '\n');
  for (const entry of ['bootstrap.mjs', 'dist-bundle']) await fs.cp(path.join(electron, entry), path.join(destination, entry), { recursive: true });

  // These entry owners run through a real Node process, including a user-selected Node executable.
  // Preserve their dependency closures outside ASAR; ordinary main-process JS stays in the archive.
  const physical = new Set();
  const closed = new Set();
  const unpack = node => { if (closed.has(node.target)) return; closed.add(node.target); physical.add(node.target); node.dependencies.forEach(unpack); };
  for (const node of nodes.values()) {
    if (node.physical) physical.add(node.target);
    if (['@varin/script-runtime', '@varin/extension-host', '@varin/extension-builtins', '@varin/protocol',
      'triviumdb', 'sherpa-onnx-node', '@konbakuyomu/smart-search'].includes(node.name)) unpack(node);
  }
  // Native package wrappers may themselves import JS helpers from a physical entry.
  for (const node of nodes.values()) if (node.physical && !node.name.startsWith('@varin/')) unpack(node);
  const unpackPatterns = [...physical].map(target => `${path.relative(destination, target).replaceAll('\\', '/')}/**/*`);
  await fs.writeFile(path.join(destination, 'runtime-layout.json'), JSON.stringify({ schema: 1, platform, architecture, unpackPatterns }, null, 2) + '\n');
  return { directory: destination, unpackPatterns };
}
