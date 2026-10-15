import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ApplicationExtensionRuntime } from '../src/application-runtime.js';

const extensionId = 'example.transition';
const service = { id: 'example.transition.service', version: 1 };

/** Self-contained CJS entrypoints exercise the real package, catalog and child broker. */
async function fixture(withHost: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-host-transition-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const write = async (host: boolean, version: string) => {
    await writeFile(join(source, 'varin.extension.json'), JSON.stringify({
      schemaVersion: 1, id: extensionId, version, engines: { varin: '*' },
      entrypoints: {
        surfaces: [{ id: 'panel', file: 'surface.cjs', mode: 'managed', supports: ['web'] }],
        ...(host ? { host: { file: 'host.cjs', mode: 'brokered', activation: ['application-startup'] } } : {}),
      },
      ...(host ? { provides: { services: [service] } } : {}),
    }));
    await writeFile(join(source, 'surface.cjs'), 'exports.activate = () => {};');
    await writeFile(join(source, 'host.cjs'),
      `exports.activate = ctx => { ctx.services.provide(${JSON.stringify(service)}, { read() { return 'original handler'; } }); };`);
  };
  let runtime: ApplicationExtensionRuntime | undefined;
  const close = async () => {
    try { await runtime?.stop(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };
  try {
    await write(withHost, '1.0.0');
    runtime = await ApplicationExtensionRuntime.create({
      dataDir: join(directory, 'data'), varinVersion: '1.2.3',
      brokerScript: fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.url)),
    });
    const owner = runtime;
    await owner.installOrStage({ expectedRevision: 0, source: { kind: 'local', display: 'transition', specifier: source } });
    return {
      runtime: owner, close,
      async stage(host: boolean) {
        await write(host, '1.1.0');
        const staged = await owner.reloadLocalSource({
          extensionId, expectedRevision: (await owner.catalog.snapshot()).revision,
        });
        assert.equal(staged.outcome, 'staged');
        if (staged.outcome !== 'staged') throw new Error('Expected staged package');
        const request = { extensionId, candidateIntegrity: staged.candidateIntegrity, expectedRevision: staged.snapshot.revision };
        const requested = await owner.requestCandidateApplication(request);
        return { ...request, expectedRevision: requested.revision };
      },
    };
  } catch (error) { await close(); throw error; }
}

test('an enabled Surface-only package can publish an added Host entrypoint', { timeout: 20_000 }, async () => {
  const owner = await fixture(false);
  try {
    await owner.runtime.selectCandidate(await owner.stage(true));
    const lease = await owner.runtime.prepareService({ serviceId: service.id, version: 1, method: 'read', args: [] });
    try { assert.equal(await lease.invoke('read', []), 'original handler'); }
    finally { lease.release(); }
  } finally { await owner.close(); }
});

test('removing Host stops new calls while an accepted provider pin remains valid', { timeout: 20_000 }, async () => {
  const owner = await fixture(true);
  try {
    const lease = await owner.runtime.prepareService({ serviceId: service.id, version: 1, method: 'read', args: [] });
    const pin = lease.pin();
    try {
      await owner.runtime.selectCandidate(await owner.stage(false));
      const entry = (await owner.runtime.catalog.snapshot()).extensions.find(entry => entry.manifest.id === extensionId);
      assert.equal(entry?.manifest.entrypoints.host, undefined);
      assert.equal(await pin.invoke('read', []), 'original handler');
      await assert.rejects(owner.runtime.invokeService({
        serviceId: service.id, version: 1, providerId: lease.providerId, method: 'read', args: [],
      }));
    } finally { pin.release(); lease.release(); }
  } finally { await owner.close(); }
});
