import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstalledAgentResourcePackage } from '@varin/pi-host/agent-resource-configuration';
import type { ThreadSource } from '@varin/application-client';
import { createAgentResourceAuthority, type PreparedAgentResources } from '../agent-resources/authority.js';
import { contentVersion } from '../agent-resources/source-reader.js';
import { captureStableSourceBaseline, type SourceCaptureDocuments } from '../harness/working-state/source-preparation.js';
import type { RecoveryState, WorkingBranchCreateOptions, WorkingSourcePreparation, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import { createThreadResourceScope, parseSourceResourceCapture, ResourceScopeError, type ThreadResourceScopeOwners } from './thread-resource-scope.js';

const roots: string[] = [];
const identity = { runtime: 'agent' as const, threadId: 'thread', branchId: 'conversation' };
const admitted = { mode: 'agent' as const, threadRole: 'main', projectId: 'project' };
const authority = createAgentResourceAuthority();
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} description\n---\n${body}`;
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Native inventory/capture is represented here by a small temporary-file fixture; no IPC claim. */
async function fixture(files: Record<string, string>) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'varin-source-resources-')); roots.push(base);
  const root = path.join(base, 'workspace'); const agentDir = path.join(base, 'agent'); const home = path.join(base, 'home');
  await Promise.all([mkdir(root), mkdir(agentDir), mkdir(home)]);
  const write = async (file: string, body: string) => { await mkdir(path.dirname(path.join(base, file)), { recursive: true }); await writeFile(path.join(base, file), body); };
  for (const [file, content] of Object.entries(files)) await write(`workspace/${file}`, content);
  const objects = new Map<string, Buffer>();
  const branches = new Map<string, WorkingSourcePreparation & { states: Record<string, RecoveryState> }>();
  const scans: string[][] = [];
  const walk = async (relative: string, output: string[]) => {
    const file = path.join(root, relative);
    let info; try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (relative && relative !== '.') output.push(relative);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    for (const entry of await readdir(file)) {
      if (entry === '.git' || entry === '.varin') continue;
      await walk(path.posix.join(relative === '.' ? '' : relative, entry), output);
    }
  };
  const inventory = async (scopes: readonly string[]) => { const result: string[] = []; for (const scope of scopes) await walk(scope, result); return [...new Set(result)].sort(); };
  const capture = async (_root: string, paths?: string[]) => {
    const result: Record<string, RecoveryState> = {};
    for (const file of paths ?? await inventory([''])) {
      const absolute = path.join(root, file);
      try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) result[file] = { kind: 'symlink', symlinkTarget: await readlink(absolute), mode: info.mode & 0o7777 };
        else if (info.isDirectory()) result[file] = { kind: 'directory', mode: info.mode & 0o7777 };
        else {
          const bytes = await readFile(absolute); const hash = `sha256-${contentVersion(bytes)}`; objects.set(hash, bytes);
          result[file] = { kind: 'regular-file', objectHash: hash, byteLength: bytes.length, mode: info.mode & 0o7777 };
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; result[file] = { kind: 'missing' }; }
    }
    return result;
  };
  const release = vi.fn(async () => undefined);
  const store = {
    readSourcePreparation: vi.fn(async (id: string) => branches.get(id) ?? null),
    readOriginalSource: vi.fn(async (id: string) => { const value = branches.get(id); return value ? { root: value.branch.baseRoot, provenance: value.provenance } : null; }),
    listWorkspaceBaselinePaths: vi.fn(async () => inventory([''])),
    listCaptureScopePaths: vi.fn(async (_root: string, scopes: string[]) => { scans.push([...scopes]); return inventory(scopes); }),
    captureDirectory: vi.fn(capture), releaseCapturedStates: vi.fn(async () => undefined),
    createBranch: vi.fn(async (_workspace: string, id: string, states: Record<string, RecoveryState>, _ref: string, _drafts: string[], scopes: string[], options: WorkingBranchCreateOptions) => {
      const hash = contentVersion(JSON.stringify(states));
      const branch = { branchId: id, workspaceId: 'workspace', root: hash, baseRoot: hash, headRevision: 0, writeRevision: 0,
        captureScopes: scopes, draftBasePaths: [], createdAt: 1, updatedAt: 1 };
      branches.set(id, { branch, states: structuredClone(states), provenance: structuredClone(options.sourceProvenance!) }); return branch;
    }),
    pinBranch: vi.fn(async (id: string) => { const value = branches.get(id)!; return { ...value.branch, branch: value.branch, pinId: `pin:${id}`, revision: 0, view: 'revision', release }; }),
    readPath: vi.fn(async (id: string, file: string) => { const state = file ? branches.get(id)!.states[file] : { kind: 'directory' as const };
      return state ? { path: file, state, origin: 'base' } : null; }),
    listPaths: vi.fn(async (id: string, roots: string[]) => ({ entries: Object.entries(branches.get(id)!.states)
      .filter(([file]) => roots.some(root => !root || file === root || file.startsWith(`${root}/`))).map(([path, state]) => ({ path, state, origin: 'base' })) })),
    readContent: vi.fn(async (entry: { state: RecoveryState }) => entry.state.kind === 'regular-file' ? objects.get(entry.state.objectHash) ?? null : null),
  } as unknown as WorkingStateRootStore;
  const documents = {
    inspectWorkspace: vi.fn(async () => ({ root, workspaceId: 'workspace' })),
    beginDirtyStateBarrier: vi.fn(async () => ({ settle: async () => undefined, release: async () => undefined })),
    beginCapture: vi.fn(async () => ({ captureId: 'capture', workspaceId: 'workspace' })),
    completeCapture: vi.fn(async () => ({ stable: true, reasons: [] })),
    inspectMutation: vi.fn(async () => ({ activeWriters: [] })), inspectDirtyBuffers: vi.fn(async () => []),
    readSnapshot: vi.fn(async ({ resourceId }: { resourceId: string }) => {
      try {
        const info = await lstat(path.join(root, resourceId)); if (info.isDirectory()) return { status: 'unsupported' };
        const content = await readFile(path.join(root, resourceId), 'utf8'); return { status: 'ready', content, revision: contentVersion(content) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }; throw error; }
    }),
  } as unknown as ThreadResourceScopeOwners['documents'] & SourceCaptureDocuments;
  const workingStates = { withBranchStore: async (_workspace: string, _purpose: string, consume: (store: WorkingStateRootStore) => unknown) => consume(store) } as WorkspaceWorkingStateRootAccess;
  const trust = { value: true };
  const packages: InstalledAgentResourcePackage[] = [];
  const sourceReads = vi.fn();
  const options = { agentDir, homeDir: home, documents, workingStates, validateLiveSource: vi.fn(async () => undefined),
    projectTrusted: () => trust.value, configuration: async () => ({ packages }),
    withSourceRead: async <T>(input: import('./thread-resource-scope.js').ResourceSourceReadInput, consume: (view: import('./thread-resource-scope.js').ResourceSourceReadView) => Promise<T>) => {
      sourceReads(input);
      const pin = await store.pinBranch(input.source.branchId, { revision: input.source.revision });
      try { return await consume({ pin, original: await store.readOriginalSource(input.source.branchId), store }); }
      finally { await pin.release(); }
    } };
  const scope = createThreadResourceScope(options);
  const source: ThreadSource = { mode: 'fixed_branch', workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'source', revision: 0, tools: ['file_read'] };
  const prepare = async () => captureStableSourceBaseline({ store, workspaceId: 'workspace', captureWorkspaceId: 'workspace', branchId: 'source',
    directory: root, captureScopes: [], content: { mode: 'saved-files' } }, { documents, prepareResources: scope.prepareSourceCapture,
    inspectInventory: async () => ({ kind: 'git', baseRef: 'git-base', unborn: false, paths: ['AGENTS.md', '.gitignore'], gitlinks: [] }) });
  const candidate = () => scope.withScope(identity, source, admitted, async ({ admittedScope }) => {
    const result = await authority.prepare(admittedScope); if (result.status !== 'ready') throw new ResourceScopeError(result); return result.snapshot;
  });
  return { base, root, agentDir, home, write, store, branches, scans, documents, options, scope, trust, packages, sourceReads, source, prepare, candidate, release };
}

async function read(f: Awaited<ReturnType<typeof fixture>>, snapshot: PreparedAgentResources, name: string, support?: string) {
  const request = support ? { kind: 'skill-resource' as const, resourceId: snapshot.skills.find(skill => skill.name === name)!.id, relativePath: support }
    : { kind: 'skill' as const, resourceId: snapshot.skills.find(skill => skill.name === name)!.id };
  return f.scope.withScope(identity, f.source, admitted, ({ readers }) => authority.read({ snapshot, readers }, request), { snapshot, request, runId: 'run' });
}

describe('Thread source resource admission', () => {
  it('captures only required ignored roots in the original source transaction, retaining original bytes after live changes', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '.pi\nignored\n', '.pi/settings.json': '{}',
      '.pi/skills/review/SKILL.md': skill('review', 'ORIGINAL'), '.pi/skills/review/reference.txt': 'ORIGINAL SUPPORT', 'ignored/unrelated.txt': 'EXCLUDED' });
    const prepared = await f.prepare();
    expect(prepared.provenance.resources?.coverage).toMatchObject({ kind: 'selected', subtrees: ['.pi/skills', '.pi/skills/review'] });
    expect(f.branches.get('source')!.states['ignored/unrelated.txt']).toBeUndefined();
    expect(f.scans.flat()).not.toContain('.');
    await f.write('workspace/.pi/skills/review/SKILL.md', skill('review', 'LATER'));
    await f.write('workspace/.pi/skills/review/reference.txt', 'LATER SUPPORT');
    const snapshot = await f.candidate();
    const body = await read(f, snapshot, 'review');
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('ORIGINAL');
    const support = await read(f, snapshot, 'review', 'reference.txt');
    expect(support.status === 'ready' && support.kind === 'skill-resource' && support.file.content).toBe('ORIGINAL SUPPORT');
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.sourceReads).toHaveBeenCalledTimes(1);
    expect(f.sourceReads.mock.calls[0]?.[0]).toMatchObject({ paths: ['.pi/skills/review'], runId: 'run' });
    expect(parseSourceResourceCapture(prepared.provenance.resources)).toEqual(prepared.provenance.resources);
  });

  it('freezes external ancestors, configured skills and auto skill/SYSTEM symlinks into the same original receipt', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '.pi', '.pi/settings.json': JSON.stringify({ skills: ['../../external'] }) });
    await f.write('AGENTS.md', 'ANCESTOR ORIGINAL');
    await f.write('external/SKILL.md', skill('outside', 'EXTERNAL ORIGINAL'));
    await f.write('external/support.txt', 'EXTERNAL SUPPORT');
    await f.write('unrelated/secret.txt', 'DO NOT CAPTURE');
    await symlink('../unrelated', path.join(f.base, 'external/outside'));
    await f.write('preamble.md', 'SYSTEM ORIGINAL');
    await mkdir(path.join(f.root, '.pi/skills'), { recursive: true });
    await symlink(path.join(f.base, 'external'), path.join(f.root, '.pi/skills/alias'));
    await symlink(path.join(f.base, 'preamble.md'), path.join(f.root, '.pi/SYSTEM.md'));
    const prepared = await f.prepare();
    const external = prepared.provenance.resources?.configuredPaths[0]?.target;
    expect(external?.kind === 'capsule' && external.capsule.files.some(file => file.content === 'DO NOT CAPTURE')).toBe(false);
    expect(external?.kind === 'capsule' && external.capsule.failures.some(failure => failure.path === 'outside' && failure.status === 'denied')).toBe(true);
    expect(prepared.provenance.resources?.sourceLinks.map(link => link.path)).toEqual(expect.arrayContaining(['.pi/SYSTEM.md', '.pi/skills/alias']));
    await f.write('AGENTS.md', 'ANCESTOR LATER');
    await f.write('external/SKILL.md', skill('outside', 'EXTERNAL LATER'));
    await f.write('external/support.txt', 'SUPPORT LATER');
    await f.write('preamble.md', 'SYSTEM LATER');
    const snapshot = await f.candidate();
    expect(snapshot.capturedFiles.find(file => file.reference.path === '.pi/SYSTEM.md')?.content).toBe('SYSTEM ORIGINAL');
    expect(snapshot.capturedFiles.some(file => file.content === 'ANCESTOR ORIGINAL')).toBe(true);
    expect(snapshot.skills.filter(skill => skill.name === 'outside')).toHaveLength(1);
    const body = await read(f, snapshot, 'outside');
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('EXTERNAL ORIGINAL');
    const support = await read(f, snapshot, 'outside', 'support.txt');
    expect(support.status === 'ready' && support.kind === 'skill-resource' && support.file.content).toBe('EXTERNAL SUPPORT');
  });

  it('rejects source dependency changes before branch publication and preserves absence evidence', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '.pi', '.pi/settings.json': '{}' });
    const prepareResources = async (...args: Parameters<typeof f.scope.prepareSourceCapture>) => {
      const plan = await f.scope.prepareSourceCapture(...args);
      await f.write('workspace/.pi/settings.json', '{"skills":["different"]}');
      return plan;
    };
    await expect(captureStableSourceBaseline({ store: f.store, workspaceId: 'workspace', captureWorkspaceId: 'workspace', branchId: 'source',
      directory: f.root, captureScopes: [], content: { mode: 'saved-files' } }, { documents: f.documents, prepareResources,
      inspectInventory: async () => ({ kind: 'git', baseRef: 'git', unborn: false, paths: ['AGENTS.md'], gitlinks: [] }) })).rejects.toThrow('changed during capture');
    expect(f.branches.size).toBe(0);
  });

  it('serves frozen bodies after the original root and branch become unavailable, without obtaining another source grant', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '.pi', '.pi/settings.json': '{}', '.pi/skills/review/SKILL.md': skill('review', 'FROZEN') });
    await f.prepare(); const snapshot = await f.candidate();
    const request = { kind: 'skill' as const, resourceId: snapshot.skills.find(skill => skill.name === 'review')!.id };
    await expect(f.scope.withScope(identity, f.source, admitted, async () => { f.trust.value = false; return 'stale'; }, { snapshot, request }))
      .rejects.toMatchObject({ failure: { status: 'denied' } });
    f.trust.value = true;
    await rm(f.root, { recursive: true }); f.branches.clear();
    vi.mocked(f.documents.inspectWorkspace).mockRejectedValue(new Error('Original root is gone'));
    vi.mocked(f.store.pinBranch).mockRejectedValue(new Error('Original branch is gone'));
    const body = await read(f, snapshot, 'review');
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('FROZEN');
    expect(f.sourceReads).not.toHaveBeenCalled();
    expect(await read(f, snapshot, 'review', 'uncaptured.txt')).toMatchObject({ status: 'unavailable' });
    expect(f.sourceReads).toHaveBeenCalledOnce();
    f.trust.value = false;
    await expect(read(f, snapshot, 'review')).rejects.toMatchObject({ failure: { status: 'denied' } });
  });

  it('keeps independent user resources and directory context readable after project trust revocation', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '', '.pi/settings.json': '{}' });
    await f.write('agent/skills/global/SKILL.md', skill('global', 'USER ORIGINAL'));
    await f.prepare(); const snapshot = await f.candidate();
    await rm(path.join(f.agentDir, 'skills'), { recursive: true });
    const body = await read(f, snapshot, 'global');
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('USER ORIGINAL');
    expect(await read(f, snapshot, 'global', 'later.txt')).toMatchObject({ status: 'unavailable' });
    f.trust.value = false;
    expect(await read(f, snapshot, 'global')).toMatchObject({ status: 'ready' });
    const request = { kind: 'instruction-scope' as const, targetPath: '', targetType: 'directory' as const };
    const context = await f.scope.withScope(identity, f.source, admitted, ({ readers }) => authority.read({ snapshot, readers }, request), { snapshot, request });
    expect(context).toMatchObject({ status: 'ready', instructions: expect.arrayContaining([expect.objectContaining({ content: 'ROOT' })]) });
  });

  it('retains actual package selection trust dependencies, including project deltas over user packages', async () => {
    const f = await fixture({ 'AGENTS.md': 'ROOT', '.gitignore': '.pi', '.pi/settings.json': JSON.stringify({ packages: [
      { source: 'npm:shared', autoload: false, skills: ['+skills/project/SKILL.md'] }, 'npm:project-only',
    ] }) });
    await f.write('agent/settings.json', JSON.stringify({ packages: ['npm:shared', 'npm:user-only'] }));
    for (const [name, names] of [['shared', ['project', 'fallback']], ['user-only', ['user-package']], ['project-only', ['project-package']]] as const) {
      await f.write(`packages/${name}/package.json`, JSON.stringify({ pi: { skills: ['skills'] } }));
      for (const skillName of names) await f.write(`packages/${name}/skills/${skillName}/SKILL.md`, skill(skillName, `${skillName} ORIGINAL`));
      f.packages.push({ identity: `npm:${name}`, source: `npm:${name}`, installedPath: path.join(f.base, 'packages', name), scope: name === 'project-only' ? 'project' : 'user' });
      if (name === 'shared') f.packages.push({ ...f.packages.at(-1)!, scope: 'project' });
    }
    await f.prepare(); const snapshot = await f.candidate();
    expect(snapshot.skills.map(item => [item.name, item.requiresProjectTrust])).toEqual(expect.arrayContaining([
      ['project', true], ['project-package', true], ['fallback', false], ['user-package', false],
    ]));
    f.trust.value = false;
    for (const name of ['project', 'project-package']) await expect(read(f, snapshot, name)).rejects.toMatchObject({ failure: { status: 'denied' } });
    for (const name of ['fallback', 'user-package']) expect(await read(f, snapshot, name)).toMatchObject({ status: 'ready' });
  });

  it('freezes the selected nested-worktree context shadow through the existing Git owner', async () => {
    const f = await fixture({ 'AGENTS.md': 'WORKTREE', '.git': 'gitdir: ../.git/worktrees/nested', '.gitignore': '', '.pi/settings.json': '{}' });
    await f.write('AGENTS.md', 'PRIMARY');
    await mkdir(path.join(f.base, '.git'), { recursive: true });
    const gitOwner = vi.fn(async () => ({ root: f.base }));
    const scope = createThreadResourceScope({ ...f.options, resolvePrimaryWorktreeRoot: gitOwner });
    const prepared = await captureStableSourceBaseline({ store: f.store, workspaceId: 'workspace', captureWorkspaceId: 'workspace', branchId: 'source',
      directory: f.root, captureScopes: [], content: { mode: 'saved-files' } }, { documents: f.documents, prepareResources: scope.prepareSourceCapture,
      inspectInventory: async () => ({ kind: 'directory' }) });
    expect(gitOwner).toHaveBeenCalledWith(f.root);
    expect(prepared.provenance.resources?.shadowedContextCanonicalIds).toHaveLength(1);
    expect(prepared.provenance.resources?.coverage).toEqual({ kind: 'complete' });
    const snapshot = await f.candidate();
    expect(snapshot.instructions.some(item => item.reference.canonicalId === prepared.provenance.resources!.shadowedContextCanonicalIds[0])).toBe(false);
    expect(snapshot.capturedFiles.some(file => file.content === 'WORKTREE')).toBe(true);
  });

});
