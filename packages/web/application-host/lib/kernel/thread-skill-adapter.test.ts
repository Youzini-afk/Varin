import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ContextCheckpoint, ThreadSource } from '@varin/application-client';
import { createAgentResourceAuthority } from '../agent-resources/authority.js';
import { createAdmittedDirectoryReader } from '../agent-resources/source-reader.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import type { ContextPreparer } from './thread-context.js';
import type { ContextResources, InitialContext, ModelSessionConfiguration, QueuedInput, Run } from './protocol.generated.js';
import { ThreadAdapter } from './thread-adapter.js';
import { createThreadResourceScope } from './thread-resource-scope.js';
import { createThreadSkillInputPreparer } from './thread-skill-input.js';

const roots: string[] = [];
const identity = { runtime: 'agent' as const, threadId: 'thread:skills', branchId: 'branch:skills' };
const model = { providerId: 'fixture', modelId: 'fixture' };
const rawText = '/skill:review  first\n second  ';
const images = [{ mimeType: 'image/png', data: Buffer.from('original image bytes').toString('base64') }];
const attachments = [{ media_type: images[0]!.mimeType, content_ref: `data:image/png;base64,${images[0]!.data}`, source: 'user-upload' }];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Real Host selection/admission; only the existing Rust transport and launch boundary are stubbed. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-skill-adapter-')); roots.push(root);
  const skillPath = path.join(root, 'skills/review/SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  const reader = await createAdmittedDirectoryReader({ domainId: 'user', viewId: 'admitted-user', root });
  const capture = async (body: string): Promise<ContextResources> => {
    await writeFile(skillPath, `---\nname: review\ndescription: Review skill\ndisable-model-invocation: true\n---\n${body}`);
    const result = await createAgentResourceAuthority().prepare({ threadId: identity.threadId, branchId: identity.branchId,
      mode: 'agent', threadRole: 'main', projectId: null, sourceIdentity: null, projectTrusted: false,
      user: { reader, displayRoot: root } });
    if (result.status !== 'ready') throw new Error(result.reason);
    return { source: null, snapshot: result.snapshot };
  };
  const a = await capture('ORIGINAL A');
  const b = await capture('REFRESHED B');
  const initial = (resources: ContextResources): InitialContext => ({ effectiveSystemPrompt: 'Host context', instructionSources: [resources.snapshot.id],
    memoryCheckpoint: null, resources });
  const checkpoint = (resources: ContextResources, revision = 1): ContextCheckpoint => ({ id: `checkpoint:${revision}`, revision,
    resource_activations: [], resources, proposal: { key: `context:${revision}`, branch_id: identity.branchId,
      through_id: null, expected_revision: revision - 1, summary: '', effective_system_prompt: 'Host context',
      instruction_sources: [resources.snapshot.id], memory_checkpoint: null } });
  const configuration: ModelSessionConfiguration = { providerFamily: 'fixture', model: 'fixture', endpoint: 'http://fixture.invalid',
    credentialEnvironment: null, allowAnonymous: true, acceptsImages: true, configurationGeneration: 1, maxOutputTokens: null };
  const run: Run = { id: 'run:skills', thread_id: identity.threadId, branch_id: identity.branchId, state: 'waiting', revision: 1,
    epoch: 1, configuration, cancel_requested: false, waiting_on: 'wait:fixture' };
  const queued: QueuedInput = { id: 'input:queued', thread_id: identity.threadId, branch_id: identity.branchId, run_id: run.id,
    mode: 'next_run', state: 'queued', revision: 1, cursor: 1, content: { text: rawText, attachments: structuredClone(attachments) } };
  const submitReceipt = { thread_id: identity.threadId, branch_id: identity.branchId, run_id: run.id, input_id: 'input:initial', cursor: 2 };
  const enqueueReceipt = { input_id: queued.id, run_id: run.id, mode: 'next_run' as const, cursor: 3 };
  const runtime = {
    admitCalendar: vi.fn<AgentRuntimeClient['admitCalendar']>(async input => ({ id: input.occurrenceId, run_id: run.id } as import('./protocol.generated.js').CalendarOccurrence)),
    thread: vi.fn<AgentRuntimeClient['thread']>(async () => ({ thread_id: identity.threadId, observer_project_ids: [],
      branches: [{ branch_id: identity.branchId, active_run_id: run.id, head: null, latest_run: run }] })),
    run: vi.fn<AgentRuntimeClient['run']>(async () => run), input: vi.fn<AgentRuntimeClient['input']>(async () => queued),
    context: vi.fn<AgentRuntimeClient['context']>(async () => checkpoint(a)), launch: vi.fn<AgentRuntimeClient['launch']>(async () => null),
    modelSelections: vi.fn<AgentRuntimeClient['modelSelections']>(async () => ({ desired: null, active: null })),
    inputReceipt: vi.fn<AgentRuntimeClient['inputReceipt']>(async () => null), enqueueReceipt: vi.fn<AgentRuntimeClient['enqueueReceipt']>(async () => null),
    submit: vi.fn<AgentRuntimeClient['submit']>(async () => submitReceipt), enqueue: vi.fn<AgentRuntimeClient['enqueue']>(async () => enqueueReceipt),
    editInput: vi.fn<AgentRuntimeClient['editInput']>(async () => ({ ...queued, revision: queued.revision + 1 })),
  };
  const unexpectedRead = vi.fn(async () => { throw new Error('Input preparation cannot reopen resources'); });
  const scope = createThreadResourceScope({ agentDir: root, workingStates: { withBranchStore: unexpectedRead },
    documents: { inspectWorkspace: unexpectedRead, readSnapshot: unexpectedRead }, configuration: unexpectedRead,
    validateLiveSource: unexpectedRead, withSourceRead: unexpectedRead, projectTrusted: () => false });
  const prepareSkill = vi.fn(createThreadSkillInputPreparer(scope));
  const prepareContext = Object.assign(vi.fn<(...args: Parameters<ContextPreparer>) => ReturnType<ContextPreparer>>(async () => initial(a)), {
    main: vi.fn<ContextPreparer['main']>(async () => initial(a)),
    forSource: vi.fn<NonNullable<ContextPreparer['forSource']>>(async () => initial(b)),
  });
  const credentialOwner = new ExistingHostCredentialOwner({ runtime: { getAuth: async () => undefined }, providerId: 'fixture', providerFamily: 'fixture',
    currentScope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }), endpoint: configuration.endpoint,
    allowAnonymous: true });
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })), rebindModel: vi.fn(async () => credentialOwner) };
  const admitSource = vi.fn(async () => undefined);
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, admitSource, () => {}, undefined, prepareContext, undefined, prepareSkill);
  const continueLaunch = vi.spyOn(adapter, 'continueLaunch').mockResolvedValue();
  return { root, a, b, initial, checkpoint, run, queued, submitReceipt, enqueueReceipt, runtime, prepareContext, prepareSkill,
    unexpectedRead, adapter, continueLaunch, admitSource };
}

