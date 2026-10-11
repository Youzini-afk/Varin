import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fauxProvider } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/compat';
import type { HostEventData } from '@varin/protocol';
import { SessionHost } from '../src/session-host.js';
import { GlobalSettingsAuthority } from '../src/settings-authority.js';

test('external profile CAS keeps the active Pi exchange frozen and is loaded before the next prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-profile-boundary-'));
  const path = join(root, 'settings.json');
  const tools = { pi: ['read'], agent: ['file_read'] };
  await writeFile(path, JSON.stringify({ preserved: 'user asset', harness: { models: {
    worker: { agent: { name: 'worker A', description: 'PROFILE_REVISION_A', tools } },
  } } }));
  const external = new GlobalSettingsAuthority(root);
  const faux = fauxProvider();
  const model = faux.getModel();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const requests: string[] = [];
  faux.setResponses([
    async context => { requests.push(JSON.stringify(context)); started(); await held; return fauxAssistantMessage('first completed'); },
    context => { requests.push(JSON.stringify(context)); return fauxAssistantMessage('second completed'); },
  ]);
  const host = new SessionHost({ agentDir: root, projectTrustOverride: true,
    configureServices: async services => {
      services.modelRuntime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple,
        api: model.api, baseUrl: model.baseUrl, models: [{ api: model.api, baseUrl: model.baseUrl,
          contextWindow: model.contextWindow, cost: model.cost, id: model.id, input: model.input,
          maxTokens: model.maxTokens, name: model.name, reasoning: model.reasoning }] });
      await services.modelRuntime.setRuntimeApiKey(model.provider, 'faux-key');
      return { model };
    },
    emit: (event, data) => {
      if (event !== 'harness.request') return;
      const request = data as HostEventData<'harness.request'>;
      queueMicrotask(() => host.respondHarness(host.sessionId ?? '', request.requestId, {
        ok: false, error: { code: 'unavailable', message: 'No external service in this fixture' },
      }));
    },
  });
  host.setHarnessThreadRuntimeEnabled(true);
  try {
    const { sessionId } = await host.create(root);
    await host.prompt(sessionId, 'first');
    await firstStarted;
    assert.match(requests[0]!, /PROFILE_REVISION_A/);
    const before = await external.read();
    await external.updateHarness(before.revision, harness => ({ ...harness, models: {
      worker: { agent: { name: 'worker B', description: 'PROFILE_REVISION_B', tools } },
    } }));
    // Disk changed, but the SDK definition and currently executing provider request did not.
    assert.equal(host.session.isIdle, false);
    assert.match(JSON.stringify(host.session.getToolDefinition('dispatch')!.promptGuidelines), /PROFILE_REVISION_A/);
    assert.doesNotMatch(requests[0]!, /PROFILE_REVISION_B/);
    assert.match(JSON.stringify(host.runtime.services.settingsManager.getGlobalSettings()), /PROFILE_REVISION_A/);
    // Exercise the SDK's real unrelated-field merge while its harness cache is still A.
    host.runtime.services.settingsManager.setTheme('light');
    await host.runtime.services.settingsManager.flush();
    const whileActive = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(whileActive.theme, 'light');
    assert.equal(whileActive.harness.models.worker.agent.description, 'PROFILE_REVISION_B');
    assert.deepEqual(whileActive.harness.models.worker.agent.tools, tools);
    assert.match(JSON.stringify(host.runtime.services.settingsManager.getGlobalSettings()), /PROFILE_REVISION_A/);
    release();
    await host.session.waitForIdle();
    await host.prompt(sessionId, 'second');
    await host.session.waitForIdle();
    assert.match(requests[1]!, /PROFILE_REVISION_B/);
    assert.doesNotMatch(JSON.stringify(host.session.getToolDefinition('dispatch')!.promptGuidelines), /PROFILE_REVISION_A/);
    // Reloading at the boundary also retains the original unrelated asset.
    await host.runtime.services.settingsManager.flush();
    const disk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(disk.preserved, 'user asset');
    assert.equal(disk.harness.models.worker.agent.description, 'PROFILE_REVISION_B');
    assert.deepEqual(disk.harness.models.worker.agent.tools, tools);
  } finally {
    release();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('manual compaction has a cancellable activity while its pending settings reload is awaiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-profile-compaction-stop-'));
  const host = new SessionHost({ agentDir: root, projectTrustOverride: true, emit: () => {} });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  try {
    const { sessionId } = await host.create(root);
    const current = await host.getSettings();
    await host.updateSettings('global', { harness: { models: { worker: { agent: { name: 'Changed worker' } } } } }, [], current.globalRevision);
    const manager = host.runtime.services.settingsManager;
    const reload = manager.reload.bind(manager);
    const session = host.session;
    const compact = session.compact.bind(session);
    let entered!: () => void;
    const reloadEntered = new Promise<void>(resolve => { entered = resolve; });
    let compactCalls = 0;
    manager.reload = async () => { entered(); await blocked; await reload(); };
    session.compact = async () => { compactCalls += 1; throw new Error('Cancelled compaction must not start'); };
    try {
      const pending = host.compact(sessionId);
      // Observe the owner identity synchronously before the first file/reload await.
      const activity = host.snapshot().runId;
      assert.ok(activity);
      assert.equal(host.snapshot().isCompacting, true);
      await reloadEntered;
      assert.equal(await host.abort(sessionId, activity), true);
      const rejected = assert.rejects(pending, { code: 'aborted' });
      release();
      await rejected;
      assert.equal(compactCalls, 0);
      assert.equal(host.snapshot().busy, false);
    } finally { manager.reload = reload; session.compact = compact; }
  } finally { release(); await host.dispose(); await rm(root, { recursive: true, force: true }); }
});
