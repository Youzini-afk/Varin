import type { ThreadIdentity } from '@varin/application-client';
import { threadIdentityKey, useThreadStore } from '@/stores/useThreadStore';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { startThreadFromNavigation } from './threadNavigation';

export const joinDraftInstructions = (...parts: Array<string | null | undefined>) => parts.map(part => part?.trim()).filter(Boolean).join('\n\n');
export function stageThreadDraft(identity: ThreadIdentity, seed: { text: string; instructions?: string }): void {
  useThreadDraftStore.getState().patch(threadIdentityKey(useThreadStore.getState().hostKey, identity), { text: joinDraftInstructions(seed.text, seed.instructions) });
}
export async function createThreadWithDraft(target: { directory?: string | null }, seed: { text: string; instructions?: string }): Promise<ThreadIdentity> {
  const identity = await startThreadFromNavigation(target); stageThreadDraft(identity, seed); return identity;
}
export async function ensureThreadDraftTarget(directory?: string | null): Promise<{ directory: string; sessionKey: string }> {
  const path = directory?.trim() || useDirectoryStore.getState().currentDirectory;
  if (!path) throw new Error('Select a workspace to attach this context');
  const identity = useThreadStore.getState().selectedIdentity ?? await startThreadFromNavigation({ directory: path });
  return { directory: path, sessionKey: threadIdentityKey(useThreadStore.getState().hostKey, identity) };
}
