import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContextCheckpoint, ThreadSource } from '@varin/application-client';
import type { AgentPersonalizationCatalog } from '@varin/protocol';
import { ThreadAdapter } from './thread-adapter.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { createThreadContext, type ContextPreparer } from './thread-context.js';
import { ResourceScopeError } from './thread-resource-scope.js';
import { resourceScopeFixture } from './resource-scope.test-helper.js';
import { createResourceOwner, resourceQueryFailure, type ResourceQuery, type ResourceToolResult } from './resource-owner.js';
import { ResourceBridge, type PrivateResourceResponse } from './resource-bridge.js';
import type { InitialContext, ResourceSnapshotParams, Run, InputSubmitParams, ModelSessionConfiguration } from './protocol.generated.js';
import { deferred } from './language.test-helper.js';

const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const identity = { runtime: 'agent' as const, threadId: 'thread:resources', branchId: 'branch:resources' };
const request = (id: string): ResourceQuery => ({ runId: 'run', origin: { kind: 'model_step', request_id: 'model-step' }, callId: 'call',
  resourceCheckpointId: 'checkpoint', request: { kind: 'skill', resourceId: id } });
const checkpoint = (context: InitialContext): ContextCheckpoint => ({ id: 'checkpoint', revision: 1,
  ...(context.personalization ? { personalization: context.personalization } : {}), ...(context.resources ? { resources: context.resources } : {}),
  proposal: { key: 'context', branch_id: identity.branchId, through_id: 'history', expected_revision: 0, summary: 'SAVED SUMMARY',
    effective_system_prompt: context.effectiveSystemPrompt, instruction_sources: context.instructionSources, memory_checkpoint: context.memoryCheckpoint } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-resource-consumers-')); cleanup.push(root);
  const agentDir = path.join(root, 'resource-agent');
  await fs.mkdir(path.join(agentDir, 'skills', 'example'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'SYSTEM.md'), 'SELECTED USER SYSTEM');
  await fs.writeFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'SELECTED APPEND');
  await fs.writeFile(path.join(agentDir, 'AGENTS.md'), 'USER CONTEXT');
  await fs.writeFile(path.join(agentDir, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: Example metadata\n---\nORIGINAL SKILL BODY');
  let catalog: AgentPersonalizationCatalog = { revision: 1, prompts: {}, memories: [
    { id: 1, scope: { kind: 'global' }, content: 'FROZEN NOTE', updatedAt: '2026-10-10T00:00:00Z' }] };
  // A user-only scope must not touch any workspace owner or the test runner's HOME.
  const resources = resourceScopeFixture(root, { withBranchStore: async () => { throw new Error('No workspace admitted'); } } as never);
  const composition = vi.fn(async () => ({ providerId: 'context-provider', contentVersion: 'version', scopeId: identity.threadId,
    selectionRevision: 1, sections: [{ name: 'contribution', kind: 'instruction', content: 'TRANSFORM APPLIES IN RUST' }] }));
  const prepare = createThreadContext({ resources, composition, personalization: { catalog: async () => structuredClone(catalog) }, projectForWorkspace: async () => undefined });
  const context = await prepare.main(identity, null);
  return { root, agentDir, resources, prepare, context, composition, setCatalog: (value: AgentPersonalizationCatalog) => { catalog = value; } };
}

/** Runtime doubles model publication CAS only; preparation and Host admission use their real owners. */
function adapterFixture(saved: ContextCheckpoint, prepare: ContextPreparer) {
  let active = structuredClone(saved);
  const runtime = {
    thread: vi.fn(async () => ({ thread_id: identity.threadId, observer_project_ids: [], branches: [
      { branch_id: identity.branchId, active_run_id: null, head: 'history', latest_run: null }] })),
    context: vi.fn<AgentRuntimeClient['context']>(async () => structuredClone(active)),
    inputReceipt: vi.fn<AgentRuntimeClient['inputReceipt']>(async () => null),
    refreshContext: vi.fn<AgentRuntimeClient['refreshContext']>(async () => { throw new Error('Unexpected profile publication'); }),
    refreshResources: vi.fn<AgentRuntimeClient['refreshResources']>(async input => {
      if (input.expectedRevision !== active.revision) throw Object.assign(new Error('Concurrent resource publication'), { code: 'thread-conflict' });
      active = { ...checkpoint(input.context), id: `checkpoint:${active.revision + 1}`, revision: active.revision + 1,
        proposal: { ...active.proposal, effective_system_prompt: input.context.effectiveSystemPrompt,
          instruction_sources: input.context.instructionSources, memory_checkpoint: input.context.memoryCheckpoint } };
      return structuredClone(active);
    }),
    submit: vi.fn(async (_input: InputSubmitParams) => ({ thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'submitted-run', input_id: 'input', cursor: 1 })),
    withRunPreparation: async <T>(_runId: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) => work(signal ?? new AbortController().signal),
    launch: vi.fn(async () => null),
  };
  const configuration: ModelSessionConfiguration = { providerFamily: 'fixture', model: 'fixture', endpoint: 'https://fixture.invalid', credentialEnvironment: null,
    allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const credentialOwner = { scope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }) } as ExistingHostCredentialOwner;
  const admit = vi.fn(async () => {}); const errors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient,
    { resolveModel: async () => ({ configuration, credentialOwner }), rebindModel: async () => credentialOwner },
    admit, (_runId, error) => { errors.push(error); }, undefined, prepare);
  return { adapter, runtime, admit, errors, active: () => structuredClone(active) };
}

