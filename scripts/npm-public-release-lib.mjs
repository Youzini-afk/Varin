import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const NPM_PUBLIC_REPOSITORY = 'https://github.com/Astrmira/Varin.git';

export const NPM_PUBLIC_PACKAGES = Object.freeze([
  { directory: 'packages/extension-contract', name: '@varin/extension-contract' },
  { directory: 'packages/extension-surface', name: '@varin/extension-surface' },
  { directory: 'packages/extension-sdk', name: '@varin/extension-sdk' },
  { directory: 'packages/extension-react', name: '@varin/extension-react' },
  { directory: 'packages/extension-cli', name: '@varin/extension-cli' },
]);

const PUBLIC_PACKAGE_NAMES = new Set(NPM_PUBLIC_PACKAGES.map(({ name }) => name));
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CLI_TEMPLATE_PATH = 'packages/extension-cli/src/templates.ts';
const CLI_TEMPLATE_PACKAGES = [
  '@varin/extension-contract',
  '@varin/extension-sdk',
  '@varin/extension-cli',
];

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));
const writeJson = async (filePath, value) => writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);

const manifestPath = (root, definition) => path.join(root, definition.directory, 'package.json');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateDependencyPattern = (name) => new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*")[^"]+("[,])`, 'g');

const repositoryUrl = (repository) => (
  typeof repository === 'string' ? repository : repository?.url
);

const collectExportTargets = (value, targets = []) => {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value.slice(2));
    return targets;
  }
  if (!value || typeof value !== 'object') return targets;
  for (const nested of Object.values(value)) collectExportTargets(nested, targets);
  return targets;
};

export const npmVersionFromTag = (tag) => {
  if (typeof tag !== 'string' || !tag.startsWith('npm-v')) {
    throw new Error(`Expected an npm-v<version> tag, received ${JSON.stringify(tag)}`);
  }
  const version = tag.slice('npm-v'.length);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid npm release version in tag ${JSON.stringify(tag)}`);
  }
  return version;
};

export const assertNpmVersion = (version) => {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a SemVer release version, received ${JSON.stringify(version)}`);
  }
  return version;
};

export const readNpmPublicPackageSet = async (root) => Promise.all(
  NPM_PUBLIC_PACKAGES.map(async (definition) => ({
    ...definition,
    manifest: await readJson(manifestPath(root, definition)),
  })),
);

