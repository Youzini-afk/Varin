import { describe, expect, it, vi } from 'vitest';
import type { KernelClient, KernelGrantIssueInput } from './kernel-client.js';
import { createPinnedResourceReader } from '../agent-resources/source-reader.js';
import { KernelStorageAdapter } from './storage-adapter.js';
import type { ResourceSourceReadInput } from './thread-resource-scope.js';

function fixture() {
  const file = { path: '.pi/skills/review/SKILL.md', state: { kind: 'regular-file', objectHash: 'sha256-body', byteLength: 4, mode: 0o644 } };
  const branch = { branchId: 'source', workspaceId: 'original', root: 'fixed-root', currentRoot: 'later-root', revision: 7,
    writeRevision: 8, headRevision: 7, view: 'revision', captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 2, entries: [file], nextCursor: null };
  const pin = { ...branch, pinId: 'resource-pin', writeRevision: 7 };
  const scoped = {
    readBranch: vi.fn(async (input: { revision?: number }) => ({ ...branch, revision: input.revision ?? 8, view: input.revision === undefined ? 'current' : 'revision' })), pinBranch: vi.fn(async () => pin), unpinBranch: vi.fn(async () => ({ released: true })),
    readPin: vi.fn(async () => pin), getOperation: vi.fn(async () => null),
    getBlob: vi.fn(async () => ({ bytesBase64: Buffer.from('BODY').toString('base64'), nextOffset: 4, eof: true })),
  };
  const client = {
    issueGrant: vi.fn(async (input: KernelGrantIssueInput) => ({ ...input, storageIdentity: 'storage' })),
    revokeGrant: vi.fn(async () => undefined), scoped: vi.fn(() => scoped),
  };
  const resolveWorkspaceRoot = vi.fn(async () => { throw new Error('Resource reader must not reopen a physical root'); });
  const adapter = new KernelStorageAdapter({ client: client as unknown as KernelClient, hostId: 'host', storageRoot: '/unused', resolveWorkspaceRoot });
  const input: ResourceSourceReadInput = { identity: { runtime: 'agent', threadId: 'fork', branchId: 'fork-conversation' }, runId: 'new-run',
    source: { mode: 'fixed_branch', workspaceId: 'original', executionWorkspaceId: 'original-execution', branchId: 'source', revision: 7, tools: [] },
    paths: ['.pi/skills/review'] };
  return { adapter, client, scoped, resolveWorkspaceRoot, input, file };
}

