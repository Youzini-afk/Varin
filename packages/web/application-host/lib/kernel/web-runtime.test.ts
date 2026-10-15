import { expect, it } from 'vitest';
import { WEB_TOOL_DECLARATIONS, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import { createDocumentReader } from '../harness/document-reading.js';
import { createWebFetch } from '../harness/web-fetch.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createWebRuntime, type WebRuntimeOptions } from './web-runtime.js';

it('freezes Web configuration failures at its own declarations and preserves the accepted configuration', async () => {
  const { materials } = createMaterialStoreFixture();
  const unused = async (): Promise<never> => { throw new Error('Configuration preparation must not execute a tool'); };
  const make = (settings: WebRuntimeOptions['settings']) => createWebRuntime({
    runtime: { familyList: unused, run: unused, launch: unused },
    materials, documentReader: createDocumentReader({ materials }),
    webFetch: createWebFetch({ ssrf: { check: unused, isSameHost: () => false }, materials }),
    fetch: unused, readAuth: unused, settings,
  });
  const snapshot: AgentSettingsSnapshot = { global: { harness: { web: { domains: { block: ['blocked.example'] } } } },
    project: {}, globalRevision: 'accepted', projectRevision: 'unselected', projectTrusted: false };
  const run = { runId: 'run', threadId: 'thread', source: null };
  const accepted = await make(async source => { expect(source).toBeNull(); return snapshot; }).prepareConfiguration(run, []);
  const original = accepted(WEB_TOOL_DECLARATIONS[1]);
  expect(JSON.parse(original!).web.settings.domains.block).toEqual(['blocked.example']);
  const failure = new Error('Settings file is unreadable');
  const broken = await make(async () => { throw failure; }).prepareConfiguration(run, [], () => 'other-owner');
  expect(broken(COMPUTER_TOOL_DECLARATIONS[0])).toBe('other-owner');
  expect(() => broken(WEB_TOOL_DECLARATIONS[1])).toThrow(failure);
  expect(broken(WEB_TOOL_DECLARATIONS[1], original)).toBe(original);
});

it('keeps an unconfirmed Storage mutation unknown and unstopped rather than converting a rejected Host promise to no effect', async () => {
  const { MaterialCollectionMutationError, createMaterialCollections } = await import('../harness/material-collections.js');
  const { withToolInvocation } = await import('./tool-invocation.js');
  const opened = createMaterialStoreFixture();
  const unused = async (): Promise<never> => { throw new Error('This mutation never reads a document or network'); };
  const collections = createMaterialCollections(opened.workingStates, { materials: opened.materials });
  collections.execute = async () => { throw new MaterialCollectionMutationError('Original Storage response was lost', 'unknown'); };
  const web = createWebRuntime({
    runtime: { run: async () => ({ thread_id: 'thread', branch_id: 'branch' }),
      familyList: async () => ({ rootThreadId: 'thread', members: [{ threadId: 'thread', branches: [{ branchId: 'branch' }] }] }), launch: unused } as unknown as WebRuntimeOptions['runtime'],
    materials: opened.materials, collections, documentReader: createDocumentReader({ materials: opened.materials }),
    webFetch: createWebFetch({ ssrf: { check: unused, isSameHost: () => false }, materials: opened.materials }),
    fetch: unused, readAuth: unused,
    settings: async () => ({ global: {}, project: {}, globalRevision: 'global', projectRevision: 'project', projectTrusted: false }),
  });
  const declaration = WEB_TOOL_DECLARATIONS.find(value => value.tool!.name === 'materials')!;
  const prepare = await web.prepareConfiguration({ runId: 'run', threadId: 'thread', source: null }, []);
  const args = { action: 'create' }, owner = { extensionId: 'varin.builtin.web', extensionVersion: '0.1.0', entrypointId: 'host', instanceKey: 'web-runtime-fixture', generation: 1 };
  const signal = new AbortController().signal;
  let receipt: import('./tool-bridge.js').ToolExecutionReceipt | undefined;
  await withToolInvocation({ owner, signal, onEffectReceipt: value => { receipt = value; }, authority: {
    invocationId: 'invocation', runId: 'run', threadId: 'thread', operationId: 'request:tool:call', callId: 'call',
    origin: { kind: 'model_step', request_id: 'request' }, executorOwner: { kind: 'external', identity: 'provider', epoch: 'owner' },
    source: null, operation: 'effect', completion: 'result', toolName: 'materials', configurationIdentity: prepare(declaration), arguments: args,
  } }, async invocation => { await web.capability('collections', args, { owner, signal, invocation }); });
  expect(receipt).toMatchObject({ executor_stopped: false, completion: { outcome: 'indeterminate', effect: 'unknown' } });
});
