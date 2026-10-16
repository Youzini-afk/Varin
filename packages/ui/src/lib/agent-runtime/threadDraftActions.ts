import type { ThreadIdentity } from '@varin/application-client';
import { threadComposerKey, selectedComposerKey, useThreadStore } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { startThreadFromNavigation } from './threadNavigation';

export const joinDraftInstructions = (...parts: Array<string | null | undefined>) => parts.map(part => part?.trim()).filter(Boolean).join('\n\n');
export function stageThreadDraft(identity: ThreadIdentity | string, seed: { text: string; instructions?: string }): void {
  useThreadDraftStore.getState().patch(typeof identity === 'string' ? identity : threadComposerKey(useThreadStore.getState().hostKey, identity), { text: joinDraftInstructions(seed.text, seed.instructions) });
}
export async function createThreadWithDraft(target: { directory?: string | null }, seed: { text: string; instructions?: string }): Promise<string> {
  const identity = await startThreadFromNavigation(target); stageThreadDraft(identity, seed); return identity;
}
export async function ensureThreadDraftTarget(directory?: string | null): Promise<{ directory: string; sessionKey: string }> {
  const path = directory?.trim() || useDirectoryStore.getState().currentDirectory;
  if (!path) throw new Error('Select a workspace to attach this context');
  const sessionKey = selectedComposerKey(useThreadStore.getState()) ?? await startThreadFromNavigation({ directory: path });
  return { directory: path, sessionKey };
}
