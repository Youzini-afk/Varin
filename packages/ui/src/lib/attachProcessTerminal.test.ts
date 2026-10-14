import { afterEach, describe, expect, test } from 'vitest';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { harnessShellIdFromDetails, attachProcessTerminal } from './attachProcessTerminal';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

describe('harness terminal attach helpers', () => {
  afterEach(() => {
    useTerminalStore.getState().clearAll();
  });

  test('reads the public shell id from background, write, and get_output details', () => {
    expect(harnessShellIdFromDetails({ kind: 'background', id: 'sh_1' })).toBe('sh_1');
    expect(harnessShellIdFromDetails({ shellId: 'sh_2' })).toBe('sh_2');
    expect(harnessShellIdFromDetails({ handle: 'sh_3', running: true })).toBe('sh_3');
    expect(harnessShellIdFromDetails({ handle: 'out_abc' })).toBeNull();
    expect(harnessShellIdFromDetails({ id: 'sh_9' })).toBeNull();
    expect(harnessShellIdFromDetails({ kind: 'completed', id: 'sh_1' })).toBeNull();
  });

  test('opens a detachable tab on the existing terminal session', () => {
    const tabId = attachProcessTerminal('/repo', 'sh_1', 'sleep 90');
    const state = useTerminalStore.getState().getDirectoryState('/repo');
    const tab = state?.tabs.find((entry) => entry.id === tabId);
    expect(tab?.terminalSessionId).toBe('sh_1');
    expect(tab?.closePolicy).toBe('detach');
    expect(tab?.label).toContain('sleep 90');
    const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs.some((entry) => entry.mode === 'terminal')).toBe(true);
    expect(attachProcessTerminal('/repo', 'sh_1')).toBe(tabId);
  });

  test('attaches a managed Source under the current navigation root without selecting its remote cwd', () => {
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    useDirectoryStore.setState({ currentDirectory: '/coordinator-only' });
    try {
      const owner = { kind: 'managed_host' as const, hostId: 'host-b', connectionId: 'b', endpointIdentity: 'sha256-b' };
      const process = { identity: { runtime: 'agent' as const, threadId: 'original-thread', branchId: 'original-branch' },
        operationId: 'original-operation', processId: 'original-process', endpointGeneration: 1 };
      const tabId = attachProcessTerminal('/exists-only-on-b', 'managed-terminal', 'Agent process', owner, process);
      const tab = useTerminalStore.getState().getActiveTab('/coordinator-only');
      expect(tab?.id).toBe(tabId);
      expect(tab?.source).toEqual({ cwd: '/exists-only-on-b', resourceOwner: owner, process });
      expect(tab?.terminalSessionId).toBe('managed-terminal');
      expect(tab?.closePolicy).toBe('detach');
      expect(useUIStore.getState().contextPanelByDirectory['/coordinator-only']?.isOpen).toBe(true);
      expect(useTerminalStore.getState().getDirectoryState('/exists-only-on-b')).toBeUndefined();
      expect(useDirectoryStore.getState().currentDirectory).toBe('/coordinator-only');
      expect(attachProcessTerminal('/exists-only-on-b', 'managed-terminal', undefined, owner)).toBe(tabId);
    } finally {
      useDirectoryStore.setState({ currentDirectory: previousDirectory });
    }
  });
});