it('renders selected resources once, keeps runtime safety outside SYSTEM, and exposes metadata without skill bodies', async () => {
  const f = await fixture();
  expect(f.context.effectiveSystemPrompt).toContain('SELECTED USER SYSTEM');
  expect(f.context.effectiveSystemPrompt).toContain('Use only the tools actually provided');
  expect(f.context.effectiveSystemPrompt).toContain('Your admitted role is main');
  expect(f.context.effectiveSystemPrompt).toContain('SELECTED APPEND');
  expect(f.context.effectiveSystemPrompt).toContain('USER CONTEXT');
  expect(f.context.effectiveSystemPrompt).toContain('resource_read');
  expect(f.context.effectiveSystemPrompt).toContain('Example metadata');
  expect(f.context.effectiveSystemPrompt).not.toContain('ORIGINAL SKILL BODY');
  expect(f.context.effectiveSystemPrompt).not.toContain('TRANSFORM APPLIES IN RUST');
  expect(f.context.resources?.snapshot.capturedFiles.some(file => file.content.includes('ORIGINAL SKILL BODY'))).toBe(true);
  expect(f.context.instructionSources.some(source => source.includes('AGENTS.md'))).toBe(true);
  expect(f.composition).toHaveBeenCalledTimes(1);
});

it('profile refresh and compaction retain original resource bytes while only compaction updates the note snapshot', async () => {
  const f = await fixture(); const saved = checkpoint(f.context);
  await fs.writeFile(path.join(f.agentDir, 'SYSTEM.md'), 'LATER LIVE SYSTEM');
  f.setCatalog({ revision: 2, prompts: { global: { sections: { preamble: 'PROFILE OVERRIDE', runtime_identity: null } } },
    memories: [{ id: 2, scope: { kind: 'global' }, content: 'LATER NOTE', updatedAt: '2026-10-10T01:00:00Z' }] });
  const refreshed = await f.prepare.refresh!(saved);
  expect(refreshed.resources).toBe(saved.resources);
  expect(refreshed.personalization?.originalSections).toEqual(saved.personalization?.originalSections);
  expect(refreshed.effectiveSystemPrompt).toContain('Use only the tools actually provided');
  expect(refreshed.effectiveSystemPrompt).toContain('PROFILE OVERRIDE');
  expect(refreshed.effectiveSystemPrompt).toContain('FROZEN NOTE');
  expect(refreshed.effectiveSystemPrompt).not.toContain('LATER LIVE SYSTEM');
  expect(refreshed.effectiveSystemPrompt).not.toContain('LATER NOTE');
  const compacted = await f.prepare.compact!(saved);
  expect(compacted.resources).toBe(saved.resources);
  expect(compacted.effectiveSystemPrompt).toContain('LATER NOTE');
  expect(compacted.effectiveSystemPrompt).not.toContain('FROZEN NOTE');
});

