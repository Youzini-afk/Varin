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
