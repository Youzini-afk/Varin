import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createManagedTerminalOwner } from './managed-owner.js';
import type { TerminalSessionInfo } from './session-api.js';

it('admits an alias of the frozen root but rejects another physical directory before preparing or launching', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-frozen-identity-'));
  try {
    const original = path.join(root, 'original'), alias = path.join(root, 'alias'), foreign = path.join(root, 'foreign');
    await fs.mkdir(original); await fs.mkdir(foreign);
    await fs.symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalPath = await fs.realpath(original);
    let session: TerminalSessionInfo | undefined;
    const prepareSelection = vi.fn(async () => ({ path: '/owned-native-view' }));
    const createTerminalSession = vi.fn(async (input: unknown) => { session = { ...input as object, status: 'running' } as TerminalSessionInfo; });
    const owner = createManagedTerminalOwner({
      documents: { admitWorkspaceRegistration: async () => ({ canonicalPath }) } as never,
      nativeWorkspaces: { prepareSelection } as never,
      terminal: () => ({ inspectSession: () => session, attachTerminalSession: () => ({}), createTerminalSession }) as never,
    });
    const principal = { principalId: 'paired', capabilities: ['terminal:use', 'process:control'], allowedDirectories: [original] };
    const selection = { mode: 'native_workspace' as const, workspaceId: 'workspace', executionWorkspaceId: 'execution', branchId: 'branch', adoptionOperationId: 'adopt' };
    const create = (cwd: string) => owner.command(principal, { coordinatorHostId: 'coordinator', sessionId: 'original-session', command: { action: 'create', options: { cwd, selection } } });
    await expect(create(foreign)).rejects.toThrow('differs from its frozen project source');
    expect(prepareSelection).not.toHaveBeenCalled(); expect(createTerminalSession).not.toHaveBeenCalled();
    await expect(create(alias)).resolves.toMatchObject({ cwd: '/owned-native-view', status: 'running' });
    expect(prepareSelection).toHaveBeenCalledOnce();
    expect(session?.source).toEqual({ selection, canonicalRoot: canonicalPath });
    await expect(create(original)).resolves.toMatchObject({ cwd: '/owned-native-view' });
    expect(prepareSelection).toHaveBeenCalledOnce();
    await expect(create(foreign)).rejects.toThrow('differs from its frozen project source');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