it('resource refresh creates a separate candidate, preserves saved notes and memory checkpoint, and leaves failed candidates unpublished', async () => {
  const f = await fixture(); const saved = checkpoint(f.context); const original = JSON.stringify(saved);
  await fs.writeFile(path.join(f.agentDir, 'SYSTEM.md'), 'NEW SELECTED SYSTEM');
  await fs.writeFile(path.join(f.agentDir, 'skills', 'example', 'support.md'), 'EXPLICIT SUPPORT');
  f.setCatalog({ revision: 2, prompts: {}, memories: [] });
  const next = await f.prepare.refreshResources!(saved, { supportingFiles: [{ skillName: 'example', relativePath: 'support.md' }] });
  expect(next.resources?.snapshot.id).not.toBe(saved.resources?.snapshot.id);
  expect(next.resources?.source).toBe(saved.resources?.source);
  expect(next.personalization?.memorySnapshot).toEqual(saved.personalization?.memorySnapshot);
  expect(next.memoryCheckpoint).toBe(saved.proposal.memory_checkpoint);
  expect(next.effectiveSystemPrompt).toContain('NEW SELECTED SYSTEM');
  expect(next.effectiveSystemPrompt).toContain('FROZEN NOTE');
  expect(next.resources?.snapshot.capturedFiles.some(file => file.content === 'EXPLICIT SUPPORT')).toBe(true);
  expect(JSON.stringify(saved)).toBe(original);
  await fs.writeFile(path.join(f.agentDir, 'settings.json'), '{malformed');
  await expect(f.prepare.refreshResources!(saved)).rejects.toMatchObject({ failure: { status: 'invalid' } });
  expect(JSON.stringify(saved)).toBe(original);
  const controller = new AbortController(); controller.abort();
  await expect(f.prepare.refreshResources!(saved, { signal: controller.signal })).rejects.toThrow();
  expect(JSON.stringify(saved)).toBe(original);
});

it('ThreadAdapter resource refresh rejects stale revisions before preparation and never publishes failed or cancelled candidates', async () => {
  const f = await fixture(); const saved = checkpoint(f.context); const original = JSON.stringify(saved);
  const fAdapter = adapterFixture(saved, f.prepare);
  const actualPrepare = f.prepare.refreshResources!; const prepare = vi.spyOn(f.prepare, 'refreshResources');
  await expect(fAdapter.adapter.refreshResources({ ...identity, expectedRevision: 0 })).rejects.toMatchObject({ code: 'thread-conflict' });
  expect(prepare).not.toHaveBeenCalled();
  expect(fAdapter.runtime.refreshResources).not.toHaveBeenCalled();
  await fs.writeFile(path.join(f.agentDir, 'settings.json'), '{malformed');
  await expect(fAdapter.adapter.refreshResources({ ...identity, expectedRevision: 1 })).rejects.toMatchObject({ failure: { status: 'invalid' } });
  expect(fAdapter.runtime.refreshResources).not.toHaveBeenCalled();
  expect(JSON.stringify(fAdapter.active())).toBe(original);
  await fs.rm(path.join(f.agentDir, 'settings.json'));
  const entered = deferred<void>(); const release = deferred<void>();
  // The candidate is already ready when cancellation arrives. Even a consumer that finishes late
  // cannot make the adapter cross the publication boundary after caller cancellation.
  prepare.mockImplementationOnce(async (...args) => {
    const result = await actualPrepare(...args); entered.resolve(); await release.promise; return result;
  });
  const controller = new AbortController();
  const cancelled = fAdapter.adapter.refreshResources({ ...identity, expectedRevision: 1 }, controller.signal);
  await entered.promise; controller.abort(); release.resolve();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect(fAdapter.runtime.refreshResources).not.toHaveBeenCalled();
  expect(JSON.stringify(fAdapter.active())).toBe(original);
});

