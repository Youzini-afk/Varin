import { afterEach, describe, expect, test } from 'vitest';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { harnessShellIdFromDetails, attachProcessTerminal } from './attachProcessTerminal';

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
});
