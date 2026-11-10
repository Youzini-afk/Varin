import { bindUtf8CoordinationCodec } from '../documents/codec.test-helper.js';
import { beforeAll, afterAll } from 'vitest';
let releaseCodec: () => void;
beforeAll(() => { releaseCodec = bindUtf8CoordinationCodec(); });
afterAll(() => releaseCodec());
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
const attachments = [{ media_type: images[0]!.mimeType, data_base64: images[0]!.data }];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Real Host selection/admission; only the existing Rust transport and launch boundary are stubbed. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-skill-adapter-')); roots.push(root);
  const skillPath = path.join(root, 'skills/review/SKILL.md');
  await mkdir(path.dirname(skillPath), { recursive: true });
  await mkdir(path.join(root, 'skills/zplan'), { recursive: true });
  await writeFile(path.join(root, 'skills/zplan/SKILL.md'), '---\nname: zplan\ndescription: Plan skill\n---\nPLAN BODY');
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
    familyList: vi.fn<AgentRuntimeClient['familyList']>(async () => ({ rootThreadId: identity.threadId, members: [{ threadId: 'thread:target', parentThreadId: identity.threadId, task: 'Target', state: 'completed', branches: [{ branchId: 'branch:target', headId: null, activeRunId: null, latestRun: null }] }] })),
    childForThread: vi.fn<AgentRuntimeClient['childForThread']>(async () => ({ operation_id: 'dispatch', child_branch_id: identity.branchId } as NonNullable<Awaited<ReturnType<AgentRuntimeClient['childForThread']>>>)),
    childExecutions: vi.fn<AgentRuntimeClient['childExecutions']>(async () => []),
    acceptChildContinuation: vi.fn<AgentRuntimeClient['acceptChildContinuation']>(async () => ({ input_prepared: true } as Awaited<ReturnType<AgentRuntimeClient['acceptChildContinuation']>>)),
    admitCalendar: vi.fn<AgentRuntimeClient['admitCalendar']>(async input => ({ id: input.occurrenceId, run_id: run.id } as import('./protocol.generated.js').CalendarOccurrence)),
    thread: vi.fn<AgentRuntimeClient['thread']>(async () => ({ bot_id: null, thread_id: identity.threadId, parent_thread_id: null, observer_project_ids: [],
      main_branch_id: identity.branchId, title: 'Skills', revision: 1, created_at_ms: 0, updated_at_ms: 0,
      pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
      branches: [{ branch_id: identity.branchId, active_run_id: run.id, head: null, latest_run: run }] })),
    run: vi.fn<AgentRuntimeClient['run']>(async () => run), input: vi.fn<AgentRuntimeClient['input']>(async () => queued),
    context: vi.fn<AgentRuntimeClient['context']>(async () => checkpoint(a)), launch: vi.fn<AgentRuntimeClient['launch']>(async () => null),
    modelSelections: vi.fn<AgentRuntimeClient['modelSelections']>(async () => ({ desired: null, active: null })),
    inputReceipt: vi.fn<AgentRuntimeClient['inputReceipt']>(async () => null), enqueueReceipt: vi.fn<AgentRuntimeClient['enqueueReceipt']>(async () => null),
    submit: vi.fn<AgentRuntimeClient['submit']>(async () => submitReceipt), enqueue: vi.fn<AgentRuntimeClient['enqueue']>(async () => enqueueReceipt),
    editInput: vi.fn<AgentRuntimeClient['editInput']>(async () => ({ ...queued, revision: queued.revision + 1 })),
    sendInputNow: vi.fn<AgentRuntimeClient['sendInputNow']>(async () => ({ ...queued, run_id: run.id, mode: 'interrupt', revision: queued.revision + 1 })),
  };
  const unexpectedRead = vi.fn(async () => { throw new Error('Input preparation cannot reopen resources'); });
  const scope = createThreadResourceScope({ dataDirectory: root, workingStates: { withBranchStore: unexpectedRead },
    documents: { admitWorkspaceRegistration: async () => ({ workspaceId: 'workspace', canonicalPath: root, hostId: 'test', kind: 'directory' }), inspectWorkspace: unexpectedRead, readSnapshot: unexpectedRead }, configuration: unexpectedRead,
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
  it('sends the original queued input to the current task without rebuilding its captured content', async () => {
    const f = await fixture();
    const content = structuredClone(f.queued.content);
    const moved = await f.adapter.sendInputNow(f.queued.id, f.queued.revision, f.run.id);
    expect(f.runtime.sendInputNow).toHaveBeenCalledExactlyOnceWith(f.queued.id, f.queued.revision, f.run.id, undefined);
    expect(moved.content).toEqual(content);
    expect(moved.mode).toBe('interrupt');
    expect(f.prepareContext.main).not.toHaveBeenCalled();
    expect(f.prepareSkill).not.toHaveBeenCalled();
    expect(f.runtime.enqueue).not.toHaveBeenCalled();
    expect(f.continueLaunch).toHaveBeenCalledWith(f.run.id, {});
  });

  it('keeps queued images in place when the target task model cannot receive them', async () => {
    const f = await fixture();
    f.run.configuration = { ...(f.run.configuration as ModelSessionConfiguration), acceptsImages: false };
    await expect(f.adapter.sendInputNow(f.queued.id, f.queued.revision, f.run.id)).rejects.toMatchObject({ code: 'model-images-unsupported' });
    expect(f.runtime.sendInputNow).not.toHaveBeenCalled();
    expect(f.runtime.enqueue).not.toHaveBeenCalled();
  });

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
    const source: ThreadSource = { mode: 'fixed_branch', resourceOwner: { kind: 'local' as const }, workspaceId: 'workspace:new', executionWorkspaceId: 'workspace:new',
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
      attachments: [{ media_type: 'image/jpeg', data_base64: replacementImages[0]!.data }] } });
    // Even whitespace-only raw command changes are a new explicit selection; parsed args equivalence is irrelevant.
    await f.adapter.editInput(f.queued.id, 1, `${rawText} `);
    expect(f.prepareSkill).toHaveBeenCalledOnce();
    expect(f.runtime.editInput.mock.calls[1]?.[0]).toMatchObject({ inputId: f.queued.id, expectedRevision: 1,
      content: { text: `${rawText} ` }, inputPreparation: { expectedContextCheckpoint: f.checkpoint(f.b, 2).id,
        skill: { body: 'REFRESHED B', snapshotId: f.b.snapshot.id } } });
    await f.adapter.editInput(f.queued.id, 1, 'plain replacement', []);
    expect(f.prepareSkill).toHaveBeenCalledOnce();
    expect(f.runtime.editInput.mock.calls[2]?.[0]).toEqual({ inputId: f.queued.id, expectedRevision: 1, content: { text: 'plain replacement', attachments: [] } });
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
  const source: ThreadSource = { mode: 'fixed_branch', resourceOwner: { kind: 'local' as const }, workspaceId: 'calendar-project', executionWorkspaceId: 'calendar-execution', branchId: 'calendar-source', revision: 1, tools: [] };
  vi.spyOn(f.adapter, 'prepareSource').mockResolvedValue({ source, path: f.root } as Awaited<ReturnType<ThreadAdapter['prepareSource']>>);
  const occurrence = { id: 'calendar:occurrence', revision: 3, thread_id: identity.threadId, branch_id: identity.branchId };
  const work = { occurrence, definition: { project_id: 'selected-project', target: { kind: 'new_work', source: { kind: 'workspace', resourceOwner: { kind: 'local' }, workspaceId: 'calendar-project' }, model, sourceMode: 'fixed_branch', goal: null } }, instruction: rawText, owner_epoch: 2 } as import('./protocol.generated.js').CalendarPreparation;
  const preparation = new AbortController();
  await f.adapter.prepareCalendarWork(work, 'calendar-project', preparation.signal);
  preparation.abort(); // The occurrence leaves the pending preparation scan after admission.
  expect(f.runtime.admitCalendar.mock.calls[0]?.[0]).toMatchObject({ occurrenceId: occurrence.id, expectedRevision: 3, ownerEpoch: 2,
    initialContext: f.initial(f.a), inputPreparation: { expectedContextCheckpoint: null, skill: { snapshotId: f.a.snapshot.id, body: 'ORIGINAL A', arguments: 'first\n second' } } });
  expect(f.prepareSkill.mock.calls[0]?.[2]).toBe(rawText);
  expect(f.runtime.submit).not.toHaveBeenCalled();
  expect(f.continueLaunch).toHaveBeenCalledWith(f.run.id, expect.not.objectContaining({ signal: expect.anything() }));
});


