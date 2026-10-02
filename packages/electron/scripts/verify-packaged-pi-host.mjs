#!/usr/bin/env node
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [brokerEntryArgument, hostEntryArgument] = process.argv.slice(2);
if (!brokerEntryArgument || !hostEntryArgument) {
  throw new Error('Usage: verify-packaged-pi-host.mjs <broker-entry> <host-entry>');
}

const brokerEntry = path.resolve(brokerEntryArgument);
const hostEntry = path.resolve(hostEntryArgument);
const hostPackageRoot = path.dirname(path.dirname(hostEntry));
const packagedModules = await realpath(path.resolve(hostPackageRoot, '..', '..'));
const agentDir = await mkdtemp(path.join(os.tmpdir(), 'varin-packaged-host-'));
const previousCwd = process.cwd();
let lifecycle;

try {
  process.chdir(agentDir);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('VARIN_PI_') || name === 'NODE_PATH') delete process.env[name];
  }
  const sdk = await import(pathToFileURL(path.join(hostPackageRoot, 'dist', 'pi-sdk-packages.js')).href);
  for (const name of sdk.PI_SDK_PACKAGE_NAMES) {
    const entry = await realpath(fileURLToPath(sdk.resolvePiSdkSpecifier(hostPackageRoot, name)));
    const relative = path.relative(packagedModules, entry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Bundled Pi dependency resolves outside the packaged application: ${name} -> ${entry}`);
    }
  }
  const codingAgentRoot = sdk.findSdkPackageDir(hostPackageRoot, '@earendil-works/pi-coding-agent');
  for (const reference of ['codemode.md', 'models.md', 'mcp.md']) {
    const content = await readFile(path.join(codingAgentRoot, 'docs', reference), 'utf8');
    if (!content.trim()) throw new Error(`Packaged Pi runtime reference is empty: ${reference}`);
  }
  const runtimeBroker = await import(pathToFileURL(brokerEntry).href);
  const packageManifest = JSON.parse(await readFile(path.join(hostPackageRoot, 'package.json'), 'utf8'));
  const piVersion = packageManifest.dependencies?.['@earendil-works/pi-coding-agent'];
  if (typeof piVersion !== 'string' || !piVersion) {
    throw new Error(`Pi host does not declare its bundled runtime dependency: ${hostPackageRoot}`);
  }
  const createBroker = (options) => new runtimeBroker.PiRuntimeBroker({
    ...options,
    agentDir,
    client: { clientName: 'varin-package-verifier', clientVersion: '0.1.0', mode: 'test' },
    foundationalPackages: [],
    emit: (event) => {
      if (event.kind !== 'diagnostic') return;
      const writer = event.level === 'error' ? console.error : console.log;
      writer(`[varin-package:${event.role}] ${event.message}`);
    },
    projectTrustOverride: true,
  });
  lifecycle = new runtimeBroker.PiRuntimeLifecycle({
    createBroker,
    dataDir: agentDir,
    discovery: {
      commandRunner: async () => { throw new Error('Bundled startup must not search for an external Pi'); },
    },
    hostEntry,
  });
  const handshake = await lifecycle.start();
  if (!handshake) throw new Error('Packaged Pi runtime lifecycle did not activate a Host');
  if (handshake.runtime.source !== 'bundled') {
    throw new Error(`Packaged Pi Host reported unexpected source ${handshake.runtime.source}`);
  }
  if (handshake.runtime.piVersion !== piVersion || lifecycle.snapshot.status !== 'ready') {
    throw new Error(`Packaged Pi Host did not start the expected bundled runtime ${piVersion}`);
  }
  await lifecycle.listSessions(agentDir);
  console.log(`[varin-package] verified default bundled Pi ${handshake.runtime.piVersion} startup and catalog from packaged dependencies`);
} finally {
  await lifecycle?.dispose().catch(() => {});
  process.chdir(previousCwd);
  await rm(agentDir, { force: true, recursive: true });
}
