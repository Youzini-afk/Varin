/** Native settings tools retain the original Catalog invocation and owning service receipt. */
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { SETTINGS_CAPABILITY } from '@varin/extension-builtins';
import type { SettingsSearchParams, SettingsReadParams, SettingsUpdateParams, SettingsActionParams } from '@varin/protocol';
import type { SettingsService, SettingsServiceCaller } from '../harness/settings-service.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';

export { SETTINGS_CAPABILITY };
export function createSettingsToolOwner(options: {
  service: SettingsService;
  runtime: Pick<AgentRuntimeClient, 'run'>;
  /** Only a local admitted source can select local project configuration. */
  localWorkspace?(authority: ToolInvocationAuthority): string | null;
}): HostCapabilityHandler {
  return (method, params, context) => {
    if (!['search', 'read', 'update', 'action'].includes(method) || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid settings invocation');
    const keys: Record<string, readonly string[]> = {
      search: ['query', 'category', 'owner', 'id', 'limit', 'offset'],
      read: ['id', 'scope', 'detail'], update: ['id', 'scope', 'set', 'reset', 'expectedRevision', 'items'],
      action: ['id', 'verb', 'args', 'operationId'],
    };
    if (Object.keys(params).some(key => !keys[method]!.includes(key))) throw new Error('Settings arguments cannot supply caller authority');
    const readOnly = method === 'search' || method === 'read';
    return runToolDomainCall(context, { operation: readOnly ? 'read' : 'effect', domain: SETTINGS_CAPABILITY,
      toolName: `settings_${method}`, arguments: params }, async authority => {
      let pendingWrites = 0;
      let changed = false;
      try {
        context.signal.throwIfAborted();
        const run = await options.runtime.run(authority.runId, context.signal);
        if (run.thread_id !== authority.threadId) throw new Error('Settings invocation Thread changed');
        const caller: SettingsServiceCaller = { threadId: run.thread_id, branchId: run.branch_id,
          runId: authority.runId, operationId: authority.operationId, invocation: authority,
          workspaceId: options.localWorkspace?.(authority) ?? null, signal: context.signal,
          onMutationState(state) {
            if (state === 'started') pendingWrites++;
            else { pendingWrites--; if (state === 'applied') changed = true; }
          } };
        const result = method === 'search' ? await options.service.search(caller, params as unknown as SettingsSearchParams)
          : method === 'read' ? await options.service.read(caller, params as unknown as SettingsReadParams)
          : method === 'update' ? await options.service.update(caller, params as unknown as SettingsUpdateParams)
          : await options.service.action(caller, params as unknown as SettingsActionParams);
        const status = 'status' in result ? result.status : 'state' in result ? result.state : 'ok';
        const failed = ['failed', 'partial', 'unavailable', 'denied', 'malformed'].includes(status);
        const effect = pendingWrites > 0 ? 'unknown' : changed ? failed ? 'partial' : 'confirmed' : 'none';
        return { executor_stopped: true, completion: { kind: 'result', outcome: pendingWrites > 0 ? 'indeterminate' : failed ? 'failed' : 'succeeded', effect,
          content: { data: parseVarinToolJson(JSON.parse(JSON.stringify(result)) as JsonValue), parts: [] } } };
      } catch (error) {
        const uncertain = pendingWrites > 0;
        return { executor_stopped: true, completion: { kind: 'result', outcome: uncertain ? 'indeterminate' : 'failed', effect: uncertain ? 'unknown' : changed ? 'partial' : 'none',
          content: { data: { error: error instanceof Error ? error.message : 'Settings owner failed' }, parts: [] } } };
      }
    });
  };
}