describe('ThreadAdapter explicit skill input composition', () => {
  it('keeps raw text/media separate from hidden skill material and binds initial or replaced context in the same submit', async () => {
    const f = await fixture();
    f.runtime.context.mockResolvedValue(null);
    const request = { ...identity, key: 'initial', expectedHead: null, text: rawText, images, model };
    expect(await f.adapter.submit(request)).toEqual(f.submitReceipt);
    expect(f.runtime.submit.mock.calls[0]?.[0]).toMatchObject({ input: { text: rawText, attachments }, initialContext: f.initial(f.a),
      inputPreparation: { expectedContextCheckpoint: null, skill: { snapshotId: f.a.snapshot.id, body: 'ORIGINAL A', arguments: 'first\n second' } } });
    expect(f.prepareContext.main).toHaveBeenCalledOnce();
    expect(f.prepareSkill.mock.calls[0]?.[1]).toBe(f.a);
    expect(f.a.snapshot.skills[0]?.disableModelInvocation).toBe(true);
    const original = f.checkpoint(f.a);
    f.runtime.context.mockResolvedValue(original);
    const source: ThreadSource = { mode: 'fixed_branch', workspaceId: 'workspace:new', executionWorkspaceId: 'workspace:new',
      branchId: 'source:new', revision: 2, tools: [] };
    expect(await f.adapter.submit({ ...request, key: 'new-source', source })).toEqual(f.submitReceipt);
    expect(f.prepareContext.forSource).toHaveBeenCalledWith(original, source);
    expect(f.runtime.submit.mock.calls[1]?.[0]).toMatchObject({ input: { text: rawText, attachments },
      expectedContextCheckpoint: original.id, initialContext: f.initial(f.b),
      inputPreparation: { expectedContextCheckpoint: null, skill: { snapshotId: f.b.snapshot.id, body: 'REFRESHED B' } } });
    expect(f.unexpectedRead).not.toHaveBeenCalled();
  });

  it('freezes enqueue at the published checkpoint and replays accepted submit/enqueue receipts before bad resource preparation', async () => {
    const f = await fixture();
    const command = { ...identity, key: 'queue', text: rawText, images, mode: 'next_run' as const };
    expect(await f.adapter.enqueue(command)).toEqual(f.enqueueReceipt);
    expect(f.runtime.enqueue.mock.calls[0]?.[0]).toMatchObject({ input: { text: rawText, attachments }, mode: 'next_run',
      inputPreparation: { expectedContextCheckpoint: f.checkpoint(f.a).id, skill: { body: 'ORIGINAL A' } } });
    const acceptedSubmit = { ...identity, key: 'accepted', expectedHead: null, text: rawText, images, model };
    expect(await f.adapter.submit(acceptedSubmit)).toEqual(f.submitReceipt);
    await rm(f.root, { recursive: true, force: true });
    const corrupt = structuredClone(f.checkpoint(f.b, 2));
    corrupt.resources!.snapshot.capturedFiles = [];
    f.runtime.context.mockResolvedValue(corrupt);
    f.prepareContext.main.mockRejectedValue(new Error('Malformed current settings'));
    f.prepareContext.forSource.mockRejectedValue(new Error('Malformed current settings'));
    f.runtime.inputReceipt.mockResolvedValue(f.submitReceipt);
    f.runtime.enqueueReceipt.mockResolvedValue(f.enqueueReceipt);
    f.prepareSkill.mockClear();
    expect(await f.adapter.submit(acceptedSubmit)).toEqual(f.submitReceipt);
    expect(await f.adapter.enqueue(command)).toEqual(f.enqueueReceipt);
    expect(f.prepareSkill).not.toHaveBeenCalled();
    expect(f.runtime.submit).toHaveBeenCalledOnce();
    expect(f.runtime.enqueue).toHaveBeenCalledOnce();
    expect(f.runtime.inputReceipt.mock.calls.at(-1)?.[0]).not.toHaveProperty('inputPreparation');
    expect(f.runtime.enqueueReceipt.mock.calls.at(-1)?.[0]).not.toHaveProperty('inputPreparation');
    expect(f.unexpectedRead).not.toHaveBeenCalled();
  });

  it('preserves selection for image-only edits, rebinds changed raw commands, and clears material for ordinary replacement text', async () => {
    const f = await fixture();
    f.runtime.context.mockResolvedValue(f.checkpoint(f.b, 2));
    const replacementImages = [{ mimeType: 'image/jpeg', data: Buffer.from('replacement image').toString('base64') }];
    await f.adapter.editInput(f.queued.id, 1, rawText, replacementImages);
    expect(f.prepareSkill).not.toHaveBeenCalled();
    expect(f.runtime.context).not.toHaveBeenCalled();
    expect(f.runtime.editInput.mock.calls[0]?.[0]).toEqual({ inputId: f.queued.id, expectedRevision: 1, content: { text: rawText,
      attachments: [{ media_type: 'image/jpeg', content_ref: `data:image/jpeg;base64,${replacementImages[0]!.data}`, source: 'user-upload' }] } });
    // Even whitespace-only raw command changes are a new explicit selection; parsed args equivalence is irrelevant.
    await f.adapter.editInput(f.queued.id, 1, `${rawText} `);
    expect(f.prepareSkill).toHaveBeenCalledOnce();
    expect(f.runtime.editInput.mock.calls[1]?.[0]).toMatchObject({ inputId: f.queued.id, expectedRevision: 1,
      content: { text: `${rawText} `, attachments }, inputPreparation: { expectedContextCheckpoint: f.checkpoint(f.b, 2).id,
        skill: { body: 'REFRESHED B', snapshotId: f.b.snapshot.id } } });
    await f.adapter.editInput(f.queued.id, 1, 'plain replacement', []);
    expect(f.prepareSkill).toHaveBeenCalledOnce();
    expect(f.runtime.editInput.mock.calls[2]?.[0]).toEqual({ inputId: f.queued.id, expectedRevision: 1, content: { text: 'plain replacement' } });
    expect(f.unexpectedRead).not.toHaveBeenCalled();
  });

  it('does not submit a failed selection or retry a failed revision CAS with independently changed media or material', async () => {
    const f = await fixture();
    const previous = structuredClone(f.queued);
    await expect(f.adapter.editInput(f.queued.id, 1, '/skill:missing', [])).rejects.toMatchObject({ failure: { status: 'missing' } });
    expect(f.runtime.editInput).not.toHaveBeenCalled();
    expect(f.queued).toEqual(previous);
    f.runtime.context.mockResolvedValue(f.checkpoint(f.b, 2));
    const conflict = Object.assign(new Error('Input was delivered during preparation'), { code: 'thread-conflict' });
    f.runtime.editInput.mockRejectedValueOnce(conflict);
    await expect(f.adapter.editInput(f.queued.id, 1, '/skill:review changed', [])).rejects.toBe(conflict);
    expect(f.runtime.editInput).toHaveBeenCalledOnce();
    expect(f.runtime.editInput.mock.calls[0]?.[0]).toMatchObject({ inputId: f.queued.id, expectedRevision: 1,
      content: { text: '/skill:review changed' }, inputPreparation: { skill: { body: 'REFRESHED B' } } });
    expect(f.queued).toEqual(previous);
    expect(f.continueLaunch).not.toHaveBeenCalled();
    expect(f.unexpectedRead).not.toHaveBeenCalled();
  });
});


