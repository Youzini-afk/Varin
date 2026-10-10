/** Adapter for a lease from the sole shared MCP authority; no clients or config stores here. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  evaluateGate,
  validatePermissionMode,
  validatePermissionRule,
  type PermissionPolicy,
} from '@varin/protocol';
import type {
  McpAuthorityLease,
  McpAuthorityTool,
} from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import { permissionService } from './permission-service.js';
import type {
  HostToolCall,
  HostToolCompletion,
  McpToolLease,
  ToolExecutionReceipt,
} from './tool-bridge.js';
import type { McpBinding } from './protocol.generated.js';

export const MCP_DISCOVER = 'mcp_discover';
export const MCP_CALL = 'mcp_call';
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const noEffect = (reason: string): ToolExecutionReceipt => ({
  completion: { kind: 'not_dispatched', reason },
  executor_stopped: true,
});
const receipt = (
  completion: HostToolCompletion,
  executor_stopped: boolean,
): ToolExecutionReceipt => ({ completion, executor_stopped });
export interface McpOwnerOptions {
  lease: McpAuthorityLease;
  kernel: KernelClient;
  /** Read current Host settings at authorization and dispatch, never a renderer's policy. */
  currentPolicy(): Promise<PermissionPolicy>;
  /** An admitted workspace exists but no consistent MCP execution view has been prepared. */
  unavailableWorkspaceScope?: { workspaceId: string; reason: string };
  /** Exact visible dependency set. Retargeting changes only the execution owner/resources. */
  selection?: McpBinding;
  retarget?: boolean;
}
interface Target {
  tool: McpAuthorityTool;
  args: Record<string, unknown>;
}
type Selection =
  | { kind: 'discover'; server?: string; query: string }
  | {
      kind: 'deferred';
      server: string;
      tool: string;
      schemaVersion: string;
      args: Record<string, unknown>;
    }
  | { kind: 'direct'; target: Target };