it('ThreadAdapter publishes one winning resource candidate and propagates the losing runtime CAS conflict without replacing it', async () => {
  const f = await fixture(); const saved = checkpoint(f.context); const fAdapter = adapterFixture(saved, f.prepare);
  const prepare = f.prepare.refreshResources!;
  const entered = deferred<void>(); const release = deferred<void>();
  const preparation = vi.spyOn(f.prepare, 'refreshResources');
  preparation.mockImplementationOnce(async (...args) => { const candidate = await prepare(...args); entered.resolve(); await release.promise; return candidate; });
  await fs.writeFile(path.join(f.agentDir, 'SYSTEM.md'), 'OLDER IN-FLIGHT CANDIDATE');
  const losing = fAdapter.adapter.refreshResources({ ...identity, expectedRevision: 1 });
  await entered.promise;
  await fs.writeFile(path.join(f.agentDir, 'SYSTEM.md'), 'WINNING CANDIDATE');
  const winner = await fAdapter.adapter.refreshResources({ ...identity, expectedRevision: 1 });
  expect(winner.revision).toBe(2);
  expect(winner.proposal.effective_system_prompt).toContain('WINNING CANDIDATE');
  release.resolve();
  await expect(losing).rejects.toMatchObject({ code: 'thread-conflict' });
  expect(fAdapter.active()).toEqual(winner);
  expect(fAdapter.active().proposal.memory_checkpoint).toBe(saved.proposal.memory_checkpoint);
  expect(fAdapter.active().personalization?.memorySnapshot).toEqual(saved.personalization?.memorySnapshot);
  expect(fAdapter.runtime.refreshResources).toHaveBeenCalledTimes(2);
  expect(fAdapter.runtime.refreshResources.mock.calls.map(([input]) => input.expectedRevision)).toEqual([1, 1]);
  expect(fAdapter.runtime.refreshResources.mock.calls[1]![0].context.effectiveSystemPrompt).toContain('OLDER IN-FLIGHT CANDIDATE');
  expect(preparation).toHaveBeenCalledTimes(2);
});

