import { createManagedRemoteTargetRegistry } from './managed-remote-client.js';
import { createManagedSourceService } from './managed-source-service.js';
import { expect, it } from 'vitest';
import { decodeManagedProjectManagementResponse as decode } from './managed-source-response.js';

it('admits only the worktrees command array with typed Git entries', () => {
  const entries = [{ head: 'commit', name: 'main', branch: 'main', path: '/target/project' }];
  expect(decode('worktrees', entries)).toBe(entries);
  expect(decode('worktrees', [])).toEqual([]);
  expect(() => decode('worktrees', {})).toThrow('unconfirmed');
  expect(() => decode('worktrees', [{ path: '/target/project' }])).toThrow('unconfirmed');
  expect(() => decode('inspect', entries)).toThrow('unconfirmed');
  expect(() => decode('enable', null)).toThrow('unconfirmed');
  expect(() => decode('worktree-create', {})).toThrow('unconfirmed');
  expect(() => decode('worktree-remove', { success: 'true' })).toThrow('unconfirmed');
  expect(decode('worktree-remove', { success: true })).toEqual({ success: true });
});


it.each(['git-command', 'github-command'] as const)('preserves original %s results through target service, JSON transport and client decoding', async action => {
  const values: unknown[] = [undefined, null, false, true, 0, 12, '', 'original', [], ['file'], { original: true }];
  let value: unknown, calls = 0;
  const target = createManagedSourceService({ kernel: {}, documents: {}, hostId: 'target',
    projectManagement: async () => { calls++; return value; } } as never);
  const registry = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never, resources: {} as never,
    readSettings: async () => ({ desktopHosts: [{ id: 'connection', apiUrl: 'https://target.example' }] }),
    fetch: async (url, init) => {
      const response = String(url).endsWith('/identity') ? { protocolVersion: 1, hostId: 'target', capabilities: ['sources'], machine: { machineId: 'managed:target', kind: 'managed-remote', state: 'available' } }
        : await target.projectManagement({ principalId: 'paired', capabilities: ['filesystem:read'] }, JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response), { headers: { 'x-varin-managed-host': 'target' } });
    },
  });
  const owner = (await registry.sourceTargets()).targets[0]!.resourceOwner;
  const client = await registry.source(owner);
  for (const expected of values) {
    value = expected;
    const command = action === 'git-command'
      ? { action, input: { operation: 'stageGitFile' as const, selection: { mode: 'live_root' as const }, args: ['/target', 'file'] as [string, string] } }
      : { action, input: { operation: 'prStatus' as const, selection: { mode: 'live_root' as const }, args: ['/target', 'main'] as [string, string] } };
    expect(await client.projectManagement({ coordinatorHostId: 'coordinator', projectId: 'project', workspaceId: 'workspace', command })).toEqual(expected);
  }
  expect(calls).toBe(values.length); // A void result must not provoke a mutation retry.
});

it('rejects missing, mixed-operation and malformed project command receipts', () => {
  const input = { operation: 'stageGitFile' };
  for (const result of [undefined, null, [], {}, { kind: 'project-command-result', action: 'github-command', operation: 'stageGitFile', result: { kind: 'void' } },
    { kind: 'project-command-result', action: 'git-command', operation: 'unstageGitFile', result: { kind: 'void' } },
    { kind: 'project-command-result', action: 'git-command', operation: 'stageGitFile', result: { kind: 'value' } },
    { kind: 'project-command-result', action: 'git-command', operation: 'stageGitFile', result: { kind: 'void', value: null } }]) {
    expect(() => decode('git-command', result, input)).toThrow('unconfirmed');
  }
});
