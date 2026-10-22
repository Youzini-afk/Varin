import { createKnowledgeInference } from './inference.js';
import type { KnowledgeEmbedderResolution } from './runtime.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import { SemanticInferenceError, type SemanticInference } from '../semantic/runtime-inference.js';

/** Knowledge embeddings have no workspace inventory, code index or language-service owner. */
export function createKnowledgeEmbeddingOwner(kernel: Pick<KernelClient, 'agentRuntimeRequest'>, inference: SemanticInference) {
  const owned = createKnowledgeInference({ kernel, inference });
  return {
    async resolve(workspaceId: string, scopeId = workspaceId): Promise<KnowledgeEmbedderResolution> {
      try {
        const lease = await inference.capture();
        try { return { status: 'ready', embedder: await owned.resolve(scopeId, lease) }; }
        finally { lease.release(); }
      } catch (error) {
        if (error instanceof SemanticInferenceError) {
          return error.status === 'unconfigured' ? { status: 'unconfigured' }
            : { status: error.status === 'invalid' ? 'invalid' : 'unavailable', message: error.message };
        }
        return { status: 'unavailable', message: 'Knowledge embedding configuration is unavailable' };
      }
    },
    close: () => owned.close(),
  };
}
