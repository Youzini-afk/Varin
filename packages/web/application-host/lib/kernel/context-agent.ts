/** Prepare one context Agent choice. ContextJob freezes it at admission and owns recovery. */
import { mergeHarnessSettings, type HarnessSettingsInput } from '@varin/protocol';
import type { ThreadModel } from '@varin/application-client';
import type { AgentSettingsService } from '../models/settings.js';
import type { ThreadModelAuthority } from './thread-adapter.js';
import type { ContextCompactionScope } from './context-compaction.js';
import type { CredentialScope, ModelSessionConfiguration } from './protocol.generated.js';
import { waitForModelBinding } from './model-binding-lifetime.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';

export type ContextAgentFallback = { model: ThreadModel } | {
  configuration: ModelSessionConfiguration; credentialScope?: CredentialScope;
};
export interface PreparedContextAgent {
  instructions?: string;
  configuration: unknown;
  credentialScope?: CredentialScope;
  bind?: () => Promise<{ configuration: ModelSessionConfiguration; credentialScope: CredentialScope }>;
  readonly credentialOwner?: ExistingHostCredentialOwner | undefined;
  release(): void;
}
export interface ContextAgentOwner {
  prepare(scope: ContextCompactionScope, fallback: ContextAgentFallback, signal: AbortSignal): Promise<PreparedContextAgent>;
}
export function createContextAgent(owners: { settings: Pick<AgentSettingsService, 'snapshot'>; models: ThreadModelAuthority }): ContextAgentOwner {
  return {
    async prepare(scope, fallback, signal) {
      const snapshot = await owners.settings.snapshot(scope.workspaceId);
      signal.throwIfAborted();
      const harness = mergeHarnessSettings((snapshot.global.harness ?? {}) as HarnessSettingsInput,
        (snapshot.projectTrusted ? snapshot.project.harness ?? {} : {}) as HarnessSettingsInput);
      const binding = harness.models.contextCompaction;
      const instructions = binding?.agent?.instructions;
      const settings = binding?.agent?.modelSettings;
      const inherited = 'configuration' in fallback ? fallback : undefined;
      const selected = binding?.providerId && binding.modelId ? { providerId: binding.providerId, modelId: binding.modelId } : undefined;
      // The ordinary path reuses the triggering Run's exact binding, without loading credentials again.
      if (inherited && !selected && settings?.temperature === undefined && settings?.thinkingLevel === undefined) {
        return { ...(instructions !== undefined ? { instructions } : {}), ...inherited, release() {} };
      }
      const thinking = inherited?.configuration.thinkingLevel as ThreadModel['thinkingLevel'];
      const temperature = (inherited?.configuration.modelOptions as { temperature?: number } | undefined)?.temperature;
      const base: ThreadModel = 'model' in fallback ? fallback.model : {
        providerId: fallback.configuration.providerId!, modelId: fallback.configuration.catalogModelId ?? fallback.configuration.model,
        ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
      };
      const selection: ThreadModel = { ...(selected ?? base), ...settings };
      if (!owners.models.describeModel) throw new Error('Model capacity description is unavailable');
      const description = await owners.models.describeModel(selection);
      signal.throwIfAborted();
      let model: Awaited<ReturnType<ThreadModelAuthority['resolveModel']>> | undefined;
      return {
        ...(instructions !== undefined ? { instructions } : {}), configuration: description,
        get credentialOwner() { return model?.credentialOwner; },
        async bind() {
          model = await waitForModelBinding(owners.models.resolveModel(selection,
            inherited?.credentialScope && !selected ? { configuration: inherited.configuration, credentialScope: inherited.credentialScope } : undefined),
          model => model.credentialOwner.release(), signal);
          if ((model.configuration.contextWindowTokens ?? null) !== description.contextWindowTokens
            || (model.configuration.maxOutputTokens ?? null) !== description.maxOutputTokens) throw new Error('Model capacity changed during compaction preparation');
          return { configuration: model.configuration, credentialScope: await model.credentialOwner.scope() };
        },
        release() { model?.credentialOwner.release(); model = undefined; },
      };
    },
  };
}