export function createMcpLease(options: McpOwnerOptions): McpToolLease {
  const { lease } = options;
  const entries = new Map(lease.binding.tools.map((tool) => [tool.name, tool]));
  const aliases = new Map<string, string>();
  const targetName = (name: string, version: string) => aliases.get(JSON.stringify([name, version])) ?? name;
  const servers = new Map(
    lease.binding.servers
      .filter(
        (server) =>
          server.exposure !== 'hidden' && server.status !== 'disabled',
      )
      .map((server) => [server.name, server]),
  );
  const binding: McpBinding = {
    provenance: structuredClone(lease.binding.provenance),
    reference: lease.binding.reference,
    generation: lease.binding.generation,
    resources: Object.fromEntries([
      ...lease.binding.tools
        .filter((tool) => tool.exposure === 'direct')
        .map((tool) => [tool.name, tool.resourceKey]),
      ...[...servers.values()].map((server) => [
        `server:${server.name}`,
        server.resourceKey,
      ]),
    ]),
    tools: lease.binding.tools
      .filter((tool) => tool.exposure === 'direct')
      .map((tool) => ({
        name: tool.name,
        version: tool.schemaVersion,
        description: tool.description,
        output_schema: null,
        metadata: null,
        schema: structuredClone(tool.inputSchema),
      })),
  };
  if (
    servers.size ||
    lease.binding.readiness.configErrorCount > 0 ||
    options.unavailableWorkspaceScope
  )
    binding.tools.push(
      {
        name: MCP_DISCOVER,
        version: '1',
        description:
          'List configured MCP servers without connecting. Set server to prepare just that server and discover its exact tool schemas.',
        output_schema: null,
        metadata: null,
        schema: {
          type: 'object',
          properties: { server: { type: 'string' }, query: { type: 'string' } },
          additionalProperties: false,
        },
      },
      {
        name: MCP_CALL,
        version: '1',
        description:
          'Call an MCP tool using the server, tool and schemaVersion returned by mcp_discover. Arguments must match the discovered schema; normal tool permissions apply.',
        output_schema: null,
        metadata: null,
        schema: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            tool: { type: 'string' },
            schemaVersion: { type: 'string' },
            arguments: { type: 'object', additionalProperties: true },
          },
          required: ['server', 'tool', 'schemaVersion', 'arguments'],
          additionalProperties: false,
        },
      },
    );
  if (options.selection) {
    const selected = options.selection;
    if (binding.provenance.execution_scope !== selected.provenance.execution_scope || !isDeepStrictEqual(binding.provenance.configuration, selected.provenance.configuration)) throw new Error('mcp_configuration_source_changed');
    for (const [name, original] of Object.entries(selected.provenance.servers)) {
      if (binding.provenance.servers[name]?.definition_version !== original.definition_version) throw new Error('mcp_saved_definition_unavailable');
    }
    binding.provenance.servers = Object.fromEntries(Object.entries(binding.provenance.servers).filter(([name]) => name in selected.provenance.servers));
    entries.clear();
    binding.tools = selected.tools.map(original => {
      if (original.name === MCP_DISCOVER || original.name === MCP_CALL) {
        const actual = binding.tools.find(tool => tool.name === original.name);
        if (!actual || !isDeepStrictEqual(actual, original)) throw new Error('mcp_saved_schema_unavailable');
        return actual;
      }
      const server = Object.entries(selected.provenance.servers)
        .find(([, value]) => value.resource_key === selected.resources[original.name])?.[0];
      const target = lease.binding.tools.find(tool => tool.server === server && tool.schemaVersion === original.version);
      const actual = target && binding.tools.find(tool => tool.name === target.name && tool.version === target.schemaVersion);
      if (!target || !actual || !isDeepStrictEqual({ ...actual, name: original.name }, original)) throw new Error('mcp_saved_schema_unavailable');
      // Composition may disambiguate a public name across several servers. Preserve that
      // frozen name while the same original authority receives its concrete target name.
      aliases.set(JSON.stringify([original.name, original.version]), target.name);
      entries.set(original.name, { ...target, name: original.name });
      binding.resources[original.name] = target.resourceKey;
      return { ...actual, name: original.name };
    });
    binding.resources = Object.fromEntries(Object.entries(binding.resources).filter(([name]) =>
      binding.tools.some(tool => tool.name === name) || (name.startsWith('server:') && name.slice(7) in selected.provenance.servers)));
    for (const name of servers.keys()) if (!(name in selected.provenance.servers)) servers.delete(name);
    if (!options.retarget && !isDeepStrictEqual(binding, selected)) throw new Error('mcp_saved_binding_unavailable');
  }
  const approved = new Map<
    string,
    { identity: string; policy: string; target: Target }
  >();
  let released = false;
  const policy = async () => {
    const current = await options.currentPolicy();
    const value = {
      mode: validatePermissionMode(current.mode),
      rules: current.rules.map((rule) => validatePermissionRule(rule)),
    };
    return {
      value,
      generation: createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex'),
    };
  };
  const selection = (call: HostToolCall): Selection => {
    if (released || !object(call.arguments))
      throw new Error('mcp_owner_unavailable');
    const visible = binding.tools.find(
      (tool) => tool.name === call.name && tool.version === call.schemaVersion,
    );
    if (!visible) throw new Error('mcp_schema_changed');
    const args = call.arguments;
    if (call.name === MCP_DISCOVER) {
      if (
        Object.keys(args).some((key) => !['server', 'query'].includes(key)) ||
        (args.query !== undefined && typeof args.query !== 'string') ||
        (args.server !== undefined &&
          (typeof args.server !== 'string' || !servers.has(args.server)))
      )
        throw new Error('mcp_arguments_invalid');
      return {
        kind: 'discover',
        ...(typeof args.server === 'string' ? { server: args.server } : {}),
        query: String(args.query ?? ''),
      };
    }
    if (call.name === MCP_CALL) {
      if (
        Object.keys(args).some(
          (key) =>
            !['server', 'tool', 'schemaVersion', 'arguments'].includes(key),
        ) ||
        typeof args.server !== 'string' ||
        !servers.has(args.server) ||
        typeof args.tool !== 'string' ||
        !args.tool ||
        typeof args.schemaVersion !== 'string' ||
        !args.schemaVersion ||
        !object(args.arguments)
      )
        throw new Error('mcp_arguments_invalid');
      return {
        kind: 'deferred',
        server: args.server,
        tool: args.tool,
        schemaVersion: args.schemaVersion,
        args: args.arguments,
      };
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
    implementationIdentity: lease.implementationIdentity,
    available(schema) {
      if (released) return false;
      if (!binding.tools.some(tool => isDeepStrictEqual(tool, schema))) return false;
      if (schema.name === MCP_DISCOVER || schema.name === MCP_CALL) return true;
      try {
        lease.assertCallable(targetName(schema.name, schema.version), schema.version);
        return true;
      } catch {
        return false;
      }
    },
    async authorize(call, signal) {
      signal.throwIfAborted();
      const selected = selection(call);
      if (selected.kind === 'discover') return;
      const approval = approved.get(call.operationId);
      if (approval) {
        const current = await policy();
        if (
          approval.identity !== JSON.stringify(call) ||
          approval.policy !== current.generation ||
          decision(current.value, approval.target).decision === 'deny'
        )
          throw new Error('mcp_authorization_changed');
        lease.validateArguments(
          targetName(approval.target.tool.name, approval.target.tool.schemaVersion),
          approval.target.tool.schemaVersion,
          approval.target.args,
        );
        lease.assertCallable(
          targetName(approval.target.tool.name, approval.target.tool.schemaVersion),
          approval.target.tool.schemaVersion,
        );
        signal.throwIfAborted();
        return;
      }
      // Safe undispatched restart rebind: prepare only the named dependency and verify the model's
      // recorded target version. This occurs before permission and resource occupancy acquisition.
      const target =
        selected.kind === 'direct'
          ? selected.target
          : {
              tool: await lease.prepareTool(
                selected.server,
                selected.tool,
                selected.schemaVersion,
                signal,
              ),
              args: selected.args,
            };
      lease.validateArguments(
        targetName(target.tool.name, target.tool.schemaVersion),
        target.tool.schemaVersion,
        target.args,
      );
      const authorizedSignal = AbortSignal.any([
        signal,
        lease.revocationSignal(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion),
      ]);
      const current = await policy();
      const result = decision(current.value, target);
      if (result.decision === 'deny') throw new Error('mcp_permission_denied');
      if (result.decision === 'ask')
        await permissionService(options.kernel).authorize(
          call,
          {
            ownerReference: binding.reference,
            ownerGeneration: binding.generation,
            toolSchemaVersion: call.schemaVersion,
            policyGeneration: current.generation,
            reason: result.reason ?? 'MCP permission required',
          },
          authorizedSignal,
        );
      authorizedSignal.throwIfAborted();
      lease.assertCallable(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion);
      approved.set(call.operationId, {
        identity: JSON.stringify(call),
        policy: current.generation,
        target,
      });
    },
    revocationSignal(call) {
      const target = approved.get(call.operationId)?.target;
      return target
        ? lease.revocationSignal(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion)
        : new AbortController().signal;
    },
    async execute(call, signal) {
      let target: Target;
      let policyGeneration: string;
      try {
        signal.throwIfAborted();
        const selected = selection(call);
        if (selected.kind === 'discover') {
          const tools = selected.server
            ? await lease.discover(selected.server, signal)
            : lease.binding.tools;
          const query = selected.query.toLocaleLowerCase();
          const readiness = lease.inspect();
          return receipt(
            {
              kind: 'result',
              outcome: 'succeeded',
              effect: selected.server ? 'confirmed' : 'none',
              content: {
                servers: readiness.servers,
                readiness,
                ...(options.unavailableWorkspaceScope
                  ? {
                      unavailableWorkspaceScope:
                        options.unavailableWorkspaceScope,
                    }
                  : {}),
                tools: tools
                  .filter((tool) =>
                    `${tool.name} ${tool.description}`
                      .toLocaleLowerCase()
                      .includes(query),
                  )
                  .map((tool) => ({
                    server: tool.server,
                    tool: tool.tool,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    schemaVersion: tool.schemaVersion,
                  })),
              },
            },
            true,
          );
        }
        const approval = approved.get(call.operationId);
        approved.delete(call.operationId);
        const current = await policy();
        if (
          !approval ||
          approval.identity !== JSON.stringify(call) ||
          approval.policy !== current.generation ||
          decision(current.value, approval.target).decision === 'deny'
        )
          return noEffect('mcp_authorization_changed');
        target = approval.target;
        policyGeneration = approval.policy;
        signal.throwIfAborted();
        lease.validateArguments(
          targetName(target.tool.name, target.tool.schemaVersion),
          target.tool.schemaVersion,
          target.args,
        );
      } catch {
        // This receipt describes the capability-preparation operation, not tools/call. A definitive
        // preparation failure is settled; an aborted outstanding preparation remains uncertain.
        if (
          call.name === MCP_DISCOVER &&
          object(call.arguments) &&
          call.arguments.server !== undefined
        )
          return receipt(
            {
              kind: 'result',
              outcome: signal.aborted ? 'indeterminate' : 'failed',
              effect: signal.aborted ? 'unknown' : 'confirmed',
              content: { error: 'mcp_discovery_failed' },
            },
            !signal.aborted,
          );
        return noEffect('mcp_dispatch_rejected');
      }
      try {
        const result = await lease.callTool(targetName(target.tool.name, target.tool.schemaVersion), target.args, {
          schemaVersion: target.tool.schemaVersion,
          signal,
          // Reconnect/OAuth preparation can take time. Recheck at the actual tools/call boundary,
          // after that work, without reopening a permission prompt under the resource claim.
          beforeDispatch: async () => {
            signal.throwIfAborted();
            const current = await policy();
            if (
              current.generation !== policyGeneration ||
              decision(current.value, target).decision === 'deny'
            )
              throw new Error('mcp_authorization_changed');
            lease.assertCallable(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion);
          },
        });
        // An MCP isError receipt is a tool failure, not proof of rollback/no remote effects.
        return receipt(
          {
            kind: 'result',
            outcome: result.isError ? 'indeterminate' : 'succeeded',
            effect: result.isError ? 'unknown' : 'confirmed',
            content: result,
          },
          true,
        );
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'dispatched' in error &&
          error.dispatched === false
        )
          return noEffect('mcp_not_dispatched');
        return receipt(
          {
            kind: 'result',
            outcome: 'indeterminate',
            effect: 'unknown',
            content: { error: 'mcp_effect_unknown' },
          },
          false,
        );
      }
    },
    release() {
      if (!released) {
        released = true;
        approved.clear();
        lease.release();
      }
    },
  };
}