const collectManifestIssues = (packages, expectedVersion) => {
  const issues = [];
  for (const definition of packages) {
    const { manifest } = definition;
    if (manifest.name !== definition.name) {
      issues.push(`${definition.directory} must be named ${definition.name}, found ${manifest.name ?? 'no name'}`);
    }
    if (manifest.private === true) issues.push(`${definition.name} is marked private`);
    if (manifest.publishConfig?.access !== 'public') {
      issues.push(`${definition.name} must declare publishConfig.access=public`);
    }
    if (repositoryUrl(manifest.repository) !== NPM_PUBLIC_REPOSITORY) {
      issues.push(`${definition.name} repository.url must be ${NPM_PUBLIC_REPOSITORY}`);
    }
    if (manifest.repository?.directory !== definition.directory) {
      issues.push(`${definition.name} repository.directory must be ${definition.directory}`);
    }
    if (expectedVersion && manifest.version !== expectedVersion) {
      issues.push(`${definition.name} is ${manifest.version ?? 'unversioned'}, expected ${expectedVersion}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:')) {
          issues.push(`${definition.name} ${field}.${dependency} cannot use ${range} in a public package`);
        }
        if (expectedVersion && PUBLIC_PACKAGE_NAMES.has(dependency) && range !== expectedVersion) {
          issues.push(`${definition.name} ${field}.${dependency} is ${range}, expected ${expectedVersion}`);
        }
      }
    }
  }
  return issues;
};

export const verifyNpmPublicRelease = async (root, tag, options = {}) => {
  const version = npmVersionFromTag(tag);
  const packages = await readNpmPublicPackageSet(root);
  const issues = collectManifestIssues(packages, version);
  const cliTemplate = await readFile(path.join(root, CLI_TEMPLATE_PATH), 'utf8');
  for (const name of CLI_TEMPLATE_PACKAGES) {
    const matches = [...cliTemplate.matchAll(templateDependencyPattern(name))];
    if (matches.length !== 1) {
      issues.push(`CLI template must declare ${name} exactly once`);
    } else if (!matches[0][0].includes(`"${version}"`)) {
      issues.push(`CLI template ${name} does not use ${version}`);
    }
  }
  if (options.requireBuild) {
    for (const entry of packages) {
      const required = new Set([
        entry.manifest.main,
        entry.manifest.types,
        ...Object.values(entry.manifest.bin ?? {}),
        ...collectExportTargets(entry.manifest.exports),
      ].filter((value) => typeof value === 'string').map((value) => value.replace(/^\.\//, '')));
      for (const relativePath of required) {
        try {
          await readFile(path.join(root, entry.directory, relativePath));
        } catch {
          issues.push(`${entry.name} is missing built artifact ${relativePath}`);
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new Error(`Invalid public npm release:\n- ${issues.join('\n- ')}`);
  }
  return { packages, tag, version };
};

export const prepareNpmPublicVersion = async (root, version) => {
  assertNpmVersion(version);
  const packages = await readNpmPublicPackageSet(root);
  const staticIssues = collectManifestIssues(packages);
  if (staticIssues.length > 0) {
    throw new Error(`Cannot prepare public npm packages:\n- ${staticIssues.join('\n- ')}`);
  }
  for (const entry of packages) {
    entry.manifest.version = version;
    for (const field of DEPENDENCY_FIELDS) {
      for (const dependency of Object.keys(entry.manifest[field] ?? {})) {
        if (PUBLIC_PACKAGE_NAMES.has(dependency)) entry.manifest[field][dependency] = version;
      }
    }
    await writeJson(manifestPath(root, entry), entry.manifest);
  }
  const cliTemplatePath = path.join(root, CLI_TEMPLATE_PATH);
  let cliTemplate = await readFile(cliTemplatePath, 'utf8');
  for (const name of CLI_TEMPLATE_PACKAGES) {
    const pattern = templateDependencyPattern(name);
    const matches = [...cliTemplate.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`CLI template must declare ${name} exactly once`);
    cliTemplate = cliTemplate.replace(pattern, `$1${version}$2`);
  }
  await writeFile(cliTemplatePath, cliTemplate);
  return packages.map(({ directory, name }) => ({ directory, name, version }));
};

export const requiredPackedPaths = (manifest) => new Set([
  'package.json',
  'README.md',
  manifest.main,
  manifest.types,
  ...Object.values(manifest.bin ?? {}),
  ...collectExportTargets(manifest.exports),
].filter((value) => typeof value === 'string').map((value) => value.replace(/^\.\//, '')));

export const assertPackedPackage = (entry, packed) => {
  const issues = [];
  if (packed.name !== entry.name) issues.push(`packed name is ${packed.name}`);
  if (packed.version !== entry.manifest.version) issues.push(`packed version is ${packed.version}`);
  if (!packed.integrity) issues.push('integrity is missing');
  const paths = new Set((packed.files ?? []).map(({ path: filePath }) => filePath));
  for (const required of requiredPackedPaths(entry.manifest)) {
    if (!paths.has(required)) issues.push(`missing ${required}`);
  }
  if (issues.length > 0) throw new Error(`${entry.name} tarball is invalid: ${issues.join(', ')}`);
};

export const registryPackageVersion = async (name, version, fetchImpl = fetch) => {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'cache-control': 'no-cache',
    },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${name}@${version}`);
  return response.json();
};

export const existingArtifactDecision = (metadata, artifact) => {
  if (!metadata) return 'publish';
  if (metadata.dist?.integrity === artifact.integrity) return 'skip';
  throw new Error(
    `${artifact.name}@${artifact.version} already exists with different integrity; `
      + 'npm versions are immutable, so the release cannot continue',
  );
};
