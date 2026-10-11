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
  McpAuthorityService,
  McpServiceRequest,
} from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import { permissionService } from './permission-service.js';
import type {
  HostToolCall,
  HostToolCompletion,
  McpToolLease,
  ToolExecutionReceipt,
} from './tool-bridge.js';
import { MCP_CAPABILITIES, type McpBinding, type McpBuiltinOperation } from './protocol.generated.js';
import { compileToolJsonSchema } from '@varin/pi-host/tool-schema';
import { projectMcpOutput } from './mcp-output.js';
import { McpAuthorityError } from '@varin/pi-host/mcp-authority';
import { HostToolAdmissionError } from './tool-admission.js';

const builtins = new Map(MCP_CAPABILITIES.map(value => [value.name, { ...value, validate: compileToolJsonSchema(value.schema) }]));
export const MCP_DISCOVER = MCP_CAPABILITIES.find(value => value.operation === 'discover')!.name;
export const MCP_CALL = MCP_CAPABILITIES.find(value => value.operation === 'call')!.name;
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
type Target = { kind: 'tool'; tool: McpAuthorityTool; args: Record<string, unknown> }
  | { kind: 'service'; service: McpAuthorityService; request: McpServiceRequest; permissionName: string; args: Record<string, unknown> };
type Selection =
  | { kind: 'discover'; server?: string; query: string }
  | {
      kind: 'deferred';
      server: string;
      tool: string;
      schemaVersion: string;
      args: Record<string, unknown>;
    }
  | { kind: 'service'; operation: Exclude<McpBuiltinOperation, 'discover' | 'call'>; args: Record<string, unknown> }
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
    routes: Object.fromEntries(lease.binding.tools.filter(tool => tool.exposure === 'direct').map(tool => [tool.name, { kind: 'direct' as const }])),
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
    for (const {route, operation: _operation, ...schema} of MCP_CAPABILITIES) {
      binding.tools.push(structuredClone(schema));
      binding.routes[schema.name] = structuredClone(route);
    }
  if (options.selection) {
    const selected = options.selection;
    if (binding.provenance.execution_scope !== selected.provenance.execution_scope || !isDeepStrictEqual(binding.provenance.configuration, selected.provenance.configuration)) throw new HostToolAdmissionError('mcp_configuration_source_changed');
    for (const [name, original] of Object.entries(selected.provenance.servers)) {
      if (binding.provenance.servers[name]?.definition_version !== original.definition_version) throw new HostToolAdmissionError('mcp_saved_definition_unavailable');
    }
    binding.provenance.servers = Object.fromEntries(Object.entries(binding.provenance.servers).filter(([name]) => name in selected.provenance.servers));
    entries.clear();
    binding.tools = selected.tools.map(original => {
      if (builtins.has(original.name)) {
        const actual = binding.tools.find(tool => tool.name === original.name);
        if (!actual || !isDeepStrictEqual(actual, original)) throw new HostToolAdmissionError('mcp_saved_schema_unavailable');
        return actual;
      }
      const server = Object.entries(selected.provenance.servers)
        .find(([, value]) => value.resource_key === selected.resources[original.name])?.[0];
      const target = lease.binding.tools.find(tool => tool.server === server && tool.schemaVersion === original.version);
      const actual = target && binding.tools.find(tool => tool.name === target.name && tool.version === target.schemaVersion);
      if (!target || !actual || !isDeepStrictEqual({ ...actual, name: original.name }, original)) throw new HostToolAdmissionError('mcp_saved_schema_unavailable');
      // Composition may disambiguate a public name across several servers. Preserve that
      // frozen name while the same original authority receives its concrete target name.
      aliases.set(JSON.stringify([original.name, original.version]), target.name);
      entries.set(original.name, { ...target, name: original.name });
      binding.resources[original.name] = target.resourceKey;
      binding.routes[original.name] = { kind: 'direct' };
      return { ...actual, name: original.name };
    });
    binding.routes = Object.fromEntries(Object.entries(binding.routes).filter(([name]) => binding.tools.some(tool => tool.name === name)));
    if (!isDeepStrictEqual(binding.routes, selected.routes)) throw new HostToolAdmissionError('mcp_saved_routes_unavailable');
    binding.resources = Object.fromEntries(Object.entries(binding.resources).filter(([name]) =>
      binding.tools.some(tool => tool.name === name) || (name.startsWith('server:') && name.slice(7) in selected.provenance.servers)));
    for (const name of servers.keys()) if (!(name in selected.provenance.servers)) servers.delete(name);
    if (!options.retarget && !isDeepStrictEqual(binding, selected)) throw new HostToolAdmissionError('mcp_saved_binding_unavailable');
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
      throw new HostToolAdmissionError('mcp_owner_unavailable');
    const visible = binding.tools.find(
      (tool) => tool.name === call.name && tool.version === call.schemaVersion,
    );
    if (!visible) throw new HostToolAdmissionError('mcp_schema_changed');
    const args = call.arguments;
    const builtin = builtins.get(call.name);
    if (builtin) {
      if (!builtin.validate(args) || (args.server !== undefined && !servers.has(String(args.server)))) throw new HostToolAdmissionError('mcp_arguments_invalid');
      if (builtin.operation === 'discover') return { kind: 'discover', ...(typeof args.server === 'string' ? {server:args.server} : {}), query: String(args.query ?? '') };
      if (builtin.operation === 'call') return { kind: 'deferred', server: args.server as string, tool: args.tool as string,
        schemaVersion: args.schemaVersion as string, args: args.arguments as Record<string, unknown> };
      return { kind: 'service', operation: builtin.operation, args };
    }
    const tool = entries.get(call.name);
    if (!tool) throw new HostToolAdmissionError('mcp_tool_unavailable');
    return { kind: 'direct', target: { kind: 'tool', tool, args } };
  };
  const validateTarget = (target: Target) => {
    if (target.kind === 'service') { lease.validateServiceRequest(target.service, target.request); return; }
    lease.validateArguments(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion, target.args);
  };
  const assertTarget = (target: Target) => {
    if (target.kind === 'service') { lease.assertService(target.service); lease.validateServiceRequest(target.service,target.request); return; }
    lease.assertCallable(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion);
  };
  const targetSignal = (target: Target) => target.kind === 'service' ? lease.serviceRevocationSignal(target.service)
    : lease.revocationSignal(targetName(target.tool.name, target.tool.schemaVersion), target.tool.schemaVersion);
  const prepareTarget = async (selected: Exclude<Selection, {kind:'discover'}>, call: HostToolCall, signal: AbortSignal): Promise<Target> => {
    if (selected.kind === 'direct') return selected.target;
    if (selected.kind === 'deferred') return { kind:'tool', tool:await lease.prepareTool(selected.server, selected.tool, selected.schemaVersion, signal), args:selected.args };
    const args = selected.args;
    if (selected.operation === 'get_prompt') {
      const prompt = await lease.preparePrompt(args.server as string, args.name as string, args.schemaVersion as string, signal);
      return { kind:'service', service:prompt.service, request:{operation:'prompts/get',prompt,arguments:(args.arguments ?? {}) as Record<string,string>},permissionName:call.name,args };
    }
    const service = await lease.prepareService(args.server as string, selected.operation === 'list_prompts' ? 'prompts' : 'resources', args.schemaVersion as string, signal);
    const request: McpServiceRequest = selected.operation === 'read_resource' ? {operation:'resources/read',uri:args.uri as string}
      : {operation:selected.operation === 'list_prompts' ? 'prompts/list' : args.kind === 'templates' ? 'resources/templates/list' : 'resources/list',
        ...(typeof args.cursor === 'string' ? {cursor:args.cursor} : {})};
    return {kind:'service',service,request,permissionName:call.name,args};
  };
  const decision = (current: PermissionPolicy, selected: Target) =>
    // Explicit Host rules remain authoritative. Unknown tools default to ask; annotations never
    // grant read-only status, Smart eligibility, or reusable approvals.
    evaluateGate(selected.kind === 'tool' ? selected.tool.name : selected.permissionName, selected.args, current);
  return {
    binding,
    implementationIdentity: lease.implementationIdentity,
    available(schema) {
      if (released) return false;
      if (!binding.tools.some(tool => isDeepStrictEqual(tool, schema))) return false;
      if (builtins.has(schema.name)) return true;
      try {
        lease.assertCallable(targetName(schema.name, schema.version), schema.version);
        return true;
      } catch {
        return false;
      }
    },
    async authorize(call, signal) {
      try {
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
            throw new HostToolAdmissionError('mcp_authorization_changed');
          validateTarget(approval.target);
          assertTarget(approval.target);
          signal.throwIfAborted();
          return;
        }
        // Safe undispatched restart rebind: prepare only the named dependency and verify the model's
        // recorded target version. This occurs before permission and resource occupancy acquisition.
        const target = await prepareTarget(selected, call, signal);
        validateTarget(target);
        const authorizedSignal = AbortSignal.any([signal, targetSignal(target)]);
        const current = await policy();
        const result = decision(current.value, target);
        if (result.decision === 'deny') throw new HostToolAdmissionError('mcp_permission_denied');
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
        assertTarget(target);
        approved.set(call.operationId, {
          identity: JSON.stringify(call),
          policy: current.generation,
          target,
        });
      } catch (error) {
        if (error instanceof McpAuthorityError && !error.dispatched) throw new HostToolAdmissionError(error.code);
        throw error;
      }
    },
    revocationSignal(call) {
      const target = approved.get(call.operationId)?.target;
      return target
        ? targetSignal(target)
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
          const services = selected.server ? await lease.discoverServices(selected.server, signal) : [];
          const query = selected.query.toLocaleLowerCase();
          const readiness = lease.inspect();
          return receipt(
            {
              kind: 'result',
              outcome: 'succeeded',
              effect: selected.server ? 'confirmed' : 'none',
              content: { data: {
                servers: readiness.servers,
                services,
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
              }, parts: [] },
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
        validateTarget(target);
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
              content: { data: { error: 'mcp_discovery_failed' }, parts: [] },
            },
            !signal.aborted,
          );
        return noEffect('mcp_dispatch_rejected');
      }
      try {
        const beforeDispatch = async () => {
          signal.throwIfAborted();
          const current = await policy();
          if (current.generation !== policyGeneration || decision(current.value, target).decision === 'deny') throw new HostToolAdmissionError('mcp_authorization_changed');
          assertTarget(target);
        };
        if (target.kind === 'service') {
          const response = await lease.requestService(target.service, target.request, {signal,beforeDispatch});
          const content = target.request.operation === 'resources/read' ? projectMcpOutput(response.result,'resource')
            : target.request.operation === 'prompts/get' ? projectMcpOutput(response.result,'prompt')
            : { data:{server:target.service.server,schemaVersion:target.service.schemaVersion,...response},parts:[] };
          return receipt({kind:'result',outcome:'succeeded',effect:'confirmed',content},true);
        }
        const result = await lease.callTool(targetName(target.tool.name, target.tool.schemaVersion), target.args, {
          schemaVersion: target.tool.schemaVersion, signal, beforeDispatch,
        });
        // An MCP isError receipt is a tool failure, not proof of rollback/no remote effects.
        return receipt(
          {
            kind: 'result',
            outcome: result.isError ? 'indeterminate' : 'succeeded',
            effect: result.isError ? 'unknown' : 'confirmed',
            content: projectMcpOutput(result as unknown as Record<string, unknown>, 'tool'),
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
            content: { data: { error: 'mcp_effect_unknown',
              ...(error instanceof McpAuthorityError && error.settlement === 'session_expired' ? { reason: error.code } : {}),
            }, parts: [] },
          },
          error instanceof McpAuthorityError && error.settlement === 'session_expired',
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
