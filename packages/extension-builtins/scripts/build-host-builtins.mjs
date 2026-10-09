import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(directory, '..');
const builtinOutputRoot = join(packageDirectory, 'dist', 'builtin-packages');
const typescriptOutputRoot = join(builtinOutputRoot, 'typescript-language');
const languageServersOutputRoot = join(builtinOutputRoot, 'language-servers');
const recoveryOutputRoot = join(builtinOutputRoot, 'recovery');
const require = createRequire(import.meta.url);
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`));
const readPackage = async (root) => JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const BASH_LANGUAGE_SERVER_LICENSE = `MIT License

Copyright (c) 2018 Mads Hartmann

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
`;

const packageFingerprint = async (root, fingerprintFile) => {
  const files = [];
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const logicalPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, logicalPath);
      else if (entry.isFile() && logicalPath !== fingerprintFile) files.push({ logicalPath, path });
    }
  };
  await visit(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.logicalPath);
    hash.update('\0');
    hash.update(await readFile(file.path));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
};

const writePackageFingerprint = async (root, fingerprintFile) => {
  await writeFile(join(root, fingerprintFile), `${await packageFingerprint(root, fingerprintFile)}\n`, 'utf8');
};

const writePackageJson = async (root, value) => {
  await writeFile(join(root, 'package.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const resolveDependencyRoot = (name, fromRoot) => {
  try {
    return dirname(require.resolve(`${name}/package.json`, { paths: [fromRoot] }));
  } catch {
    try {
      let current = dirname(require.resolve(name, { paths: [fromRoot] }));
      while (current !== dirname(current)) {
        if (existsSync(join(current, 'package.json'))) return current;
        current = dirname(current);
      }
      return null;
    } catch {
      return null;
    }
  }
};

const collectRuntimePackages = async (seeds) => {
  const packages = new Map();
  const visit = async (fallbackName, root) => {
    if (!root || packages.has(root)) return;
    const manifest = await readPackage(root);
    const name = typeof manifest.name === 'string' ? manifest.name : fallbackName;
    packages.set(root, { manifest, name, root });
    for (const dependencyName of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      const dependencyRoot = resolveDependencyRoot(dependencyName, root);
      if (dependencyRoot) await visit(dependencyName, dependencyRoot);
    }
  };
  for (const seed of seeds) await visit(seed.name, seed.root);
  return [...packages.values()].sort((left, right) => left.name.localeCompare(right.name));
};

const copyRuntimeLicenses = async (root, packages) => {
  const licenseRoot = join(root, 'licenses');
  await mkdir(licenseRoot, { recursive: true });
  const candidateNames = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'NOTICE'];
  for (const item of packages) {
    for (const fileName of candidateNames) {
      try {
        const safeName = `${item.name.replaceAll('/', '__')}@${item.manifest.version}-${fileName}`;
        await cp(join(item.root, fileName), join(licenseRoot, safeName));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
};

const bundleNodeServer = async (entryPoint, outfile) => {
  await build({
    absWorkingDir: packageDirectory,
    bundle: true,
    entryPoints: [entryPoint],
    format: 'cjs',
    legalComments: 'eof',
    mainFields: ['module', 'main'],
    outfile,
    platform: 'node',
    sourcemap: false,
    target: ['node22'],
  });
};

const {
  VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION,
  VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION,
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
  VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION,
  VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION,
  VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION,
  VARIN_BUILTIN_RETRIEVAL_SEMANTIC_EXTENSION,
} = await import('../dist/index.js');
const { VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE } = await import('../dist/host.js');

const typescriptLanguageServerRoot = packageRoot('typescript-language-server');
const typescriptRoot = packageRoot('typescript');
const typescriptLanguageServerPackage = await readPackage(typescriptLanguageServerRoot);
const typescriptPackage = await readPackage(typescriptRoot);

await rm(typescriptOutputRoot, { force: true, recursive: true });
await mkdir(join(typescriptOutputRoot, 'runtime'), { recursive: true });
await bundleNodeServer(
  join(packageDirectory, 'src', 'host', 'typescript-language-extension.ts'),
  join(typescriptOutputRoot, 'host.cjs'),
);
await cp(
  join(typescriptLanguageServerRoot, 'lib', 'cli.mjs'),
  join(typescriptOutputRoot, 'runtime', 'typescript-language-server.mjs'),
);
await cp(join(typescriptRoot, 'lib'), join(typescriptOutputRoot, 'runtime', 'typescript', 'lib'), { recursive: true });
await writePackageJson(join(typescriptOutputRoot, 'runtime', 'typescript'), {
  name: 'typescript',
  private: true,
  version: typescriptPackage.version,
});
await cp(join(typescriptLanguageServerRoot, 'LICENSE'), join(typescriptOutputRoot, 'LICENSE.typescript-language-server'));
await cp(join(typescriptRoot, 'LICENSE.txt'), join(typescriptOutputRoot, 'LICENSE.typescript'));
await cp(join(typescriptRoot, 'ThirdPartyNoticeText.txt'), join(typescriptOutputRoot, 'THIRD_PARTY_NOTICES.typescript'));
await writePackageJson(typescriptOutputRoot, {
  name: 'varin-builtin-typescript-language',
  private: true,
  type: 'module',
  version: typescriptLanguageServerPackage.version,
});

const expectedVersion = `${typescriptLanguageServerPackage.version}+typescript.${typescriptPackage.version}.varin.1`;
if (VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION.manifest.version !== expectedVersion) {
  throw new Error(`TypeScript language extension version must be ${expectedVersion}`);
}
await writeFile(
  join(typescriptOutputRoot, 'varin.extension.json'),
  `${JSON.stringify(VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION.manifest, null, 2)}\n`,
  'utf8',
);

// Fail the build if the copied server accidentally stops being a self-contained ESM entrypoint.
const serverSource = await readFile(join(typescriptOutputRoot, 'runtime', 'typescript-language-server.mjs'), 'utf8');
if (!serverSource.startsWith('#!/usr/bin/env node') || !serverSource.includes("from 'node:")) {
  throw new Error('typescript-language-server runtime asset is no longer the expected self-contained Node entrypoint');
}
await writePackageFingerprint(typescriptOutputRoot, VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE);

await rm(languageServersOutputRoot, { force: true, recursive: true });
await mkdir(join(languageServersOutputRoot, 'runtime'), { recursive: true });
await bundleNodeServer(
  join(packageDirectory, 'src', 'host', 'language-servers-extension.ts'),
  join(languageServersOutputRoot, 'host.cjs'),
);
const pyrightRoot = packageRoot('pyright');
await cp(
  join(pyrightRoot, 'langserver.index.js'),
  join(languageServersOutputRoot, 'runtime', 'pyright-langserver.cjs'),
);
await cp(join(pyrightRoot, 'dist'), join(languageServersOutputRoot, 'runtime', 'dist'), {
  recursive: true,
  filter: (source) => !source.endsWith('.map'),
});
await writePackageJson(join(languageServersOutputRoot, 'runtime', 'dist'), {
  name: 'pyright-runtime',
  private: true,
  type: 'commonjs',
});
await cp(join(pyrightRoot, 'LICENSE.txt'), join(languageServersOutputRoot, 'LICENSE.pyright'));

const extractedRoot = packageRoot('vscode-langservers-extracted');
const extractedServers = [
  ['html-language-server/node/htmlServerMain.js', 'html-language-server.cjs'],
  ['css-language-server/node/cssServerMain.js', 'css-language-server.cjs'],
  ['json-language-server/node/jsonServerMain.js', 'json-language-server.cjs'],
];
for (const [entry, outputName] of extractedServers) {
  await bundleNodeServer(
    join(extractedRoot, 'lib', entry),
    join(languageServersOutputRoot, 'runtime', outputName),
  );
}
await cp(join(extractedRoot, 'LICENSE'), join(languageServersOutputRoot, 'LICENSE.vscode-langservers-extracted'));

const yamlRoot = packageRoot('yaml-language-server');
await bundleNodeServer(
  join(yamlRoot, 'out', 'server', 'src', 'server.js'),
  join(languageServersOutputRoot, 'runtime', 'yaml-language-server.cjs'),
);
await cp(join(yamlRoot, 'l10n'), join(languageServersOutputRoot, 'l10n'), { recursive: true });
await cp(join(yamlRoot, 'LICENSE'), join(languageServersOutputRoot, 'LICENSE.yaml-language-server'));

const bashRoot = packageRoot('bash-language-server');
await bundleNodeServer(
  join(bashRoot, 'out', 'cli.js'),
  join(languageServersOutputRoot, 'runtime', 'bash-language-server.cjs'),
);
// The Bash server loads these files relative to its compiled server module at runtime.
await cp(join(bashRoot, 'out', 'get-options.sh'), join(languageServersOutputRoot, 'runtime', 'get-options.sh'));
await cp(join(bashRoot, 'tree-sitter-bash.wasm'), join(languageServersOutputRoot, 'tree-sitter-bash.wasm'));
await writeFile(join(languageServersOutputRoot, 'LICENSE.bash-language-server'), BASH_LANGUAGE_SERVER_LICENSE, 'utf8');
const oneIniWasmRoot = dirname(require.resolve('@one-ini/wasm/package.json', { paths: [bashRoot] }));
await cp(join(oneIniWasmRoot, 'one_ini_bg.wasm'), join(languageServersOutputRoot, 'runtime', 'one_ini_bg.wasm'));
await cp(join(oneIniWasmRoot, 'LICENSE'), join(languageServersOutputRoot, 'LICENSE.one-ini-wasm'));
const webTreeSitterRoot = dirname(require.resolve('web-tree-sitter', { paths: [bashRoot] }));
await cp(join(webTreeSitterRoot, 'web-tree-sitter.wasm'), join(languageServersOutputRoot, 'runtime', 'web-tree-sitter.wasm'));
await cp(join(webTreeSitterRoot, 'LICENSE'), join(languageServersOutputRoot, 'LICENSE.web-tree-sitter'));
const runtimePackages = await collectRuntimePackages([
  { name: 'pyright', root: pyrightRoot },
  { name: 'vscode-langservers-extracted', root: extractedRoot },
  { name: 'yaml-language-server', root: yamlRoot },
  { name: 'bash-language-server', root: bashRoot },
  { name: '@one-ini/wasm', root: oneIniWasmRoot },
  { name: 'web-tree-sitter', root: webTreeSitterRoot },
]);
await copyRuntimeLicenses(languageServersOutputRoot, runtimePackages);

await writePackageJson(languageServersOutputRoot, {
  name: 'varin-builtin-language-servers',
  private: true,
  type: 'module',
  version: VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION.manifest.version,
});
await writeFile(
  join(languageServersOutputRoot, 'THIRD_PARTY_NOTICES.language-servers.txt'),
  [
    'Varin bundled language servers',
    '',
    ...runtimePackages.map(({ name, manifest }) => `${name}@${manifest.version} (${manifest.license ?? 'SEE PACKAGE METADATA'})`),
    '',
    'License texts are preserved in licenses/ where supplied by the runtime packages; direct runtime licenses are also kept at this package root.',
    'esbuild legal comments are retained at the end of each bundled server file.',
    '',
  ].join('\n'),
  'utf8',
);
await writeFile(
  join(languageServersOutputRoot, 'varin.extension.json'),
  `${JSON.stringify(VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION.manifest, null, 2)}\n`,
  'utf8',
);
await writePackageFingerprint(languageServersOutputRoot, VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE);

await rm(recoveryOutputRoot, { force: true, recursive: true });
await mkdir(recoveryOutputRoot, { recursive: true });
await bundleNodeServer(
  join(packageDirectory, 'src', 'host', 'recovery-extension.ts'),
  join(recoveryOutputRoot, 'host.cjs'),
);
await writePackageJson(recoveryOutputRoot, {
  name: 'varin-builtin-recovery',
  private: true,
  type: 'module',
  version: VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest.version,
});
await writeFile(
  join(recoveryOutputRoot, 'varin.extension.json'),
  `${JSON.stringify(VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest, null, 2)}\n`,
  'utf8',
);
await writePackageFingerprint(recoveryOutputRoot, VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE);

const contextOutputRoot = join(builtinOutputRoot, 'context-fragments');
await rm(contextOutputRoot, { force: true, recursive: true });
await mkdir(contextOutputRoot, { recursive: true });
await bundleNodeServer(join(packageDirectory, 'src', 'host', 'context-fragments-extension.ts'), join(contextOutputRoot, 'host.cjs'));
await writePackageJson(contextOutputRoot, { name: 'varin-builtin-context-fragments', private: true, type: 'module', version: VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION.manifest.version });
await writeFile(join(contextOutputRoot, 'varin.extension.json'), `${JSON.stringify(VARIN_BUILTIN_CONTEXT_FRAGMENTS_EXTENSION.manifest, null, 2)}\n`, 'utf8');
await writePackageFingerprint(contextOutputRoot, VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE);

for (const [name, definition] of [
  ['retrieval-structured', VARIN_BUILTIN_RETRIEVAL_STRUCTURED_EXTENSION],
  ['retrieval-keyword', VARIN_BUILTIN_RETRIEVAL_KEYWORD_EXTENSION],
  ['retrieval-semantic', VARIN_BUILTIN_RETRIEVAL_SEMANTIC_EXTENSION],
]) {
  const outputRoot = join(builtinOutputRoot, name);
  await rm(outputRoot, { force: true, recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await bundleNodeServer(join(packageDirectory, 'src', 'host', `${name}-extension.ts`), join(outputRoot, 'host.cjs'));
  await writePackageJson(outputRoot, { name: `varin-builtin-${name}`, private: true, type: 'module', version: definition.manifest.version });
  await writeFile(join(outputRoot, 'varin.extension.json'), `${JSON.stringify(definition.manifest, null, 2)}\n`, 'utf8');
  await writePackageFingerprint(outputRoot, VARIN_BUILTIN_ARTIFACT_FINGERPRINT_FILE);
}
