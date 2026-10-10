import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentResourceAuthority } from '../agent-resources/authority.js';
import { createAdmittedDirectoryReader } from '../agent-resources/source-reader.js';
import { createThreadResourceScope, type ThreadResourceScopeOwners } from './thread-resource-scope.js';
import { createThreadSkillInputPreparer } from './thread-skill-input.js';
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
    'user/skills/independent/SKILL.md': file('independent', 'USER BODY'), 'project/.pi/skills/shared/SKILL.md': file('shared', 'PROJECT BODY') })) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  const user = await createAdmittedDirectoryReader({ domainId: 'user', viewId: 'user-v1', root: userRoot });
  const project = await createAdmittedDirectoryReader({ domainId: 'project', viewId: 'project-v1', root: projectRoot });
  const prepared = await createAgentResourceAuthority().prepare({ threadId: identity.threadId, branchId: identity.branchId,
    mode: 'agent', threadRole: 'main', projectId: 'project', sourceIdentity: 'original-source', projectTrusted: true,
    user: { reader: user, displayRoot: userRoot }, project: { reader: project, displayRoot: projectRoot, cwd: '' } });
  if (prepared.status !== 'ready') throw new Error(prepared.reason);
  const resources: ContextResources = { snapshot: prepared.snapshot, source: { mode: 'fixed_branch', workspace_id: 'workspace',
    execution_workspace_id: 'workspace', branch_id: 'original-source', revision: 1, live_root: null } };
  const unexpected = vi.fn(async () => { throw new Error('Skill activation must not open a source or rediscover resources'); });
  const trust = vi.fn<ThreadResourceScopeOwners['projectTrusted']>(() => true);
  const scope = createThreadResourceScope({ agentDir: userRoot, workingStates: { withBranchStore: unexpected },
    documents: { inspectWorkspace: unexpected, readSnapshot: unexpected }, configuration: unexpected,
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
