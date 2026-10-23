import { createKnowledgeInference } from './inference.js';
import type { KnowledgeEmbedderResolution } from './runtime.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import { SemanticInferenceError, type SemanticInference } from '../semantic/runtime-inference.js';
import { HarnessInferenceSettingsValidationError, parseHarnessEmbeddingSettings } from '@varin/protocol';
import type { SemanticEmbedder } from '../semantic/embedder.js';
import { captureKnowledgeLocalLease } from './local-lease.js';

/** Knowledge embeddings have no workspace inventory, code index or language-service owner. */
export function createKnowledgeEmbeddingOwner(kernel: Pick<KernelClient, 'agentRuntimeRequest'>, inference: SemanticInference, local?: { resolve(): SemanticEmbedder; close(): Promise<void> }) {
  const owned = createKnowledgeInference({ kernel, inference });
  return {
    async resolve(workspaceId: string, scopeId = workspaceId): Promise<KnowledgeEmbedderResolution> {
      try {
        const settings = await inference.readGlobalSettings() as { harness?: { embedding?: unknown } };
        const raw = settings?.harness?.embedding;
        if (raw && typeof raw === 'object' && 'enabled' in raw && raw.enabled === false) return { status: 'unconfigured' };
        const selection = parseHarnessEmbeddingSettings(settings?.harness?.embedding);
        if (selection?.protocol === 'local') {
          if (!local) return { status: 'unavailable', message: 'Local knowledge embedding component is unavailable' };
          const source = local.resolve();
          const lease = captureKnowledgeLocalLease(source, async signal => {
            signal?.throwIfAborted();
            const current = await inference.readGlobalSettings() as { harness?: { embedding?: unknown } };
            const raw = current?.harness?.embedding;
            if (raw && typeof raw === 'object' && 'enabled' in raw && raw.enabled === false) throw new Error('Local embedding selection changed');
            if (parseHarnessEmbeddingSettings(current?.harness?.embedding)?.protocol !== 'local') throw new Error('Local embedding selection changed');
            if (local.resolve() !== source) throw new Error('Local embedding component changed');
          });
          try { return { status: 'ready', embedder: await owned.resolve(scopeId, lease) }; }
          finally { lease.release(); }
        }
        const lease = await inference.capture();
        try { return { status: 'ready', embedder: await owned.resolve(scopeId, lease) }; }
        finally { lease.release(); }
      } catch (error) {
        if (error instanceof HarnessInferenceSettingsValidationError) return { status: 'invalid', message: error.message };
        if (error instanceof SemanticInferenceError) {
          return error.status === 'unconfigured' ? { status: 'unconfigured' }
            : { status: error.status === 'invalid' ? 'invalid' : 'unavailable', message: error.message };
        }
        return { status: 'unavailable', message: 'Knowledge embedding configuration is unavailable' };
      }
    },
    retireLocal: owned.retireLocal,
    close: async () => { await owned.close(); await local?.close(); },
  };
}
