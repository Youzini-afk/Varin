import type { AgentInputContext } from '@varin/protocol';
import { getDocumentRegistry } from '@/lib/documents/session';

export const captureSurfaceAgentInputContext = async (
  sessionId: string,
): Promise<AgentInputContext> => {
  try {
    return await getDocumentRegistry().captureAgentInputContext(sessionId);
  } catch {
    return {
      source: 'surface',
      roots: [], // Unknown dirty set; Host consumers must not infer clean disk.
      snapshot: { status: 'unavailable', reason: 'surface-unavailable' },
    };
  }
};

export const releaseSurfaceAgentInputContext = async (
  sessionId: string,
  context: AgentInputContext,
): Promise<void> => {
  if (context.source !== 'surface' || context.snapshot.status !== 'ready') return;
  try {
    await getDocumentRegistry().releaseAgentInputContext(sessionId, context);
  } catch {
    // SessionHost may already have committed or released the pending snapshot.
  }
};
