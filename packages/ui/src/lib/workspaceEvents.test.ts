import { describe, expect, test } from 'vitest';
import { workspaceEvents } from './workspaceEvents';

describe('workspaceEvents', () => {
  test('delivers directory requests until the listener unsubscribes', () => {
    let calls = 0;
    const unsubscribe = workspaceEvents.onDirectoryRequest(() => {
      calls += 1;
    });
    workspaceEvents.requestDirectoryDialog();
    unsubscribe();
    workspaceEvents.requestDirectoryDialog();
    expect(calls).toBe(1);
  });

  test('delivers valid git refresh hints and ignores blank directories', () => {
    const directories: string[] = [];
    const unsubscribe = workspaceEvents.onGitRefreshHint((hint) => {
      directories.push(hint.directory);
    });
    workspaceEvents.requestGitRefresh({ directory: '   ' });
    workspaceEvents.requestGitRefresh({ directory: 'D:/repo' });
    unsubscribe();
    expect(directories).toEqual(['D:/repo']);
  });
});