it('carries precise multiple selections through submit/enqueue and reuses accepted receipt before resource refresh', async () => {
  const f = await fixture();
  const text = '正文 /skill:zplan 然后 /skill:review';
  const skills = ['zplan', 'review'].map(name => {
    const skill = f.a.snapshot.skills.find(skill => skill.name === name)!;
    const start = text.indexOf(`/skill:${name}`);
    return { resourceId: skill.id, version: skill.reference.version, start, end: start + `/skill:${name}`.length };
  });
  const request = { ...identity, key: 'multi', expectedHead: null, text, skills, images, model };
  await f.adapter.submit(request);
  await f.adapter.enqueue({ ...identity, key: 'queue-multi', text, skills, mode: 'boundary' });
  for (const command of [f.runtime.submit.mock.calls[0]?.[0], f.runtime.enqueue.mock.calls[0]?.[0]]) {
    expect(command).toMatchObject({ input: { text, skills }, inputPreparation: {
      expectedContextCheckpoint: 'checkpoint:1', skills: [{ name: 'zplan', body: 'PLAN BODY' }, { name: 'review', body: 'ORIGINAL A' }],
    } });
  }
  const corrupt = structuredClone(f.checkpoint(f.b, 2)); corrupt.resources!.snapshot.capturedFiles = [];
  f.runtime.context.mockResolvedValue(corrupt); f.runtime.inputReceipt.mockResolvedValue(f.submitReceipt);
  f.prepareSkill.mockClear();
  await f.adapter.submit(request);
  expect(f.prepareSkill).not.toHaveBeenCalled();
  expect(f.runtime.inputReceipt.mock.calls.at(-1)?.[0]).toMatchObject({ input: { text, skills } });
  expect(f.runtime.submit).toHaveBeenCalledOnce();
});