describe('frozen resource Storage admission', () => {
  it('opens the exact original revision using a current Thread/Run readonly grant, without physical file authority', async () => {
    const f = fixture();
    const result = await f.adapter.withResourceRead(f.input, async ({ store, pin, original }) => {
      expect(Object.keys(store).sort()).toEqual(['listPaths', 'readContent', 'readPath']);
      expect(pin).toMatchObject({ branchId: 'source', revision: 7, root: 'fixed-root' });
      expect(original).toBeNull();
      const file = await store.readPath('source', f.file.path, { pin });
      expect(file?.state).toEqual(f.file.state);
      expect(await store.readContent(file!)).toEqual(Buffer.from('BODY'));
      expect((await store.listPaths('source', ['.pi/skills/review'], { pin }))?.entries).toHaveLength(1);
      return 'read';
    });
    expect(result).toBe('read');
    expect(f.client.issueGrant).toHaveBeenCalledOnce();
    expect(f.client.issueGrant).toHaveBeenCalledWith({ grantId: expect.stringMatching(/^resource-read:/), threadId: 'fork', runId: 'new-run',
      owningWorkspace: 'original', executionWorkspace: 'original-execution', capabilities: ['storage.read'], pathScopes: ['.pi/skills/review'] });
    expect(f.scoped.pinBranch).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'source', revision: 7 }), undefined);
    expect(f.scoped.getBlob).toHaveBeenCalledWith('sha256-body', { pinId: 'resource-pin', path: f.file.path }, expect.anything());
    expect(f.resolveWorkspaceRoot).not.toHaveBeenCalled();
    expect(f.scoped.unpinBranch).toHaveBeenCalledOnce();
    expect(f.client.revokeGrant).toHaveBeenCalledWith(expect.stringMatching(/^resource-read:/));
    expect(f.scoped.unpinBranch.mock.invocationCallOrder[0]).toBeLessThan(f.client.revokeGrant.mock.invocationCallOrder[0]!);
  });

  it.each(['failure', 'cancelled'] as const)('releases the original pin and grant on %s without publishing a result', async outcome => {
    const f = fixture(); const controller = new AbortController();
    await expect(f.adapter.withResourceRead({ ...f.input, signal: controller.signal }, async () => {
      if (outcome === 'failure') throw new Error('read failed');
      controller.abort(); return 'must not publish';
    })).rejects.toThrow(outcome === 'failure' ? 'read failed' : /abort/i);
    expect(f.scoped.unpinBranch).toHaveBeenCalledOnce();
    expect(f.client.revokeGrant).toHaveBeenCalledOnce();
    expect(f.resolveWorkspaceRoot).not.toHaveBeenCalled();
  });

  it('derives only observed same-pin instruction targets, retaining the original chained bytes and rejecting a sibling secret', async () => {
    const states = new Map([
      ['src', { kind: 'directory' }], ['guidance', { kind: 'directory' }], ['guidance/versions', { kind: 'directory' }],
      ['src/AGENTS.md', { kind: 'symlink', symlinkTarget: '../guidance/current.md' }],
      ['guidance/current.md', { kind: 'symlink', symlinkTarget: 'versions/v1.md' }],
      ['guidance/versions/v1.md', { kind: 'regular-file', objectHash: 'original', byteLength: 8 }],
      ['guidance/secret.md', { kind: 'regular-file', objectHash: 'secret', byteLength: 6 }],
    ]);
    const grants: KernelGrantIssueInput[] = [];
    const released: string[] = [];
    const pinOwners = new Map<string, string>();
    const metadata = { branchId: 'source', workspaceId: 'original', root: 'fixed-root', currentRoot: 'new-live-root', revision: 7,
      writeRevision: 8, headRevision: 7, captureScopes: [], draftBasePaths: [], createdAt: 1, updatedAt: 2, nextCursor: null };
    const denied = () => { throw Object.assign(new Error('outside readonly scope'), { code: 'unauthorized' }); };
    const client = {
      issueGrant: vi.fn(async (input: KernelGrantIssueInput) => { grants.push(input); return input; }),
      revokeGrant: vi.fn(async (id: string) => { released.push(id); }),
      scoped: (grant: KernelGrantIssueInput) => {
        const contentAllowed = (target: string) => grant.pathScopes.some(scope => target === scope || target.startsWith(`${scope}/`));
        const entries = (targets: string[]) => targets.map(target => {
          const state = states.get(target) ?? { kind: 'missing' };
          if (!contentAllowed(target) && !((state.kind === 'directory' || state.kind === 'symlink')
            && grant.pathScopes.some(scope => !target || scope.startsWith(`${target}/`)))) denied();
          return { path: target, state };
        });
        return {
          readBranch: async (input: { revision?: number; paths?: string[] }) => ({ ...metadata, revision: input.revision ?? 8,
            view: input.revision === undefined ? 'current' : 'revision', entries: entries(input.paths ?? []) }),
          pinBranch: async () => { const pinId = `pin:${grant.grantId}`; pinOwners.set(pinId, grant.grantId);
            return { ...metadata, pinId, view: 'revision', writeRevision: 7 }; },
          readPin: async (input: { pinId: string; paths?: string[] }) => {
            if (pinOwners.get(input.pinId) !== grant.grantId) denied();
            return { ...metadata, pinId: input.pinId, view: 'revision', writeRevision: 7, entries: entries(input.paths ?? []) };
          },
          unpinBranch: async (input: { pinId: string }) => { expect(pinOwners.get(input.pinId)).toBe(grant.grantId); pinOwners.delete(input.pinId); return {}; },
          getOperation: async () => null,
          getBlob: async (hash: string, source: { pinId: string; path: string }) => {
            if (pinOwners.get(source.pinId) !== grant.grantId || !contentAllowed(source.path)) denied();
            return { bytesBase64: Buffer.from(hash === 'original' ? 'ORIGINAL' : 'SECRET').toString('base64'), nextOffset: 8, eof: true };
          },
        };
      },
    };
    const input = { ...fixture().input, paths: ['src/AGENTS.md'] };
    const resolveWorkspaceRoot = vi.fn(async () => { throw new Error('Later live source points to secret and must not be read'); });
    const adapter = new KernelStorageAdapter({ client: client as unknown as KernelClient, hostId: 'host', storageRoot: '/unused', resolveWorkspaceRoot });
    await adapter.withResourceRead(input, async ({ store, pin, admitSymlinkTarget }) => {
      const reader = createPinnedResourceReader({ domainId: 'project', store, pin, coverage: { kind: 'complete' }, ...(admitSymlinkTarget ? { admitSymlinkTarget } : {}) });
      expect(await reader.read('src/AGENTS.md')).toMatchObject({ status: 'ready', content: 'ORIGINAL', reference: { canonicalId: 'resource:project/guidance/versions/v1.md' } });
      await expect(store.readContent({ path: 'guidance/secret.md', state: { kind: 'regular-file', objectHash: 'secret', byteLength: 6 }, origin: 'base',
        contentSource: { kind: 'pin', pinId: `pin:${grants.at(-1)!.grantId}`, path: 'guidance/secret.md' } })).rejects.toMatchObject({ code: 'unauthorized' });
    });
    expect(grants.map(grant => grant.pathScopes)).toEqual([
      ['src/AGENTS.md'], ['src/AGENTS.md', 'guidance/current.md'], ['src/AGENTS.md', 'guidance/current.md', 'guidance/versions/v1.md'],
    ]);
    expect(grants.every(grant => JSON.stringify(grant.capabilities) === JSON.stringify(['storage.read']))).toBe(true);
    expect(resolveWorkspaceRoot).not.toHaveBeenCalled();
    expect(pinOwners.size).toBe(0);
    expect(released).toHaveLength(grants.length);
  });

});