it('ThreadAdapter submits an explicit source with real forSource preparation and the original role, project and memory', async () => {
  const f = await fixture();
  const source: ThreadSource = { workspaceId: 'new-workspace', executionWorkspaceId: 'new-execution', mode: 'fixed_branch', branchId: 'new-source', revision: 2, tools: ['file_read'] };
  const scopes: Array<{ source: ThreadSource | null; mode: string; threadRole: string; projectId: string | null }> = [];
  const resources: typeof f.resources = { ...f.resources, withScope: async (identity, selected, admitted, consume, options) => {
    scopes.push({ source: selected, ...admitted });
    return f.resources.withScope(identity, null, admitted, async binding => consume({ ...binding,
      admittedScope: { ...binding.admittedScope, sourceIdentity: selected ? `source:${selected.workspaceId}` : null } }), options);
  } };
  const projectLookup = vi.fn(async () => 'MUST NOT REASSIGN PROJECT');
  let catalog: AgentPersonalizationCatalog = { revision: 5, prompts: {}, memories: [
    { id: 99, scope: { kind: 'global' }, content: 'ORIGINAL SOURCE MEMORY', updatedAt: '2026-10-10T00:00:00Z' }] };
  const prepare = createThreadContext({ resources, personalization: { catalog: async () => structuredClone(catalog) }, projectForWorkspace: projectLookup });
  const original = await prepare(identity, null, { mode: 'agent', threadRole: 'worker', projectId: 'admitted-project' });
  const saved = checkpoint(original); const fAdapter = adapterFixture(saved, prepare);
  catalog = { revision: 6, prompts: {}, memories: [
    { id: 100, scope: { kind: 'global' }, content: 'LATER UNACCEPTED MEMORY', updatedAt: '2026-10-10T01:00:00Z' }] };
  const sourcePreparation = vi.spyOn(prepare, 'forSource'); const mainPreparation = vi.spyOn(prepare, 'main');
  await fAdapter.adapter.submit({ ...identity, key: 'explicit-source', expectedHead: 'history', text: 'Use the new source',
    model: { providerId: 'fixture', modelId: 'fixture' }, source });
  await vi.waitFor(() => expect(fAdapter.runtime.launch).toHaveBeenCalled());
  expect(sourcePreparation).toHaveBeenCalledExactlyOnceWith(saved, source);
  expect(mainPreparation).not.toHaveBeenCalled();
  expect(fAdapter.admit).toHaveBeenCalledExactlyOnceWith(source, expect.objectContaining(identity));
  const submitted = fAdapter.runtime.submit.mock.calls[0]![0];
  const changed = submitted.initialContext!;
  expect(submitted.expectedContextCheckpoint).toBe(saved.id);
  expect(submitted.launch).toMatchObject({ inheritSource: false, source: { workspaceId: 'new-workspace', branchId: 'new-source', revision: 2 } });
  expect(changed.resources?.source).toMatchObject({ workspace_id: 'new-workspace', branch_id: 'new-source', revision: 2 });
  expect(changed.resources?.snapshot.scope).toMatchObject({ mode: 'agent', threadRole: 'worker', projectId: 'admitted-project' });
  expect(changed.personalization?.memorySnapshot).toEqual(saved.personalization?.memorySnapshot);
  expect(changed.effectiveSystemPrompt).toContain('ORIGINAL SOURCE MEMORY');
  expect(changed.effectiveSystemPrompt).not.toContain('LATER UNACCEPTED MEMORY');
  expect(changed.memoryCheckpoint).toBe(saved.proposal.memory_checkpoint);
  expect(scopes.at(-1)).toEqual({ source, mode: 'agent', threadRole: 'worker', projectId: 'admitted-project' });
  expect(projectLookup).not.toHaveBeenCalled();
  expect(saved.resources?.source).toBeNull();
  expect(fAdapter.errors).toEqual([]);
  expect(fAdapter.runtime.refreshContext).not.toHaveBeenCalled();
});

it('ThreadAdapter reuses an accepted input receipt after settings break, and only a matching raced receipt can recover a new preparation failure', async () => {
  const f = await fixture(); const saved = checkpoint(f.context); const fAdapter = adapterFixture(saved, f.prepare);
  const source: ThreadSource = { workspaceId: 'selected-workspace', executionWorkspaceId: 'selected-workspace',
    mode: 'fixed_branch', branchId: 'selected-source', revision: 0, tools: ['file_read'] };
  // Source pin admission is a separate tested owner. Keep this fixture's real user resource
  // preparation while admitting the selected immutable source identity to the Host consumer.
  const withScope = f.resources.withScope.bind(f.resources);
  vi.spyOn(f.resources, 'withScope').mockImplementation((identity, selected, admitted, consume, options) =>
    withScope(identity, null, admitted, binding => consume({ ...binding,
      admittedScope: { ...binding.admittedScope, sourceIdentity: selected ? `source:${selected.workspaceId}` : null } }), options));
  const preparation = vi.spyOn(f.prepare, 'forSource');
  const input = { ...identity, key: 'accepted-key', expectedHead: 'history', text: 'Use the selected source',
    model: { providerId: 'fixture', modelId: 'fixture' }, source };
  const receipt = await fAdapter.adapter.submit(input);
  expect(fAdapter.runtime.submit).toHaveBeenCalledOnce();
  expect(fAdapter.runtime.submit.mock.calls[0]![0].expectedContextCheckpoint).toBe(saved.id);
  await fs.writeFile(path.join(f.agentDir, 'settings.json'), '{malformed');
  fAdapter.runtime.inputReceipt.mockResolvedValue(receipt);
  expect(await fAdapter.adapter.submit(input)).toEqual(receipt);
  expect(preparation).toHaveBeenCalledOnce();
  expect(fAdapter.runtime.submit).toHaveBeenCalledOnce();
  expect(fAdapter.runtime.inputReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ key: input.key,
    threadId: identity.threadId, branchId: identity.branchId, input: expect.anything(),
    launch: expect.objectContaining({ inheritSource: false, source: expect.objectContaining({ branchId: source.branchId }) }) }));

  fAdapter.runtime.inputReceipt.mockReset().mockResolvedValue(null);
  await expect(fAdapter.adapter.submit({ ...input, key: 'unaccepted-key' })).rejects.toMatchObject({ failure: { status: 'invalid', path: 'settings.json' } });
  expect(fAdapter.runtime.inputReceipt).toHaveBeenCalledTimes(2);
  expect(fAdapter.runtime.submit).toHaveBeenCalledOnce();
  expect(fAdapter.active()).toEqual(saved);

  const concurrent = { ...receipt, input_id: 'concurrently-accepted-input', run_id: 'concurrently-accepted-run' };
  fAdapter.runtime.inputReceipt.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce(concurrent);
  expect(await fAdapter.adapter.submit({ ...input, key: 'raced-key' })).toEqual(concurrent);
  expect(fAdapter.runtime.inputReceipt).toHaveBeenCalledTimes(2);
  expect(fAdapter.runtime.inputReceipt.mock.calls[0]![0]).toEqual(fAdapter.runtime.inputReceipt.mock.calls[1]![0]);
  expect(fAdapter.runtime.submit).toHaveBeenCalledOnce();
  expect(fAdapter.active()).toEqual(saved);
  await vi.waitFor(() => expect(fAdapter.runtime.launch).toHaveBeenCalledWith(concurrent.run_id, expect.any(AbortSignal)));
  expect(fAdapter.errors).toEqual([]);
});

