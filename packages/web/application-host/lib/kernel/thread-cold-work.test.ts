import { expect, it, vi } from 'vitest';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { ColdBotWork } from './protocol.generated.js';
import { ThreadAdapter, type ThreadModelAuthority } from './thread-adapter.js';
import type { ContextPreparer } from './thread-context.js';

it('prepares the original cold collaboration ingress using the receiving thread scope', async () => {
  const work: ColdBotWork = { threadId: 'thread:receiver', branchId: 'branch:receiver', inputId: 'input:request', revision: 1, ownerEpoch: 1 };
  const receivingIdentity = { runtime: 'agent', threadId: work.threadId, branchId: work.branchId };
  const configuration = { providerId: 'local-model' } as Awaited<ReturnType<ThreadModelAuthority['resolveModel']>>['configuration'];
  const credentialScope = { reference: 'scope', authority: 'fixture', account: 'receiver', generation: 1 };
  const release = vi.fn();
  const credentialOwner = { scope: vi.fn(async () => credentialScope), release } as unknown as ExistingHostCredentialOwner;
  const runtime = {
    pendingBotWork: vi.fn(async () => [work]),
    thread: vi.fn(async () => ({ principal_id: 'receiver' })),
    principalCanUseHostResources: vi.fn(async () => false),
    admitBotWork: vi.fn(async () => ({ run_id: 'run:receiver' })),
  };
  const initial = { effectiveSystemPrompt: 'receiver context', instructionSources: [], memoryCheckpoint: 'checkpoint' };
  const main = vi.fn(async () => initial);
  const prepareContext = Object.assign(vi.fn(async () => initial), { main }) as ContextPreparer;
  const admitSource = vi.fn();
  const onError = vi.fn();
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, admitSource, onError, undefined, prepareContext);
  const defaultSource = vi.fn(async () => null);
  adapter.bindDefaultDeviceSource(defaultSource);
  adapter.bindConversationWorkModel(async () => ({ providerId: 'receiver-provider', modelId: 'receiver-model' }));
  const launch = vi.spyOn(adapter, 'continueLaunch').mockResolvedValue(undefined);
  const { signal } = new AbortController();

  await adapter.recoverBotWork(signal);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('run:receiver', { credentialOwner, signal }));

  expect(runtime.principalCanUseHostResources).toHaveBeenCalledWith('receiver');
  expect(defaultSource).not.toHaveBeenCalled();
  expect(admitSource).not.toHaveBeenCalled();
  expect(main).toHaveBeenCalledWith(receivingIdentity, null, signal);
  expect(runtime.admitBotWork).toHaveBeenCalledExactlyOnceWith({
    work, configuration, initialContext: initial,
    launch: { inheritSource: false, source: null, enabledTools: [], credentialScope },
  }, signal);
  expect(release).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it('keeps a cold request queued when no receiving model is available', async () => {
  const work: ColdBotWork = { threadId: 'thread:receiver', branchId: 'branch:receiver', inputId: 'input:request', revision: 5, ownerEpoch: 1 };
  const runtime = {
    pendingBotWork: vi.fn(async () => [work]),
    holdColdWork: vi.fn(async () => null),
    admitBotWork: vi.fn(),
  };
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const prepareContext = vi.fn() as unknown as ContextPreparer;
  const onError = vi.fn();
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, vi.fn(), onError, undefined, prepareContext);
  adapter.bindConversationWorkModel(async () => null);
  const { signal } = new AbortController();

  await adapter.recoverBotWork(signal);
  await vi.waitFor(() => expect(runtime.holdColdWork).toHaveBeenCalledExactlyOnceWith({
    inputId: work.inputId, revision: work.revision, reason: 'model_unavailable',
  }, signal));
  expect(runtime.admitBotWork).not.toHaveBeenCalled();
  expect(models.resolveModel).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
