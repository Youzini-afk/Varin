/** Native code retrieval's selected model stage. The existing user settings choose its duty. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { parseHarnessModelSlots, resolveHarnessModelSlot, parseHarnessRerankSettings, resolveHarnessCodeRetrievalSettings,
  type HarnessExploreDecisionMode } from '@varin/protocol';
import type { SemanticInference } from '../knowledge/semantic/runtime-inference.js';
import type { RetrievalModelLease } from './retrieval-composition.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { toolOperationId, type RetrievalQuery, type ToolOrigin } from './protocol.generated.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function origin(query: RetrievalQuery): ToolOrigin {
  const value = query.invocation;
  return value.kind === 'model_step' ? { kind: 'model_step', request_id: value.requestId }
    : value.kind === 'policy_action' ? { kind: 'policy_action', action_id: value.actionId, node_id: value.nodeId }
      : { kind: 'nested_call', parent_operation_id: value.parentOperationId };
}
export function createRetrievalModelStage(options: {
  inference: Pick<SemanticInference, 'captureRerank' | 'captureDecision'>;
  readGlobalSettings(): Promise<unknown>;
  kernel: Pick<KernelClient, 'retrievalGrant' | 'scoped'>;
  validateSource: LiveSourceResolver;
}) {
  return { async prepare(query: RetrievalQuery, signal: AbortSignal): Promise<RetrievalModelLease> {
    let released = false;
    let mode: HarnessExploreDecisionMode;
    let harness: Record<string, unknown>;
    const assertAvailable = () => { signal.throwIfAborted(); if (released) throw new Error('Retrieval model binding was released'); options.kernel.retrievalGrant(query); };
    const validateAvailable = async (active: AbortSignal = signal) => {
      active.throwIfAborted(); assertAvailable(); await options.validateSource(query, active); assertAvailable();
    };
    const unavailable = (providerId: string, status: 'disabled' | 'unavailable' | 'unsupported', configuration: unknown): RetrievalModelLease => ({
      stage: { providerId, status, configurationId: identity(configuration) }, assertAvailable, validateAvailable,
      release() { released = true; },
    });
    try {
      const document = await options.readGlobalSettings();
      if (!object(document) || document.harness !== undefined && !object(document.harness)) throw new Error('Invalid settings');
      harness = object(document.harness) ? document.harness : {};
      mode = resolveHarnessCodeRetrievalSettings(harness.codeRetrieval).decision;
    } catch { return unavailable('settings', 'unavailable', ['invalid']); }
    if (mode === 'source') return unavailable('none', 'disabled', [mode]);
    if (mode === 'llm' || mode === 'fast-decision') return unavailable(mode, 'unsupported', [mode]);
    if (mode === 'auto') {
      // The original Explore slot has precedence over classifier and rerank. Resolve only
      // this role so unrelated malformed model candidates cannot select or block this duty.
      try {
        if (harness.models !== undefined && !object(harness.models)) throw new Error('Invalid Explore model settings');
        const raw = object(harness.models) ? harness.models.explore : undefined;
        const explore = resolveHarnessModelSlot('explore', parseHarnessModelSlots(raw === undefined ? undefined : { explore: raw }), null);
        if (explore) return unavailable(explore.providerId, 'unsupported', [mode, 'explore', explore]);
      } catch { return unavailable('llm', 'unavailable', [mode, 'invalid-explore-slot']); }
      // Preserve the original selection precedence. An unimplemented selected decision
      // consumer is not permission to silently send the same candidates to another model.
      const decision = await options.inference.captureDecision('explore');
      if (decision.status === 'ready') {
        decision.lease.release();
        return unavailable('fast-decision', 'unsupported', [mode, decision.lease.binding]);
      }
    }
    let configured;
    try { configured = parseHarnessRerankSettings(harness.rerank); }
    catch { return unavailable('rerank', 'unavailable', [mode, 'invalid']); }
    if (!configured) return unavailable('rerank', mode === 'auto' ? 'disabled' : 'unavailable', [mode, 'unconfigured']);

    const selected = await options.inference.captureRerank(configured);
    if (selected.status !== 'ready') return unavailable(configured.providerId, selected.status === 'unconfigured' && mode === 'auto' ? 'disabled' : 'unavailable', [mode, configured, selected.status]);
    const lease = selected.lease;
    try {
      assertAvailable();
      const verified = await options.readGlobalSettings();
      const current = object(verified) && object(verified.harness) ? verified.harness : {};
      if (!isDeepStrictEqual(current.codeRetrieval, harness.codeRetrieval)
        || mode === 'auto' && (!isDeepStrictEqual(current.fastDecision, harness.fastDecision)
          || !isDeepStrictEqual(object(current.models) ? current.models.explore : current.models,
            object(harness.models) ? harness.models.explore : harness.models))) {
        throw new Error('Retrieval model selection changed during preparation');
      }
      const invocation = { operationId: toolOperationId(origin(query), query.invocation.toolCallId), executorOwner: query.inferenceOwner };
      if (invocation.executorOwner.kind !== 'external') throw new Error('Original inference delegation is unavailable');
      const validate = async (active: AbortSignal = signal) => { await validateAvailable(active); await lease.assertAvailable(active); };
      await validate(signal);
      return {
        stage: { providerId: lease.binding.providerId, configurationId: identity([mode, lease.binding]), status: 'ready',
          implementation: async (input, active) => {
            await validate(active);
            // Keep exact spans and revisions. The inherited user budget uses the original
            // character estimate; it is a selection budget, not provider usage accounting.
            const eligible = input.snippets.map((snippet, index) => ({ id: String(index), text: snippet.content, revision: snippet.revision }))
              .filter(document => lease.binding.maxDocumentTokens === undefined || Math.max(1, document.text.length) <= lease.binding.maxDocumentTokens);
            const original = input.snippets.map((_, index) => index);
            if (!eligible.length) return { indices: original, status: 'partial' };
            const guard = async () => {
              await validate(active);
              const client = options.kernel.scoped(options.kernel.retrievalGrant(query));
              for (const path of new Set(input.snippets.map(item => item.path))) {
                await client.fileReadCheck({ workspaceId: query.workspaceId, rootId: query.liveRoot.rootId, path }, active);
              }
              await validate(active);
            };
            const result = await lease.execute(invocation, { query: input.question, documents: eligible,
              provenance: { source: { mode: 'live_root', workspaceId: query.workspaceId,
                executionWorkspaceId: query.executionWorkspaceId, liveRoot: query.liveRoot },
              candidates: eligible.map(document => {
                const snippet = input.snippets[Number(document.id)]!;
                return { id: document.id, path: snippet.path, revision: snippet.revision, startLine: snippet.startLine, endLine: snippet.endLine };
              }) } }, active, guard);
            const ordered = [...result.scores].sort((a, b) => b.score - a.score || a.index - b.index).map(row => Number(row.id));
            const ranked = new Set(ordered);
            return { indices: [...ordered, ...original.filter(index => !ranked.has(index))],
              status: ranked.size === original.length ? 'ready' : 'partial' };
          } },
        assertAvailable, validateAvailable: validate,
        release() { if (released) return; released = true; lease.release(); },
      };
    } catch (error) { lease.release(); throw error; }
  } };
}
