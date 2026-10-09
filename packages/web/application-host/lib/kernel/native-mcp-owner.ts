/** Native adapter for a lease from the sole shared MCP authority; no clients or config stores here. */
import { createHash } from 'node:crypto';
import { evaluateGate, validatePermissionMode, validatePermissionRule, type PermissionPolicy } from '@varin/protocol';
import type { McpAuthorityLease, McpAuthorityTool } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import { nativePermissionService } from './native-permission-service.js';
import type { NativeMcpBinding, NativeMcpCall, NativeMcpCompletion, NativeMcpLease } from './native-mcp-bridge.js';

export const MCP_DISCOVER = 'mcp_discover';
export const MCP_CALL = 'mcp_call';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const noEffect = (reason: string): NativeMcpCompletion => ({ kind: 'not_dispatched', reason });
export interface NativeMcpOwnerOptions {
  lease: McpAuthorityLease;
  kernel: KernelClient;
  /** Read current Host settings at authorization and dispatch, never a renderer's policy. */
  currentPolicy(): Promise<PermissionPolicy>;
  /** An admitted workspace exists but no consistent MCP execution view has been prepared. */
  unavailableWorkspaceScope?: { workspaceId: string; reason: string };
}
interface Target { tool: McpAuthorityTool; args: Record<string, unknown> }
type Selection = { kind: 'discover'; server?: string; query: string }
  | { kind: 'deferred'; server: string; tool: string; schemaVersion: string; args: Record<string, unknown> }
  | { kind: 'direct'; target: Target };
