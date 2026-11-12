import { bindUtf8CoordinationCodec } from '../documents/codec.test-helper.js';
import { beforeAll, afterAll } from 'vitest';
let releaseCodec: () => void;
beforeAll(() => { releaseCodec = bindUtf8CoordinationCodec(); });
afterAll(() => releaseCodec());
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentResourceAuthority } from '../agent-resources/authority.js';
import { createAdmittedDirectoryReader } from '../agent-resources/source-reader.js';
import { createThreadResourceScope, type ThreadResourceScopeOwners } from './thread-resource-scope.js';
import { createThreadSkillInputPreparer, parseThreadSkills } from './thread-skill-input.js';
import type { ContextResources } from './protocol.generated.js';

const roots: string[] = [];
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'conversation' };
const file = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-thread-skill-')); roots.push(root);
  const userRoot = path.join(root, 'user');
  const projectRoot = path.join(root, 'project');
  for (const [relative, content] of Object.entries({ 'user/skills/shared/SKILL.md': file('shared', 'USER FALLBACK'),
    'user/skills/independent/SKILL.md': file('independent', 'USER BODY'), 'project/.varin/resources/skills/shared/SKILL.md': file('shared', 'PROJECT BODY') })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  const user = await createAdmittedDirectoryReader({ domainId: 'user', viewId: 'user-v1', root: userRoot });
  const project = await createAdmittedDirectoryReader({ domainId: 'project', viewId: 'project-v1', root: projectRoot });
  const prepared = await createAgentResourceAuthority().prepare({ threadId: identity.threadId, branchId: identity.branchId,
    mode: 'agent', threadRole: 'main', projectId: 'project', sourceIdentity: 'original-source', projectTrusted: true,
    user: { reader: user, displayRoot: userRoot }, project: { reader: project, displayRoot: projectRoot, cwd: '' } });
  if (prepared.status !== 'ready') throw new Error(prepared.reason);
  const resources: ContextResources = { snapshot: prepared.snapshot, source: { mode: 'fixed_branch', resource_owner: { kind: 'local' as const }, workspace_id: 'workspace',
    execution_workspace_id: 'workspace', branch_id: 'original-source', revision: 1, live_root: null } };
  const unexpected = vi.fn(async () => { throw new Error('Skill activation must not open a source or rediscover resources'); });
  const trust = vi.fn<ThreadResourceScopeOwners['projectTrusted']>(() => true);
  const scope = createThreadResourceScope({ dataDirectory: userRoot, workingStates: { withBranchStore: unexpected },
    documents: { admitWorkspaceRegistration: async () => ({ workspaceId: 'workspace', canonicalPath: root, authorizationRoot: root, hostId: 'test', kind: 'directory' }), inspectWorkspace: unexpected, readSnapshot: unexpected }, configuration: unexpected,
    validateLiveSource: unexpected, withSourceRead: unexpected, projectTrusted: trust });
  return { root, projectRoot, resources, unexpected, trust, scope, prepare: createThreadSkillInputPreparer(scope) };
}

