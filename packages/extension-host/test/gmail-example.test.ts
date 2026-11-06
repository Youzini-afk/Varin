import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { ApplicationExtensionRuntime } from '../src/index.js';

test('Gmail example installs and activates in the actual broker without account credentials', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-gmail-example-'));
  const source = join(root, 'extension');
  const previousDirectory = process.env.VARIN_GMAIL_CONFIG_DIR;
  process.env.VARIN_GMAIL_CONFIG_DIR = join(root, 'no-credentials');
  let runtime: ApplicationExtensionRuntime | undefined;
  try {
    await mkdir(join(source, 'dist'), { recursive: true });
    await copyFile(fileURLToPath(new URL('../../../examples/extensions/gmail/varin.extension.json', import.meta.url)), join(source, 'varin.extension.json'));
    await copyFile(fileURLToPath(new URL('../../../examples/extensions/gmail/settings.css', import.meta.url)), join(source, 'settings.css'));
    await build({ entryPoints: [fileURLToPath(new URL('../../../examples/extensions/gmail/host.mjs', import.meta.url))],
      outfile: join(source, 'dist/host.cjs'), bundle: true, platform: 'node', format: 'cjs',
      alias: { '@varin/extension-sdk': fileURLToPath(new URL('../../extension-sdk/dist/index.js', import.meta.url)) } });
    await build({ entryPoints: [fileURLToPath(new URL('../../../examples/extensions/gmail/settings.mjs', import.meta.url))],
      outfile: join(source, 'dist/settings.cjs'), bundle: true, platform: 'browser', format: 'cjs',
      alias: { '@varin/extension-sdk': fileURLToPath(new URL('../../extension-sdk/dist/index.js', import.meta.url)) } });
    runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '0.9.38',
      brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)) });
    const started = await runtime.start();
    await runtime.installOrStage({ expectedRevision: started.catalog.revision,
      source: { kind: 'local', display: 'Gmail fixture', specifier: source } });
    for (const [serviceId, operation] of [
      ['example.gmail.status', 'read'], ['example.gmail.search', 'read'],
      ['example.gmail.read', 'read'], ['example.gmail.send', 'effect'],
    ]) {
      const descriptor = await runtime.invokeService({ serviceId, version: 1, method: 'inspect', args: [] }) as { tool: { operation: string } };
      assert.equal(descriptor.tool.operation, operation);
    }
    const status = await runtime.invokeService({ serviceId: 'example.gmail.status', version: 1, method: 'execute', args: [{}] }) as { configured: boolean };
    assert.equal(status.configured, false);
    const connection = await runtime.invokeService({ serviceId: 'example.gmail.connection', version: 1, method: 'status', args: [] }) as { phase: string };
    assert.equal(connection.phase, 'disconnected');
    // No Google request can be issued without the isolated credential fixture.
    await assert.rejects(runtime.invokeService({ serviceId: 'example.gmail.send', version: 1, method: 'execute',
      args: [{ to: ['nobody@example.com'], subject: 'fixture', body: 'fixture' }] }), /approved tool invocation/);
  } finally {
    await runtime?.stop();
    if (previousDirectory === undefined) delete process.env.VARIN_GMAIL_CONFIG_DIR;
    else process.env.VARIN_GMAIL_CONFIG_DIR = previousDirectory;
    await rm(root, { recursive: true, force: true });
  }
});
