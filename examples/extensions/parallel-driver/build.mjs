import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseVarinExtensionManifest, VARIN_AGENT_DRIVER_SERVICE, VARIN_AGENT_DRIVER_CAPABILITY } from '../../../packages/extension-contract/dist/index.js';
const root = new URL('../../../', import.meta.url);
const { build } = createRequire(new URL('packages/extension-builtins/package.json', root))('esbuild');
const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const manifest = parseVarinExtensionManifest({ schemaVersion: 1, id: 'example.parallel-driver',
  displayName: 'Parallel Proposal and Challenge', version: metadata.version, engines: { varin: '*' },
  entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
  capabilities: { host: [VARIN_AGENT_DRIVER_CAPABILITY] }, provides: { services: [VARIN_AGENT_DRIVER_SERVICE] } });
await build({ entryPoints: [fileURLToPath(new URL('./host.ts', import.meta.url))],
  alias: { '@varin/extension-sdk': fileURLToPath(new URL('packages/extension-sdk/dist/index.js', root)),
    '@varin/extension-contract': fileURLToPath(new URL('packages/extension-contract/dist/index.js', root)) },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  outfile: fileURLToPath(new URL('./host.cjs', import.meta.url)) });
await writeFile(new URL('./varin.extension.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