it('resolves menu candidates against current checkpoint and an explicitly admitted replacement source', async () => {
  const f = await fixture();
  const current = await f.adapter.skills(identity);
  expect(current.snapshotId).toBe(f.a.snapshot.id);
  expect(current.skills.find(skill => skill.name === 'review')).toMatchObject({
    resourceId: f.a.snapshot.skills[0]!.id, version: f.a.snapshot.skills[0]!.reference.version,
  });
  expect(current.skills.every(skill => !('body' in skill) && !('content' in skill))).toBe(true);
  expect(f.prepareContext.main).not.toHaveBeenCalled();
  const source: ThreadSource = { mode: 'fixed_branch', resourceOwner: { kind: 'local' }, workspaceId: 'new', executionWorkspaceId: 'new', branchId: 'source', revision: 2, tools: [] };
  const replacement = await f.adapter.skills(identity, { source });
  expect(replacement.snapshotId).toBe(f.b.snapshot.id);
  expect(f.admitSource).toHaveBeenCalledWith(source, identity, undefined, undefined);
  expect(f.prepareContext.forSource).toHaveBeenCalledWith(f.checkpoint(f.a), source, undefined);
});


it('freezes child continuation selection at acceptance and bypasses later corrupt resources for the same receipt', async () => {
  const f = await fixture();
  const text = '继续 /skill:review';
  const descriptor = f.a.snapshot.skills.find(skill => skill.name === 'review')!;
  const skills = [{ resourceId: descriptor.id, version: descriptor.reference.version, start: 3, end: text.length }];
  const command = { ...identity, key: 'continue-skill', previousRunId: 'previous-run', expectedHead: 'previous-head', text, skills };
  await f.adapter.continueChild(command);
  expect(f.runtime.acceptChildContinuation.mock.calls[0]?.[0]).toMatchObject({ input: { text, skills }, inputPreparation: {
    expectedContextCheckpoint: 'checkpoint:1', skills: [{ resourceId: descriptor.id, body: 'ORIGINAL A' }],
  } });
  f.runtime.childExecutions.mockResolvedValue([{ trigger: { kind: 'user_continuation', key: command.key } } as Awaited<ReturnType<AgentRuntimeClient['childExecutions']>>[number]]);
  f.runtime.context.mockRejectedValue(new Error('Current resources unavailable'));
  f.prepareSkill.mockClear();
  await f.adapter.continueChild(command);
  expect(f.runtime.acceptChildContinuation.mock.calls[1]?.[0]).toEqual({ key: command.key, childOperationId: 'dispatch',
    previousRunId: command.previousRunId, expectedHead: command.expectedHead, input: { text, skills } });
  expect(f.prepareSkill).not.toHaveBeenCalled();
});


