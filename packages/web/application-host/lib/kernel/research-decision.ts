/** Ordinary installed research_decide, using original material and inference owners. */
import { isDeepStrictEqual } from 'node:util';
import { RESEARCH_DECISION_CAPABILITY, RESEARCH_DECISION_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { compileToolJsonSchema } from '../models/schema.js';
import type { PiSettingsSnapshot, ResearchDecideParams } from '@varin/protocol';
import { executeResearchDecide } from '../harness/research-decide.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { SemanticInference } from '../knowledge/semantic/runtime-inference.js';
import type { DecisionInferenceLease } from '../knowledge/semantic/decision-inference.js';
import type { ExtensionToolConfiguration, ExtensionToolRun } from './extension-tool-owner.js';
import type { ExtensionToolBinding, LaunchSource } from './protocol.generated.js';
import { runToolDomainCall } from './tool-invocation.js';
import type { createWebRuntime } from './web-runtime.js';
export { RESEARCH_DECISION_CAPABILITY };
const declaration = RESEARCH_DECISION_TOOL_DECLARATIONS[0]!;
const validate = compileToolJsonSchema(declaration.tool!.inputSchema);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function enabled(snapshot: PiSettingsSnapshot): boolean {
  const global = object(snapshot.global.harness) ? snapshot.global.harness : {};
  const project = snapshot.projectTrusted && object(snapshot.project.harness) ? snapshot.project.harness : {};
  const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
  const value = tools[declaration.tool!.name];
  if (value !== undefined && typeof value !== 'boolean') throw new Error('Research decision tool setting must be boolean');
  return value !== false;
}
function restored(identity: string | null | undefined): boolean {
  let value: unknown;
  try { value = identity ? JSON.parse(identity) : null; } catch { value = null; }
  if (typeof value !== 'boolean') throw new Error('Original research decision configuration is unavailable; prepare a new execution');
  return value;
}
export function createResearchDecisionRuntime(options: {
  inference: Pick<SemanticInference, 'captureDecision'>;
  materials: Pick<ReturnType<typeof createWebRuntime>, 'decisionMaterials'>;
  settings(source: LaunchSource | null): Promise<PiSettingsSnapshot>;
}) {
  const capability: HostCapabilityHandler = async (method, value, call) => {
    if (method !== 'decide' || !validate(value)) throw new HarnessServiceError('invalid-params', 'Provide a research goal, judgment kind and real candidates');
    const input = parseVarinToolJson(value);
    return runToolDomainCall(call, { domain: RESEARCH_DECISION_CAPABILITY, toolName: declaration.tool!.name,
      operation: declaration.tool!.operation, arguments: input }, async invocation => {
      let lease: DecisionInferenceLease | undefined;
      try {
        if (!restored(invocation.configurationIdentity)) throw new HarnessServiceError('forbidden', 'Research decisions are disabled in the accepted settings');
        const materials = await options.materials.decisionMaterials(invocation, call.signal);
        const result = await executeResearchDecide(input as unknown as ResearchDecideParams, {
          signal: call.signal, authority: materials.authority, readCandidateText: materials.readCandidateText,
          fastDecisionStatus: async purpose => {
            const selected = await options.inference.captureDecision(purpose);
            if (selected.status !== 'ready') return selected;
            lease = selected.lease;
            return { status: 'ready', binding: lease.binding };
          },
          fastDecision: async request => {
            if (!lease || !isDeepStrictEqual(lease.binding, request.settings)) throw new Error('Original decision binding changed');
            const retained = lease;
            return retained.run(invocation, request.signal, session => session.decide({ purpose: request.purpose, goal: request.goal, materials: request.materials,
              questions: request.questions, ...(retained.binding.endpoint ? { endpoint: retained.binding.endpoint } : {}) }, materials.assertReadable));
          },
        });
        return { executor_stopped: true, completion: { kind: 'result', effect: 'none',
          outcome: result.status === 'cancelled' ? 'cancelled' : result.status === 'ok' ? 'succeeded' : 'failed',
          content: { data: parseVarinToolJson(result), parts: [] } } };
      } catch (error) {
        return { executor_stopped: true, completion: { kind: 'result', effect: 'none', outcome: call.signal.aborted ? 'cancelled' : 'failed',
          content: { data: { status: call.signal.aborted ? 'cancelled' : 'failed', message: error instanceof HarnessServiceError ? error.message
            : 'Research decision could not finish. Check the original material access and inference receipt.' }, parts: [] } } };
      } finally { lease?.release(); }
    });
  };
  const prepareConfiguration = async (run: ExtensionToolRun, required: readonly ExtensionToolBinding[], previous?: ExtensionToolConfiguration): Promise<ExtensionToolConfiguration> => {
    const captured = required.length ? null : await options.settings(run.source).then(enabled).then(value => ({ value }), error => ({ error }));
    return (descriptor, original) => {
      if (descriptor.id !== declaration.id || descriptor.version !== declaration.version) return previous?.(descriptor, original) ?? original ?? null;
      if (original !== undefined) { restored(original); return original; }
      if (!captured) throw new Error('Original research decision configuration was not retained');
      if ('error' in captured) throw captured.error;
      return JSON.stringify(captured.value);
    };
  };
  return { capability, prepareConfiguration };
}
