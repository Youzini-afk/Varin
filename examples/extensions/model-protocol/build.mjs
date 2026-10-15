import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseVarinExtensionManifest,
  VARIN_MODELS_SERVICE,
} from '../../../packages/extension-contract/dist/index.js';

const root = new URL('../../../', import.meta.url);
const require = createRequire(new URL('packages/extension-builtins/package.json', root));
const { build } = require('esbuild');
const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// The shared constant is the schema authority for both cold discovery and SDK registration.
// Keep the generated JSON in the example so authors can inspect the complete declaration.
const manifest = parseVarinExtensionManifest({
  schemaVersion: 1,
  id: 'example.model-protocol',
  displayName: 'Example model protocol',
  version: metadata.version,
  engines: { varin: '*' },
  entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
  provides: { services: [structuredClone(VARIN_MODELS_SERVICE)] },
});

const result = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: [fileURLToPath(new URL('./host.ts', import.meta.url))],
  alias: {
    '@varin/extension-sdk': fileURLToPath(new URL('packages/extension-sdk/dist/index.js', root)),
    '@varin/extension-contract': fileURLToPath(new URL('packages/extension-contract/dist/index.js', root)),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: fileURLToPath(new URL('./host.cjs', import.meta.url)),
  metafile: true,
  write: false,
});
if (Object.values(result.metafile.outputs).some(output => output.imports.length)) {
  throw new Error('The model protocol bundle must have no runtime imports');
}
await writeFile(new URL('./host.cjs', import.meta.url), result.outputFiles[0].contents);
await writeFile(new URL('./varin.extension.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