it('retains the original user text and selected object identity alongside model context, including image-only queue edits', async () => {
  const f = await fixture();
  const text = '/skill:review use @target';
  const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: text.indexOf('@'), end: text.length }];
  await f.adapter.enqueue({ ...identity, key: 'reference-skill', text, references, mode: 'boundary' });
  const command = f.runtime.enqueue.mock.calls[0]![0];
  expect(command).toMatchObject({ input: { userText: text, references, referenceIntent: { text } }, inputPreparation: { skill: { arguments: 'use @target' } } });
  expect((command.input as { text: string }).text.startsWith(text)).toBe(true);
  expect((command.input as { text: string }).text).toContain('"threadId":"thread:target","branchId":"branch:target"');
  f.queued.content = command.input;
  f.prepareSkill.mockClear();
  await f.adapter.editInput(f.queued.id, 1, text, images);
  expect(f.runtime.editInput.mock.calls[0]?.[0]).toMatchObject({ content: { userText: text, references, referenceIntent: { text },
    text: (command.input as { text: string }).text } });
  expect(f.prepareSkill).not.toHaveBeenCalled();
  await f.adapter.editInput(f.queued.id, 1, 'ordinary replacement');
  expect(f.runtime.editInput.mock.calls[1]?.[0]).toEqual({ inputId: f.queued.id, expectedRevision: 1, content: { text: 'ordinary replacement' } });
});

