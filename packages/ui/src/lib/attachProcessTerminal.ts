import { useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';

const SHELL_ID = /^sh_\d+$/;

const asShellId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return SHELL_ID.test(id) ? id : null;
};

export function harnessShellIdFromDetails(details: unknown): string | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  return asShellId(record.shellId)
    ?? (record.kind === 'background' ? asShellId(record.id) : null)
    ?? asShellId(record.handle);
}

export function attachProcessTerminal(directory: string, sessionId: string, command?: string): string | null {
  const cwd = directory.trim();
  const id = sessionId.trim();
  if (!cwd || !id) return null;
  const store = useTerminalStore.getState();
  store.ensureDirectory(cwd);
  const label = command?.trim() ? command.trim().split('\n')[0]?.slice(0, 40) : `Shell ${id}`;
  const tabId = store.attachExistingSession(cwd, id, label);
  useUIStore.getState().openContextPanelTab(cwd, { mode: 'terminal' });
  return tabId;
}
