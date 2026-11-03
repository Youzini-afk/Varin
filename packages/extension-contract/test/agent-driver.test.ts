import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultVarinExtensionServiceRoutingDocument } from '../src/service-routing.js';
import {
  parseVarinAgentDriverDescription, parseVarinAgentDriverRunInput, parseVarinAgentDriverRunOutcome, resolveVarinAgentDriverRouting,
  VARIN_AGENT_DRIVER_SERVICE_ID, VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY,
} from '../src/agent-driver.js';

const extension = { providerKey: 'example.parallel-driver:host:varin.agent.driver@1', providerId: 'original-generation' };
const context = { userId: 'default', workspaceId: 'workspace-native-id', threadId: 'thread' };
const rule = (providerKeys: string[], scope: object = { userId: 'default' }, version = 1) => ({
  serviceId: VARIN_AGENT_DRIVER_SERVICE_ID, version, providerKeys, scope, allowFallback: true,
});
const resolve = (...rules: ReturnType<typeof rule>[]) => resolveVarinAgentDriverRouting({
  candidates: [extension], context, document: { ...defaultVarinExtensionServiceRoutingDocument(), rules },
});

test('installing the only third-party driver does not select it; scoped explicit builtin and inheritance remain distinct', () => {
  assert.equal(resolve().kind, 'builtin');
  assert.deepEqual(resolve(rule([extension.providerKey])).kind, 'extension');
  const user = rule([extension.providerKey]);
  assert.equal(resolve(user, rule([VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY], { workspaceId: context.workspaceId })).kind, 'builtin');
  assert.equal(resolve(user).kind, 'extension');
  // A navigation path is not the native workspace identity.
  assert.equal(resolve(user, rule([VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY], { workspaceId: '/shown/folder' })).kind, 'extension');
});

test('unavailable, empty, conflicting and future explicit selections never fall back to a different algorithm', () => {
  const missing = rule(['missing:host:varin.agent.driver@1']);
  assert.equal(resolve(missing).kind, 'unavailable');
  assert.equal(missing.allowFallback, true, 'read-only interpretation must not rewrite persisted rules');
  assert.equal(resolve(rule([])).kind, 'unavailable');
  assert.equal(resolve(rule([extension.providerKey, 'missing'])).kind, 'unavailable');
  assert.equal(resolve(rule([extension.providerKey], { threadId: 'thread' }),
    rule([VARIN_BUILTIN_AGENT_DRIVER_PROVIDER_KEY], { runtimeId: 'elsewhere' })).kind, 'extension');
  assert.equal(resolve(rule(['future'], { userId: 'default' }, 2)).kind, 'unavailable');
  assert.equal(resolve(rule(['future'], { userId: 'default' }, 2), rule([extension.providerKey])).kind, 'extension');
});

test('public description preserves exact recovery schema/configuration and rejects unsupported promises', () => {
  const raw = { identity: { name: 'parallel', version: '1' }, configuration: { branches: 2 },
    modelRoles: [], recovery: 'none', checkpointSchema: null };
  const parsed = parseVarinAgentDriverDescription(raw);
  raw.configuration.branches = 5;
  assert.deepEqual(parsed.configuration, { branches: 2 });
  assert.throws(() => parseVarinAgentDriverDescription({ ...raw, recovery: 'checkpoint' }), /description/);
  assert.throws(() => parseVarinAgentDriverDescription({ ...raw, modelRoles: ['made-up-model'] }), /description/);
  assert.equal(parseVarinAgentDriverDescription({ ...raw, recovery: 'checkpoint', checkpointSchema: 'parallel-state-v1' }).checkpointSchema, 'parallel-state-v1');
  assert.throws(() => parseVarinAgentDriverRunOutcome({ kind: 'complete', executorStopped: true }), /outcome/);
  assert.throws(() => parseVarinAgentDriverRunOutcome({ kind: 'fail', error: {} }), /outcome/);
  const start = { runId: 'original', epoch: 1, mode: 'start', history: [], tools: [], models: [], checkpoint: null, receipts: [] };
  assert.equal(parseVarinAgentDriverRunInput(start).checkpoint, null);
  assert.throws(() => parseVarinAgentDriverRunInput({ ...start, mode: 'resume' }), /envelope/);
  assert.throws(() => parseVarinAgentDriverRunInput({ ...start, checkpoint: { revision: 1, schema: 'v1', state: null, operations: [] } }), /envelope/);
});