it('the exact frozen resource read survives live deletion and cannot read a later uncaptured support file', async () => {
  const f = await fixture(); const resources = f.context.resources!; const skill = resources.snapshot.skills[0]!;
  const run: Run = { id: 'run', thread_id: identity.threadId, branch_id: identity.branchId, state: 'runnable', revision: 1,
    epoch: 1, waiting_on: null, configuration: {}, cancel_requested: false };
  const snapshots = new Map([['checkpoint', resources]]);
  const resolve = vi.fn(async (binding: ResourceSnapshotParams) => structuredClone(snapshots.get(binding.resourceCheckpointId)!));
  const owner = createResourceOwner({ resources: f.resources, runtime: { resourceSnapshot: resolve, run: async () => ({ ...run }) } });
  const signal = new AbortController().signal;
  await fs.writeFile(path.join(f.agentDir, 'skills', 'example', 'support.md'), 'LATER FILE MUST NOT LEAK');
  const unknown = await owner({ ...request(skill.id), request: { kind: 'skill-resource', resourceId: skill.id, relativePath: 'support.md' } }, signal);
  expect(unknown.status).toBe('unavailable');
  expect(JSON.stringify(unknown)).not.toContain('LATER FILE MUST NOT LEAK');
  await fs.writeFile(path.join(f.agentDir, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: Example metadata\n---\nNEW SKILL BODY');
  const next = (await f.prepare.refreshResources!(checkpoint(f.context))).resources!;
  snapshots.set('next-checkpoint', next);
  await fs.rm(f.agentDir, { recursive: true });
  const result = await owner(request(skill.id), signal);
  expect(result).toMatchObject({ status: 'ready', snapshotId: resources.snapshot.id, resourceCheckpointId: 'checkpoint',
    file: { content: expect.stringContaining('ORIGINAL SKILL BODY'), reference: skill.reference } });
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenLastCalledWith({ runId: 'run', origin: { kind: 'model_step', request_id: 'model-step' }, callId: 'call', resourceCheckpointId: 'checkpoint' }, signal);
  const newResult = await owner({ ...request(skill.id), resourceCheckpointId: 'next-checkpoint' }, signal);
  expect(newResult).toMatchObject({ status: 'ready', snapshotId: next.snapshot.id, resourceCheckpointId: 'next-checkpoint',
    file: { content: expect.stringContaining('NEW SKILL BODY') } });
  expect(next.snapshot.skills[0]!.reference.version).not.toBe(skill.reference.version);
  expect((await owner({ ...request(skill.id), request: { kind: 'instruction-scope', targetPath: '../outside' } }, signal)).status).toBe('denied');
  expect((await owner({ ...request(skill.id), request: { kind: 'skill-resource', resourceId: skill.id, relativePath: '../../outside' } }, signal)).status).toBe('denied');
  run.cancel_requested = true;
  expect((await owner(request(skill.id), signal)).status).toBe('cancelled');
});

it('read reauthorization and epoch checks can deny already captured bytes without substituting current snapshots', async () => {
  const f = await fixture(); const resources = f.context.resources!; const skill = resources.snapshot.skills[0]!;
  let epoch = 1;
  const run = async (): Promise<Run> => ({ id: 'run', thread_id: identity.threadId, branch_id: 'fork-branch', state: 'runnable', revision: 1,
    epoch, waiting_on: null, configuration: {}, cancel_requested: false });
  const runtime = { resourceSnapshot: async () => resources, run };
  const denied = createResourceOwner({ runtime, resources: { ...f.resources, withScope: async () => {
    throw new ResourceScopeError({ status: 'denied', domainId: 'user', viewId: 'original', path: '', reason: 'Current admission revoked' });
  } } });
  expect(await denied(request(skill.id), new AbortController().signal)).toMatchObject({ status: 'denied', reason: 'Current admission revoked' });
  const changing = createResourceOwner({ runtime, resources: { ...f.resources, withScope: async (...args) => {
    expect(args[0].branchId).toBe('fork-branch');
    const result = await f.resources.withScope(...args); epoch++; return result;
  } } });
  expect((await changing(request(skill.id), new AbortController().signal)).status).toBe('stale');
});

it('private resource calls cancel independently and discard late old-epoch results', async () => {
  let epoch = 'epoch'; const replies: PrivateResourceResponse[] = [];
  const bridge = new ResourceBridge(() => epoch, async value => { replies.push(value); }, () => { throw new Error('Unexpected transport failure'); });
  const held = deferred<ResourceToolResult>(); const signals: AbortSignal[] = [];
  bridge.setOwner(async (_query, signal) => { signals.push(signal); return signals.length === 1 ? held.promise : resourceQueryFailure('missing', 'Other call finished'); });
  const frame = (id: string) => ({ v: 1, kind: 'resource-request', id, kernelEpoch: epoch, query: request('skill') });
  bridge.consume(frame('slow')); bridge.consume(frame('fast'));
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies[0]?.id).toBe('fast');
  bridge.consume({ v: 1, kind: 'resource-cancel', id: 'slow', kernelEpoch: 'old' });
  expect(signals[0]?.aborted).toBe(false);
  bridge.consume({ v: 1, kind: 'resource-cancel', id: 'slow', kernelEpoch: epoch });
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  expect(replies[1]).toMatchObject({ id: 'slow', result: { status: 'cancelled' } });
  epoch = 'next'; bridge.close(); held.resolve(resourceQueryFailure('missing', 'Late old response'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(replies).toHaveLength(2);
});

it('the private bridge rejects model-selected snapshots, malformed origins and unknown request variants', async () => {
  const replies: PrivateResourceResponse[] = [];
  const bridge = new ResourceBridge(() => 'epoch', async value => { replies.push(value); }, () => {});
  const owner = vi.fn(async () => resourceQueryFailure('missing', 'Should not run')); bridge.setOwner(owner);
  for (const [index, change] of [{ snapshot: {} }, { source: {} }, { origin: { kind: 'model_step' } }, { request: { kind: 'path', path: '/secret' } }].entries()) {
    bridge.consume({ v: 1, kind: 'resource-request', id: String(index), kernelEpoch: 'epoch', query: { ...request('skill'), ...change } });
  }
  await vi.waitFor(() => expect(replies).toHaveLength(4));
  expect(replies.every(reply => reply.result.status === 'invalid')).toBe(true);
  expect(owner).not.toHaveBeenCalled();
  expect(bridge.consume({ kind: 'public-event' })).toBe(false);
  bridge.close();
});