describe('accepted object reference retries', () => {
  it('recovers a concurrently accepted reference input when current reference preparation fails', async () => {
    const f = await fixture();
    const text = 'Read @task';
    const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: 5, end: 10 }];
    f.runtime.familyList.mockRejectedValue(new Error('Family changed after receipt lookup'));
    f.runtime.inputReceipt.mockResolvedValueOnce(null).mockResolvedValue(f.submitReceipt);
    expect(await f.adapter.submit({ ...identity, key: 'raced-submit', expectedHead: null, text, references, model })).toEqual(f.submitReceipt);
    expect(f.runtime.inputReceipt.mock.calls.at(-1)![0].input).toMatchObject({ text, referenceIntent: { text } });
    f.runtime.enqueueReceipt.mockResolvedValueOnce(null).mockResolvedValue(f.enqueueReceipt);
    expect(await f.adapter.enqueue({ ...identity, key: 'raced-queue', mode: 'next_run', text, references })).toEqual(f.enqueueReceipt);
    f.runtime.childExecutions.mockResolvedValueOnce([]).mockResolvedValue([{ trigger: { kind: 'user_continuation', key: 'raced-child' } }] as Awaited<ReturnType<AgentRuntimeClient['childExecutions']>>);
    await f.adapter.continueChild({ ...identity, key: 'raced-child', previousRunId: 'previous', expectedHead: null, text, references });
    expect(f.runtime.acceptChildContinuation.mock.calls[0]![0].input).toMatchObject({ text, referenceIntent: { text } });
    expect(f.runtime.submit).not.toHaveBeenCalled();
    expect(f.runtime.enqueue).not.toHaveBeenCalled();
  });

  it('checks exact submit and enqueue receipts before current family/source/material admission', async () => {
    const f = await fixture();
    const text = 'Read @task';
    const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: 5, end: 10 }];
    f.runtime.familyList.mockRejectedValue(new Error('Current family is unavailable'));
    f.runtime.context.mockRejectedValue(new Error('Current source is unavailable'));
    const materials = vi.fn(async () => { throw new Error('Current materials are unavailable'); });
    f.adapter.bindMaterials(materials);
    const receipt = { thread_id: identity.threadId, branch_id: identity.branchId, run_id: 'run:skills', input_id: 'accepted', cursor: 2 };
    f.runtime.inputReceipt.mockResolvedValue(receipt);
    expect(await f.adapter.submit({ ...identity, key: 'same', expectedHead: null, text, references, materials: [{ snapshotId: 'original' }], model })).toEqual(receipt);
    expect(f.runtime.inputReceipt.mock.calls[0]![0].input).toMatchObject({ text, references,
      referenceIntent: { text, materials: [{ snapshotId: 'original' }] } });
    f.runtime.enqueueReceipt.mockResolvedValue({ input_id: 'accepted', run_id: 'run:skills', mode: 'next_run', cursor: 3 });
    expect(await f.adapter.enqueue({ ...identity, key: 'queued', mode: 'next_run', text, references })).toMatchObject({ input_id: 'accepted' });
    expect(f.runtime.familyList).not.toHaveBeenCalled();
    expect(materials).not.toHaveBeenCalled();
    expect(f.prepareSkill).not.toHaveBeenCalled();
  });
  it('replays an accepted child continuation from raw object intent without rebuilding context', async () => {
    const f = await fixture();
    const text = 'Read @task';
    const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: 5, end: 10 }];
    f.runtime.childExecutions.mockResolvedValue([{ trigger: { kind: 'user_continuation', key: 'child-ref' } }] as Awaited<ReturnType<AgentRuntimeClient['childExecutions']>>);
    f.runtime.familyList.mockRejectedValue(new Error('No longer visible'));
    await f.adapter.continueChild({ ...identity, key: 'child-ref', previousRunId: 'previous', expectedHead: null, text, references });
    expect(f.runtime.acceptChildContinuation.mock.calls[0]![0].input).toMatchObject({ text, references, referenceIntent: { text } });
    expect(f.runtime.familyList).not.toHaveBeenCalled();
  });
});