export function createNativeMcpLease(options: NativeMcpOwnerOptions): NativeMcpLease {
  const { lease } = options;
  const entries = new Map(lease.binding.tools.map(tool => [tool.name, tool]));
  const servers = new Map(lease.binding.servers.filter(server => server.exposure !== 'hidden' && server.status !== 'disabled').map(server => [server.name, server]));
  const binding: NativeMcpBinding = {
    reference: lease.binding.reference, generation: lease.binding.generation,
    resources: Object.fromEntries([
      ...lease.binding.tools.filter(tool => tool.exposure === 'direct').map(tool => [tool.name, tool.resourceKey]),
      ...[...servers.values()].map(server => [`server:${server.name}`, server.resourceKey]),
    ]),
    tools: lease.binding.tools.filter(tool => tool.exposure === 'direct').map(tool => ({ name: tool.name,
      version: tool.schemaVersion, schema: { ...structuredClone(tool.inputSchema), description: tool.description } })),
  };
  if (servers.size || lease.binding.readiness.configErrorCount > 0 || options.unavailableWorkspaceScope) binding.tools.push(
    { name: MCP_DISCOVER, version: '1', schema: { type: 'object', description: 'List configured MCP servers without connecting. Set server to prepare just that server and discover its exact tool schemas.', properties: { server: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false } },
    { name: MCP_CALL, version: '1', schema: { type: 'object', description: 'Call an MCP tool using the server, tool and schemaVersion returned by mcp_discover. Arguments must match the discovered schema; normal tool permissions apply.', properties: { server: { type: 'string' }, tool: { type: 'string' }, schemaVersion: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['server', 'tool', 'schemaVersion', 'arguments'], additionalProperties: false } },
  );
  const approved = new Map<string, { identity: string; policy: string; target: Target }>();
  let released = false;
  const policy = async () => {
    const current = await options.currentPolicy();
    const value = { mode: validatePermissionMode(current.mode), rules: current.rules.map(rule => validatePermissionRule(rule)) };
    return { value, generation: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  };
  const selection = (call: NativeMcpCall): Selection => {
    if (released || !object(call.arguments)) throw new Error('mcp_owner_unavailable');
    const visible = binding.tools.find(tool => tool.name === call.name && tool.version === call.schemaVersion);
    if (!visible) throw new Error('mcp_schema_changed');
    const args = call.arguments;
    if (call.name === MCP_DISCOVER) {
      if (Object.keys(args).some(key => !['server', 'query'].includes(key))
        || (args.query !== undefined && typeof args.query !== 'string')
        || (args.server !== undefined && (typeof args.server !== 'string' || !servers.has(args.server)))) throw new Error('mcp_arguments_invalid');
      return { kind: 'discover', ...(typeof args.server === 'string' ? { server: args.server } : {}), query: String(args.query ?? '') };
    }
    if (call.name === MCP_CALL) {
      if (Object.keys(args).some(key => !['server', 'tool', 'schemaVersion', 'arguments'].includes(key))
        || typeof args.server !== 'string' || !servers.has(args.server) || typeof args.tool !== 'string' || !args.tool
        || typeof args.schemaVersion !== 'string' || !args.schemaVersion || !object(args.arguments)) throw new Error('mcp_arguments_invalid');
      return { kind: 'deferred', server: args.server, tool: args.tool, schemaVersion: args.schemaVersion, args: args.arguments };
    }
    const tool = entries.get(call.name);
    if (!tool) throw new Error('mcp_tool_unavailable');
    return { kind: 'direct', target: { tool, args } };
  };
  const decision = (current: PermissionPolicy, selected: Target) =>
    // Explicit Host rules remain authoritative. Unknown tools default to ask; annotations never
    // grant read-only status, Smart eligibility, or reusable approvals.
    evaluateGate(selected.tool.name, selected.args, current);
  return {
    binding,
    async authorize(call, signal) {
      signal.throwIfAborted();
      const selected = selection(call);
      if (selected.kind === 'discover') return;
      // Safe undispatched restart rebind: prepare only the named dependency and verify the model's
      // recorded target version. This occurs before permission and resource occupancy acquisition.
      const target = selected.kind === 'direct' ? selected.target : {
        tool: await lease.prepareTool(selected.server, selected.tool, selected.schemaVersion, signal), args: selected.args,
      };
      lease.validateArguments(target.tool.name, target.tool.schemaVersion, target.args);
      const current = await policy();
      const result = decision(current.value, target);
      if (result.decision === 'deny') throw new Error('mcp_permission_denied');
      if (result.decision === 'ask') await nativePermissionService(options.kernel).authorize(call, {
        ownerReference: binding.reference, ownerGeneration: binding.generation,
        toolSchemaVersion: call.schemaVersion, policyGeneration: current.generation,
        reason: result.reason ?? 'MCP permission required',
      }, signal);
      signal.throwIfAborted();
      lease.assertCallable(target.tool.name, target.tool.schemaVersion);
      approved.set(call.operationId, { identity: JSON.stringify(call), policy: current.generation, target });
    },
    async execute(call, signal) {
      let target: Target;
      let policyGeneration: string;
      try {
        signal.throwIfAborted();
        const selected = selection(call);
        if (selected.kind === 'discover') {
          const tools = selected.server ? await lease.discover(selected.server, signal) : lease.binding.tools;
          const query = selected.query.toLocaleLowerCase();
          const readiness = lease.inspect();
          return { kind: 'result', outcome: 'succeeded', effect: selected.server ? 'confirmed' : 'none', content: {
            servers: readiness.servers, readiness,
            ...(options.unavailableWorkspaceScope ? { unavailableWorkspaceScope: options.unavailableWorkspaceScope } : {}),
            tools: tools.filter(tool => `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(query))
              .map(tool => ({ server: tool.server, tool: tool.tool, name: tool.name, description: tool.description, inputSchema: tool.inputSchema, schemaVersion: tool.schemaVersion })),
          } };
        }
        const approval = approved.get(call.operationId);
        approved.delete(call.operationId);
        const current = await policy();
        if (!approval || approval.identity !== JSON.stringify(call) || approval.policy !== current.generation
          || decision(current.value, approval.target).decision === 'deny') return noEffect('mcp_authorization_changed');
        target = approval.target;
        policyGeneration = approval.policy;
        signal.throwIfAborted();
        lease.validateArguments(target.tool.name, target.tool.schemaVersion, target.args);
      } catch (error) {
        // This receipt describes the capability-preparation operation, not tools/call. A definitive
        // preparation failure is settled; an aborted outstanding preparation remains uncertain.
        if (call.name === MCP_DISCOVER && call.arguments.server !== undefined) return { kind: 'result', outcome: signal.aborted ? 'indeterminate' : 'failed', effect: signal.aborted ? 'unknown' : 'confirmed', content: { error: 'mcp_discovery_failed' } };
        return noEffect('mcp_dispatch_rejected');
      }
      try {
        const result = await lease.callTool(target.tool.name, target.args, {
          schemaVersion: target.tool.schemaVersion, signal,
          // Reconnect/OAuth preparation can take time. Recheck at the actual tools/call boundary,
          // after that work, without reopening a permission prompt under the resource claim.
          beforeDispatch: async () => {
            signal.throwIfAborted();
            const current = await policy();
            if (current.generation !== policyGeneration || decision(current.value, target).decision === 'deny') throw new Error('mcp_authorization_changed');
            lease.assertCallable(target.tool.name, target.tool.schemaVersion);
          },
        });
        // An MCP isError receipt is a tool failure, not proof of rollback/no remote effects.
        return { kind: 'result', outcome: result.isError ? 'failed' : 'succeeded', effect: result.isError ? 'unknown' : 'confirmed', content: result };
      } catch (error) {
        if (error && typeof error === 'object' && 'dispatched' in error && error.dispatched === false) return noEffect('mcp_not_dispatched');
        return { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: { error: 'mcp_effect_unknown' } };
      }
    },
    release() { if (!released) { released = true; approved.clear(); lease.release(); } },
  };
}
