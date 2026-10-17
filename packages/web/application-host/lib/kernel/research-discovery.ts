import type { AgentSettingsSnapshot } from '@varin/application-client';
/** Ordinary native tool calls into the original scholarly metadata owner. */
import { RESEARCH_DISCOVERY_CAPABILITY, RESEARCH_DISCOVERY_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { compileToolJsonSchema } from '../models/schema.js';
import type { ScholarlySearchParams } from '@varin/protocol';
import type { ScholarlySearchService } from '../harness/research-search.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ExtensionToolConfiguration, ExtensionToolRun } from './extension-tool-owner.js';
import { extendToolConfiguration } from './extension-tool-owner.js';
import type { ExtensionToolBinding, LaunchSource } from './protocol.generated.js';
import { runToolDomainCall } from './tool-invocation.js';

export { RESEARCH_DISCOVERY_CAPABILITY };
const declarations = new Map(RESEARCH_DISCOVERY_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.research.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
interface ResearchDiscoveryConfiguration { version: 1; enabled: boolean }
function capture(snapshot: AgentSettingsSnapshot): ResearchDiscoveryConfiguration {
  const global = object(snapshot.global.harness) ? snapshot.global.harness : {};
  const project = snapshot.projectTrusted && object(snapshot.project.harness) ? snapshot.project.harness : {};
  const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
  const enabled = tools.research_search;
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Scholarly search tool setting must be boolean');
  return { version: 1, enabled: enabled !== false };
}
function configuration(identity: string | null | undefined): ResearchDiscoveryConfiguration {
  let value: unknown;
  try { value = identity ? JSON.parse(identity) : null; } catch { value = null; }
  if (!object(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || Object.keys(value).some(key => key !== 'version' && key !== 'enabled')) {
    throw new Error('The original scholarly search configuration is unavailable; prepare a new execution');
  }
  return { version: 1, enabled: value.enabled };
}
export interface ResearchDiscoveryRuntimeOptions {
  service: ScholarlySearchService;
  /** Original user and trusted-project settings, without a Pi session or Web provider dependency. */
  settings(source: LaunchSource | null): Promise<AgentSettingsSnapshot>;
}
export function createResearchDiscoveryRuntime(options: ResearchDiscoveryRuntimeOptions) {
  const capability: HostCapabilityHandler = async (method, value, call) => {
    const selected = declarations.get(method);
    if (!selected || !selected.validate(value)) throw new HarnessServiceError('invalid-params', 'Arguments do not match scholarly search; select search, paper or relations and its required fields');
    const input = parseVarinToolJson(value);
    return runToolDomainCall(call, { domain: RESEARCH_DISCOVERY_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: input }, async invocation => {
      try {
        if (!configuration(invocation.configurationIdentity).enabled) throw new HarnessServiceError('forbidden', 'Scholarly search is disabled in the accepted settings');
        const result = await options.service.handle(input as unknown as ScholarlySearchParams, { signal: call.signal });
        return { executor_stopped: true, completion: { kind: 'result', effect: 'none',
          outcome: call.signal.aborted ? 'cancelled' : result.status === 'failed' || result.status === 'unavailable' ? 'failed' : 'succeeded',
          content: { data: parseVarinToolJson(result), parts: [] } } };
      } catch (error) {
        // The original owner settles only after its fetch and body reader drain.
        return { executor_stopped: true, completion: { kind: 'result', outcome: call.signal.aborted ? 'cancelled' : 'failed', effect: 'none',
          content: { data: { status: call.signal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error),
            ...(error instanceof HarnessServiceError ? { code: error.harnessCode } : {}) }, parts: [] } } };
      }
    });
  };
  const prepareConfiguration = async (run: ExtensionToolRun, required: readonly ExtensionToolBinding[], previous?: ExtensionToolConfiguration): Promise<ExtensionToolConfiguration> => {
    const captured = required.length ? null : await options.settings(run.source).then(capture).then(
      value => ({ value }), error => ({ error }),
    );
    return extendToolConfiguration(previous, (descriptor, original) => {
      if (!RESEARCH_DISCOVERY_TOOL_DECLARATIONS.some(value => value.id === descriptor.id && value.version === descriptor.version)) return previous?.(descriptor, original) ?? original ?? null;
      if (original !== undefined) { configuration(original); return original; }
      if (!captured) throw new Error('The original scholarly search configuration was not retained');
      if ('error' in captured) throw captured.error;
      return JSON.stringify(captured.value);
    }, descriptor => RESEARCH_DISCOVERY_TOOL_DECLARATIONS.some(value => value.id === descriptor.id && value.version === descriptor.version)
      && captured && 'value' in captured ? captured.value.enabled : undefined);
  };
  return { capability, prepareConfiguration };
}