it('merges file attachments with object/skill input and replays without reading attachment owners again', async () => {
  const f = await fixture();
  const text = 'Read @task with /skill:review';
  const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: 5, end: 10 }];
  const skill = f.a.snapshot.skills.find(item => item.name === 'review')!;
  const skills = [{ resourceId: skill.id, version: skill.reference.version, start: text.indexOf('/skill:'), end: text.length }];
  const file = { ref: 'attachment:fixed', filename: 'image.png', mimeType: 'image/png', byteLength: 4 };
  const prepare = vi.fn(async () => [file]);
  const read = vi.fn(async () => ({ attachment: file, stream: (async function* () { yield Buffer.from('file'); })() }));
  f.adapter.bindAttachments({ prepare, read } as unknown as import('./thread-attachments.js').ThreadAttachmentOwner);
  const input = { ...identity, key: 'attachment-and-ref', attachmentImageReferences: { 'attachment:fixed': 3 }, text, references, skills, attachments: [{ ref: 'attachment:selected' }], images, model, expectedHead: null };
  await f.adapter.submit(input);
  expect(f.runtime.submit.mock.calls[0]![0]).toMatchObject({ input: { userText: text, references, skills, fileAttachments: [file], imageReferences: [4, 3],
    referenceIntent: { text, attachmentSelections: input.attachments, originalImageCount: 1 },
    attachments: [...attachments, { media_type: 'image/png', data_base64: Buffer.from('file').toString('base64') }] }, inputPreparation: { skills: [{ resourceId: skill.id }] } });
  // The fixed file/media binding is retained for edit recovery without duplicating bytes.
  expect(f.runtime.submit.mock.calls[0]![0].input).toHaveProperty('attachmentImageReferences', { 'attachment:fixed': 3 });
  f.runtime.inputReceipt.mockResolvedValue(f.submitReceipt);
  prepare.mockRejectedValue(new Error('Original source is unavailable'));
  expect(await f.adapter.submit(input)).toEqual(f.submitReceipt);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.runtime.inputReceipt.mock.calls.at(-1)![0].input).toMatchObject({ text, attachments,
    referenceIntent: { text, attachmentSelections: input.attachments, originalImageCount: 1 } });
});

it('keeps omitted image edits as native-owner retention, including adding a skill to unchanged object text', async () => {
  const f = await fixture();
  const text = 'Read @task /skill:review';
  const referenceIntent = { text, attachmentSelections: [{ ref: 'attachment:original' }], originalImageCount: 1 };
  const references = [{ kind: 'thread' as const, threadId: 'thread:target', branchId: 'branch:target', start: 5, end: 10 }];
  const fileAttachments = [{ ref: 'attachment:original', filename: 'notes.pdf', mimeType: 'application/pdf', byteLength: 4 }];
  f.queued.content = { text, references, referenceIntent, fileAttachments,
    attachments: [{ media_type: 'image/png', content_ref: { content_object: 'original-media-owner' }, source: { kind: 'conversation' } }] };
  await f.adapter.editInput(f.queued.id, 1, text);
  const omitted = f.runtime.editInput.mock.calls[0]![0];
  expect(omitted.content).toEqual({ text, references, referenceIntent });
  expect(omitted.content).not.toHaveProperty('attachments');
  const descriptor = f.a.snapshot.skills.find(skill => skill.name === 'review')!;
  const skills = [{ resourceId: descriptor.id, version: descriptor.reference.version, start: text.indexOf('/skill:'), end: text.length }];
  await f.adapter.editInput(f.queued.id, 1, text, undefined, undefined, skills);
  expect(f.runtime.editInput.mock.calls[1]![0]).toMatchObject({ content: { text, references, referenceIntent, skills },
    inputPreparation: { skills: [{ resourceId: descriptor.id }] } });
  expect(f.runtime.editInput.mock.calls[1]![0].content).not.toHaveProperty('attachments');
});

