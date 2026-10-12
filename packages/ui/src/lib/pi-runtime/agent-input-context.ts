import type { AgentInputContext, AgentInputSnapshotConsumer } from '@varin/protocol';
import { getDocumentRegistry } from '@/lib/documents/session';

export const captureSurfaceAgentInputContext = async (
  consumer: AgentInputSnapshotConsumer,
): Promise<AgentInputContext> => {
  try {
    return await getDocumentRegistry().captureAgentInputContext(consumer);
  } catch {
    return {
      source: 'surface',
      roots: [], // Unknown dirty set; Host consumers must not infer clean disk.
      snapshot: { status: 'unavailable', reason: 'surface-unavailable' },
    };
  }
};

export const releaseSurfaceAgentInputContext = async (
  consumer: AgentInputSnapshotConsumer,
  context: AgentInputContext,
): Promise<void> => {
  if (context.source !== 'surface' || context.snapshot.status !== 'ready') return;
  try {
    await getDocumentRegistry().releaseAgentInputContext(consumer, context);
  } catch {
    // SessionHost may already have committed or released the pending snapshot.
  }
};
