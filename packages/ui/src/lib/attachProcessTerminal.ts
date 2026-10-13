import { useTerminalStore, type TerminalProcessReference } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import type { SourceResourceOwner } from '@varin/protocol';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { resolvePiEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

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

export function attachProcessTerminal(directory: string, sessionId: string, command?: string, resourceOwner: SourceResourceOwner = { kind: 'local' }, process?: TerminalProcessReference): string | null {
  const cwd = directory.trim();
  const id = sessionId.trim();
  if (!cwd || !id) return null;
  // A managed Source cwd belongs to another Host. Keep the current navigation
  // workspace and carry that cwd only as terminal metadata, never resolve it on A.
  let navigationDirectory: string | undefined = cwd;
  if (resourceOwner.kind === 'managed_host') {
    const sessions = usePiSessionStore.getState();
    const currentSessionId = sessions.currentSessionId;
    navigationDirectory = resolvePiEffectiveDirectory(
      currentSessionId ? sessions.records[currentSessionId]?.snapshot?.cwd : undefined,
      sessions.summaries.find(session => session.id === currentSessionId)?.cwd,
      useDirectoryStore.getState().currentDirectory,
    );
  }
  const store = useTerminalStore.getState();
  const label = command?.trim() ? command.trim().split('\n')[0]?.slice(0, 40) : `Shell ${id}`;
  const source = { cwd, resourceOwner, ...(process ? { process } : {}) };
  if (!navigationDirectory) {
    // This is a terminal-view key, never a path sent to Documents or shell creation.
    const directoryKey = `process-terminal:${id}`;
    const tabId = store.attachExistingSession(directoryKey, id, label, source);
    const title = resourceOwner.kind === 'managed_host' ? `${resourceOwner.hostId} · ${cwd}` : cwd;
    useWorkspaceStore.getState().openAttachedTerminal(directoryKey, title);
    return tabId;
  }
  store.ensureDirectory(navigationDirectory);
  const tabId = store.attachExistingSession(navigationDirectory, id, label, source);
  useUIStore.getState().openContextPanelTab(navigationDirectory, { mode: 'terminal' });
  return tabId;
}