it('admits frozen quotes with original skill ranges and reuses accepted file intent without recapturing', async () => {
  const f = await fixture();
  const text = '[引用点1] then /skill:review';
  const skill = f.a.snapshot.skills.find(item => item.name === 'review')!;
  const quote = { ref: 'private-source', title: '引用点1', number: 1, label: 'Varin', text: 'selected\nfull content', attachment: { ref: 'attachment:selected' },
    source: { kind: 'chat' as const, thread: identity, passages: [{ entryId: 'original-entry', start: 0, text: 'selected\nfull content' }] } };
  const contentReferenceOccurrences = [{ kind: 'content' as const, ref: quote.ref, start: 0, end: 6 }];
  const file = { ref: 'attachment:fixed', filename: 'data.csv', mimeType: 'text/csv', byteLength: 4 };
  const prepare = vi.fn(async () => [file]);
  f.adapter.bindAttachments({ prepare } as unknown as import('./thread-attachments.js').ThreadAttachmentOwner);
  const input = { ...identity, key: 'quoted-skill', expectedHead: null, model, text, contentReferences: [quote], contentReferenceOccurrences,
    skills: [{ resourceId: skill.id, version: skill.reference.version, start: text.indexOf('/skill:'), end: text.length }] };
  await f.adapter.submit(input);
  const admitted = f.runtime.submit.mock.calls[0]![0];
  expect(admitted.input).toMatchObject({ text, contentReferences: [{ ...quote, attachmentRef: file.ref }], contentReferenceOccurrences,
    fileAttachments: [file], referenceIntent: { text, attachmentSelections: [{ ref: 'attachment:selected' }], originalImageCount: 0 } });
  expect(admitted.inputPreparation).toMatchObject({ skills: [{ resourceId: skill.id }] });
  expect((admitted.input as { text: string }).text).not.toContain('selected\nfull content');
  expect(input.contentReferences[0]).not.toHaveProperty('attachmentRef');
  f.runtime.inputReceipt.mockResolvedValue(f.submitReceipt);
  prepare.mockRejectedValue(new Error('Source must not be read on accepted retry'));
  expect(await f.adapter.submit(input)).toEqual(f.submitReceipt);
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('preserves original quotes through queue promotion and text-only queue edits', async () => {
  const f = await fixture();
  const contentReferences = [{ ref: 'quote', title: '引用点1', number: 1, text: 'frozen', source: { kind: 'chat' as const, thread: identity, passages: [] } }];
  const contentReferenceOccurrences = [{ kind: 'content' as const, ref: 'quote', start: 0, end: 6 }];
  await f.adapter.enqueue({ ...identity, key: 'quoted-queue', text: '[引用点1]', mode: 'next_run', contentReferences, contentReferenceOccurrences });
  expect(f.runtime.enqueue.mock.calls[0]![0].input).toMatchObject({ text: '[引用点1]', contentReferences, contentReferenceOccurrences });
  f.queued.content = structuredClone(f.runtime.enqueue.mock.calls[0]![0].input);
  await f.adapter.sendInputNow(f.queued.id, 1, f.run.id);
  expect(f.runtime.sendInputNow).toHaveBeenCalledExactlyOnceWith(f.queued.id, 1, f.run.id, undefined);
  await f.adapter.editInput(f.queued.id, 1, 'rewritten without markers');
  expect(f.runtime.editInput.mock.calls[0]![0].content).toMatchObject({ text: 'rewritten without markers', contentReferences, contentReferenceOccurrences: [] });
});

it('preserves edited image quote bytes while retaining the original file without another image', async () => {
  const f = await fixture();
  const file = { ref: 'attachment:original', filename: 'image.png', mimeType: 'image/png', byteLength: 8 };
  const prepare = vi.fn(async () => [file]), read = vi.fn();
  f.adapter.bindAttachments({ prepare, read } as unknown as import('./thread-attachments.js').ThreadAttachmentOwner);
  await f.adapter.submit({ ...identity, key: 'quoted-image', expectedHead: null, model, text: 'Look [Image 7]',
    images: [{ mimeType: 'image/png', data: 'ZWRpdGVk', reference: 7 }],
    contentReferences: [{ ref: 'q', title: 'image', imageReference: 7, attachment: { ref: file.ref }, source: { kind: 'chat', thread: identity, passages: [] } }],
    contentReferenceOccurrences: [{ kind: 'image', reference: 7, start: 5, end: 14 }] });
  expect(f.runtime.submit.mock.calls[0]![0].input).toMatchObject({ attachments: [{ media_type: 'image/png', data_base64: 'ZWRpdGVk' }],
    imageReferences: [7], fileAttachments: [file], attachmentImageReferences: { [file.ref]: 7 } });
  expect(read).not.toHaveBeenCalled();
});
