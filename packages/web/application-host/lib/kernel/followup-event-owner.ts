import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '@varin/extension-contract';
import type { PluginEventSource } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { PluginEventSources } from '../extensions/event-sources.js';

export type FollowupEventOwner = (query: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The private builtin bridge derives the credential principal from the original live Run. */
export function createFollowupEventOwner(runtime: Pick<AgentRuntimeClient, 'run' | 'operation'>,
  sources: Pick<PluginEventSources, 'discover' | 'validateArrangement'>): FollowupEventOwner {
  return async (query, signal) => {
    const context = query.context;
    if (!object(context) || typeof context.run_id !== 'string' || typeof context.operation_id !== 'string') {
      throw new Error('Original follow-up invocation is unavailable');
    }
    // Read-only builtins have no durable Operation row. Rust checks the frozen
    // source query before entering this private bridge; credentials use its Run.
    if (query.kind === 'followup_event_sources') {
      signal.throwIfAborted();
      const run = await runtime.run(context.run_id, signal);
      if (run.id !== context.run_id || run.cancel_requested) throw new Error('Original follow-up Run is no longer active');
      const result = await sources.discover(run.principal_id ?? null, signal);
      signal.throwIfAborted();
      const current = await runtime.run(run.id, signal);
      if (current.cancel_requested || current.principal_id !== run.principal_id) throw new Error('Original follow-up Run changed');
      return result;
    }
    const check = async () => {
      signal.throwIfAborted();
      const [run, operation] = await Promise.all([runtime.run(context.run_id as string, signal), runtime.operation(context.operation_id as string, signal)]);
      const intent = operation.intent;
      if (run.id !== context.run_id || operation.id !== context.operation_id || operation.run_id !== run.id
        || operation.cancel_requested || run.cancel_requested
        || !['accepted', 'preparing', 'queued', 'running'].includes(operation.phase)
        || !object(intent) || !object(intent.call) || intent.call.name !== 'follow_up' || !isDeepStrictEqual(intent.origin, context.origin)
        || !object(intent.call.arguments)) throw new Error('Original follow-up invocation is no longer active');
      const args = intent.call.arguments;
      if (query.kind !== 'followup_event_source_validate' || args.action !== 'arrange'
          || !isDeepStrictEqual(args.source, query.source) || !isDeepStrictEqual(args.filter ?? {}, query.filter)) {
        throw new Error('Event source query differs from the original follow-up call');
      }
      return run.principal_id ?? null;
    };
    const principal = await check();
    if (!object(query.source) || !object(query.filter)) throw new Error('Invalid event source selection');
    await sources.validateArrangement(principal, query.source as unknown as PluginEventSource, query.filter as JsonObject, signal);
    await check(); return {};
  };
}