describe('Thread explicit skill input admission', () => {
  it('leaves ordinary text independent of resource admission and refuses unprepared explicit input', async () => {
    const withScope = vi.fn();
    const prepare = createThreadSkillInputPreparer({ withScope });
    expect(await prepare(identity, undefined, 'ordinary /skill:review')).toEqual({ status: 'ready', skill: null });
    expect(await prepare(identity, undefined, '/skill:review')).toMatchObject({ status: 'unavailable' });
    expect(await prepare(identity, undefined, '/skill:')).toMatchObject({ status: 'invalid' });
    expect(await prepare(identity, undefined, '/skill:review', AbortSignal.abort())).toMatchObject({ status: 'cancelled' });
    expect(withScope).not.toHaveBeenCalled();
  });

  it('reauthorizes the original project selection without source I/O or a Run, and keeps independent user skills available', async () => {
    const f = await fixture();
    const withScope = vi.spyOn(f.scope, 'withScope');
    await rm(f.root, { recursive: true, force: true });
    expect(await f.prepare(identity, f.resources, '/skill:shared arg')).toMatchObject({ status: 'ready', skill: { body: 'PROJECT BODY', arguments: 'arg' } });
    expect(f.trust).toHaveBeenCalledTimes(2);
    expect(f.trust.mock.calls.every(([root]) => root === f.projectRoot)).toBe(true);
    const options = withScope.mock.calls[0]?.[4];
    expect(options?.snapshot).toBe(f.resources.snapshot);
    expect(options?.request).toEqual({ kind: 'skill', resourceId: f.resources.snapshot.skills.find(skill => skill.name === 'shared')!.id });
    expect(options?.runId).toBeUndefined();
    f.trust.mockReturnValue(false);
    expect(await f.prepare(identity, f.resources, '/skill:shared')).toMatchObject({ status: 'denied' });
    expect(await f.prepare(identity, f.resources, '/skill:independent')).toMatchObject({ status: 'ready', skill: { body: 'USER BODY' } });
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it('rejects late revocation and cancellation rather than publishing a prepared adjunct', async () => {
    const f = await fixture();
    f.trust.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(await f.prepare(identity, f.resources, '/skill:shared')).toMatchObject({ status: 'denied' });
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    let finish!: (trusted: boolean) => void;
    f.trust.mockImplementationOnce(() => { begin(); return new Promise<boolean>(resolve => { finish = resolve; }); });
    const controller = new AbortController();
    const pending = f.prepare(identity, f.resources, '/skill:shared', controller.signal);
    await started;
    controller.abort();
    finish(true);
    expect(await pending).toMatchObject({ status: 'cancelled' });
    expect(await f.prepare(identity, f.resources, '/skill:independent')).toMatchObject({ status: 'ready' });
    expect(f.unexpected).not.toHaveBeenCalled();
  });

  it('reports invalid frozen source provenance without opening a substitute view', async () => {
    const f = await fixture();
    const resources = structuredClone(f.resources);
    resources.source!.revision = null;
    expect(await f.prepare(identity, resources, '/skill:shared')).toMatchObject({ status: 'invalid' });
    expect(f.unexpected).not.toHaveBeenCalled();
    expect(f.trust).not.toHaveBeenCalled();
  });
});


it('prepares explicit body selections in text order, validates every occurrence and deduplicates only the same resource identity', async () => {
  const f = await fixture();
  const text = '先研究 /skill:independent，再使用 /skill:shared，最后 /skill:independent';
  const selection = (name: string, start = text.indexOf(`/skill:${name}`)) => {
    const skill = f.resources.snapshot.skills.find(skill => skill.name === name)!;
    return { resourceId: skill.id, version: skill.reference.version, start, end: start + `/skill:${name}`.length };
  };
  const selections = [selection('shared'), selection('independent', text.lastIndexOf('/skill:independent')), selection('independent')];
  const result = await f.prepare(identity, f.resources, text, undefined, selections);
  expect(result).toMatchObject({ status: 'ready', skill: null, skills: [
    { name: 'independent', body: 'USER BODY', arguments: '' }, { name: 'shared', body: 'PROJECT BODY', arguments: '' },
  ] });
  expect(f.unexpected).not.toHaveBeenCalled();
  expect(await f.prepare(identity, f.resources, text, undefined, [
    ...selections.slice(0, 2), { ...selections[2]!, version: 'changed' },
  ])).toMatchObject({ status: 'stale' });
  expect(await f.prepare(identity, f.resources, text, undefined, [{ ...selections[0]!, resourceId: 'unknown' }])).toMatchObject({ status: 'missing' });
});

it('rejects edited, overlapping and forged range fields without treating them as another skill', async () => {
  const f = await fixture();
  const skill = f.resources.snapshot.skills.find(skill => skill.name === 'independent')!;
  const text = '🌱 /skill:shared';
  const selection = { resourceId: skill.id, version: skill.reference.version, start: 3, end: text.length };
  expect(await f.prepare(identity, f.resources, text, undefined, [selection])).toMatchObject({ status: 'stale' });
  expect(() => parseThreadSkills([{ ...selection, body: 'untrusted' }], text)).toThrow('Malformed');
  expect(() => parseThreadSkills([selection, selection], text)).toThrow('overlap');
  expect(() => parseThreadSkills([{ ...selection, start: 1 }], text)).toThrow('Malformed');
  expect(() => parseThreadSkills([{ ...selection, end: text.length + 1 }], text)).toThrow('Malformed');
});


it('discovers global draft skills through the execution resource owner without creating a synthetic Thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-draft-skill-')); roots.push(root);
  await mkdir(path.join(root, 'resources/skills/draft'), { recursive: true });
  await writeFile(path.join(root, 'resources/skills/draft/SKILL.md'), file('draft', 'DRAFT BODY'));
  const unexpected = vi.fn(async () => { throw new Error('Global discovery has no workspace or Thread authority'); });
  const scope = createThreadResourceScope({ dataDirectory: root, homeDir: path.join(root, 'home'), workingStates: { withBranchStore: unexpected },
    documents: { admitWorkspaceRegistration: unexpected, inspectWorkspace: unexpected, readSnapshot: unexpected },
    configuration: async () => ({ packages: [] }), validateLiveSource: unexpected, withSourceRead: unexpected, projectTrusted: () => false });
  const skills = await scope.userSkills!();
  expect(skills).toMatchObject([{ name: 'draft', origin: 'user' }]);
  const execution = await scope.prepare({ runtime: 'agent', threadId: 'thread:real', branchId: 'branch:real' }, null,
    { mode: 'agent', threadRole: 'main', projectId: null });
  expect(skills[0]!.id).toBe(execution.skills[0]!.id);
  expect(skills[0]!.reference.version).toBe(execution.skills[0]!.reference.version);
  expect(unexpected).not.toHaveBeenCalled();
});