it('cold calendar admission preserves explicit skill input and transfers a successful preparation to its original Run owner', async () => {
  const f = await fixture();
  const source: ThreadSource = { mode: 'fixed_branch', workspaceId: 'calendar-project', executionWorkspaceId: 'calendar-execution', branchId: 'calendar-source', revision: 1, tools: [] };
  vi.spyOn(f.adapter, 'prepareSource').mockResolvedValue({ source, path: f.root } as Awaited<ReturnType<ThreadAdapter['prepareSource']>>);
  const occurrence = { id: 'calendar:occurrence', revision: 3, thread_id: identity.threadId, branch_id: identity.branchId };
  const work = { occurrence, definition: { target: { kind: 'new_work', model, sourceMode: 'fixed_branch', goal: null } }, instruction: rawText, owner_epoch: 2 } as import('./protocol.generated.js').CalendarPreparation;
  const preparation = new AbortController();
  await f.adapter.prepareCalendarWork(work, f.root, preparation.signal);
  preparation.abort(); // The occurrence leaves the pending preparation scan after admission.
  expect(f.runtime.admitCalendar.mock.calls[0]?.[0]).toMatchObject({ occurrenceId: occurrence.id, expectedRevision: 3, ownerEpoch: 2,
    initialContext: f.initial(f.a), inputPreparation: { expectedContextCheckpoint: null, skill: { snapshotId: f.a.snapshot.id, body: 'ORIGINAL A', arguments: 'first\n second' } } });
  expect(f.prepareSkill.mock.calls[0]?.[2]).toBe(rawText);
  expect(f.runtime.submit).not.toHaveBeenCalled();
  expect(f.continueLaunch).toHaveBeenCalledWith(f.run.id, expect.not.objectContaining({ signal: expect.anything() }));
});
