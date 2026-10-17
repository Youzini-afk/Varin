import type { OutputPart, IncomingMedia } from './protocol.generated.js';
/** Ordinary installed services, selected and prepared by the existing routing/supervisor owner. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  HostCompositionPreparationRequiredError,
  type ApplicationExtensionRuntime,
  type HostServiceBinding,
} from '@varin/extension-host';
import {
  parseVarinExtensionServiceProvision,
  parseVarinToolJson,
  type VarinExtensionServiceProvision,
  type VarinExtensionHostStateSnapshot,
} from '@varin/extension-contract';
import {
  evaluateGate,
  validatePermissionMode,
  validatePermissionRule,
  type PermissionPolicy,
} from '@varin/protocol';
import { compileToolJsonSchema } from '../models/schema.js';
import type { ThreadToolPreparation, AgentSettingsSnapshot } from '@varin/application-client';
import type { KernelClient } from './kernel-client.js';
import type {
  ExecutorOwner,
  ExtensionToolBinding,
  HostToolCall,
  LaunchIntent,
  LaunchTool,
  Operation,
  Run,
} from './protocol.generated.js';
import {
  undispatchedToolReceipt,
  type HostToolLease,
  type ToolExecutionReceipt,
} from './tool-bridge.js';
import { permissionService } from './permission-service.js';
import {
  withToolInvocation,
  type ToolInvocationAuthority,
} from './tool-invocation.js';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
// Stable declaration identity does not depend on object property insertion order.
function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, value) =>
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  );
}
export function extensionToolSchema(
  descriptor: VarinExtensionServiceProvision,
): LaunchTool {
  const tool = descriptor.tool;
  if (!tool) throw new Error('service_has_no_tool_declaration');
  return {
    ...(tool.requirements ? { requirements: structuredClone(tool.requirements) } : {}),
    name: tool.name,
    version: createHash('sha256').update(canonical(descriptor)).digest('hex'),
    description: tool.description,
    schema: structuredClone(tool.inputSchema),
    output_schema: structuredClone(tool.outputSchema),
    metadata: {
      service_id: descriptor.id,
      service_version: descriptor.version,
      completion: tool.completion,
      ...(tool.lifetime ? { lifetime: tool.lifetime } : {}),
      operation: tool.operation,
      ...(tool.examples ? { examples: structuredClone(tool.examples) } : {}),
      ...(tool.source ? { source: structuredClone(tool.source) } : {}),
    },
  };
}
export interface ExtensionToolLease {
  binding: ExtensionToolBinding;
  generation: number;
  lease: HostToolLease;
  revocationSignal: AbortSignal;
}
export interface ExtensionToolConfiguration {
  (descriptor: VarinExtensionServiceProvision, original?: string | null): string | null;
  enabled?(descriptor: VarinExtensionServiceProvision): boolean;
  declaration?(descriptor: VarinExtensionServiceProvision, identity: string | null): VarinExtensionServiceProvision;
  retain?(descriptor: VarinExtensionServiceProvision, identity: string | null): () => void;
  retainPreparation?(): () => void;
  release?(): void;
}
/** Preserve the other owners' availability and lease hooks when composing configuration. */
export function extendToolConfiguration(
  previous: ExtensionToolConfiguration | undefined,
  resolve: ExtensionToolConfiguration,
  available?: (descriptor: VarinExtensionServiceProvision) => boolean | undefined,
): ExtensionToolConfiguration {
  return Object.assign(resolve, previous, {
    enabled: (descriptor: VarinExtensionServiceProvision) => available?.(descriptor) ?? previous?.enabled?.(descriptor) ?? true,
  });
}
/** One explicit tool toggle applies to every extension, in addition to owner readiness. */
export function configuredToolAvailability(snapshot: AgentSettingsSnapshot, previous: ExtensionToolConfiguration): ExtensionToolConfiguration {
  const global = object(snapshot.global.harness) ? snapshot.global.harness : {};
  const project = snapshot.projectTrusted && object(snapshot.project.harness) ? snapshot.project.harness : {};
  const tools = { ...(object(global.tools) ? global.tools : {}), ...(object(project.tools) ? project.tools : {}) };
  return extendToolConfiguration(previous, (descriptor, original) => previous(descriptor, original),
    descriptor => descriptor.tool && tools[descriptor.tool.name] === false ? false : undefined);
}
class ExtensionToolConfigurationError extends Error {
  constructor(serviceId: string, cause: unknown) {
    super(`extension_tool_configuration_unavailable:${serviceId}`, { cause });
  }
}
export interface ExtensionToolRun {
  runId: string;
  threadId: string;
  source: LaunchIntent['selection']['source'];
  projectId?: string;
  fixed?: boolean;
}
class ExtensionToolSourceError extends Error {
  constructor(serviceId: string, dependency: string) {
    super(`extension_tool_source_unavailable:${serviceId}:requires_${dependency}`);
  }
}
/** Availability projection of the original declaration, never a grant or dispatch fence. */
function requireToolSource(serviceId: string, requirements: LaunchTool['requirements'], source: ExtensionToolRun['source']): void {
  if (!requirements) return;
  const available = source && (requirements.source === 'source'
    || (requirements.source === 'physical' && source.mode !== 'fixed_branch')
    || (requirements.source === 'live' && source.mode === 'live_root'));
  if (!available) throw new ExtensionToolSourceError(serviceId, requirements.source);
}
export interface ExtensionToolOwnerOptions {
  runtime: ApplicationExtensionRuntime;
  kernel: KernelClient;
  currentPolicy(runId: string): Promise<PermissionPolicy>;
  /** Domain configuration is captured once by the ordinary Run preparation owner. */
  prepareConfiguration?(run: ExtensionToolRun, required: readonly ExtensionToolBinding[]): Promise<ExtensionToolConfiguration>;
  configurationIdentity?: ExtensionToolConfiguration;
  subscribeConfiguration?(listener: () => void): () => void;
}
export async function retainExtensionTool(
  options: ExtensionToolOwnerOptions,
  selected: HostServiceBinding,
  required?: ExtensionToolBinding,
): Promise<ExtensionToolLease> {
  const { runtime, kernel } = options,
    pin = (() => { try { return selected.pin(); } catch (error) { selected.release(); throw error; } })();
  let releaseConfiguration: (() => void) | undefined;
  try {
    const originalDescriptor = parseVarinExtensionServiceProvision(selected.descriptor);
    const provider = runtime.services
      .getSnapshot()
      .providers.find((p) => p.providerId === selected.providerId);
    const artifact =
      provider && runtime.supervisor.getRetainedArtifactIdentity(provider);
    if (!provider || !artifact || !selected.composition)
      throw new Error('extension_tool_artifact_unavailable');
    let configurationIdentity: string | null;
    try {
      configurationIdentity = options.configurationIdentity?.(originalDescriptor, required ? required.configurationIdentity : undefined) ?? null;
    } catch (error) { throw new ExtensionToolConfigurationError(originalDescriptor.id, error); }
    const descriptor = parseVarinExtensionServiceProvision(options.configurationIdentity?.declaration?.(originalDescriptor, configurationIdentity) ?? originalDescriptor);
    const schema = extensionToolSchema(descriptor);
    releaseConfiguration = options.configurationIdentity?.retain?.(descriptor, configurationIdentity);
    // Null states that this service has no separate configuration authority.
    const binding: ExtensionToolBinding = {
      providerKey: selected.providerKey,
      extensionId: provider.extensionId,
      extensionVersion: provider.extensionVersion,
      serviceId: descriptor.id,
      serviceVersion: descriptor.version,
      artifactIntegrity: artifact,
      composition: selected.composition,
      declarationHash: schema.version,
      configurationIdentity,
      tool: schema,
    };
    if (required && !isDeepStrictEqual(binding, required))
      throw new Error('extension_tool_exact_binding_unavailable');
    const validateInput = compileToolJsonSchema(schema.schema),
      validateOutput = compileToolJsonSchema(schema.output_schema);
    const approved = new Map<string, { identity: string; policy: string }>();
    let released = false;
    const policy = async (run: string) => {
      const current = await options.currentPolicy(run);
      const value = {
        mode: validatePermissionMode(current.mode),
        rules: current.rules.map((rule) => validatePermissionRule(rule)),
      };
      return {
        value,
        identity: createHash('sha256').update(canonical(value)).digest('hex'),
      };
    };
    const validate = (call: HostToolCall) => {
      if (
        released ||
        call.name !== schema.name ||
        call.schemaVersion !== schema.version
      )
        throw new Error('extension_tool_binding_changed');
      pin.assertAvailable();
      parseVarinToolJson(call.arguments);
      if (!validateInput(call.arguments))
        throw new Error('extension_tool_input_schema_invalid');
    };
    const gate = (call: HostToolCall, current: PermissionPolicy) =>
      evaluateGate(
        call.name,
        object(call.arguments) ? call.arguments : { input: call.arguments },
        current,
      );
    const authority = async (
      call: HostToolCall,
      signal: AbortSignal,
      owner: ExecutorOwner,
    ): Promise<ToolInvocationAuthority> => {
      const [op, run, launch] = await Promise.all([
        kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>(
          'runtime.operation.inspect',
          { operationId: call.operationId },
          signal,
        ),
        kernel.agentRuntimeRequest<Run, 'runtime.run.inspect'>(
          'runtime.run.inspect',
          { runId: call.runId },
          signal,
        ),
        kernel.agentRuntimeRequest<
          LaunchIntent | null,
          'runtime.launch.inspect'
        >('runtime.launch.inspect', { runId: call.runId }, signal),
      ]);
      const intent = op.intent;
      if (
        op.id !== call.operationId ||
        op.run_id !== call.runId ||
        run.id !== call.runId ||
        !launch ||
        launch.run_id !== call.runId ||
        op.phase !== 'running' ||
        op.cancel_requested ||
        run.cancel_requested ||
        !object(intent) ||
        !object(intent.call) ||
        !isDeepStrictEqual(intent.origin, call.origin) ||
        intent.call.call_id !== call.callId ||
        intent.call.name !== call.name ||
        intent.call.schema_version !== call.schemaVersion ||
        !isDeepStrictEqual(intent.call.arguments, call.arguments) ||
        !isDeepStrictEqual(op.execution_owner, owner)
      )
        throw new Error('extension_tool_invocation_unavailable');
      return {
        invocationId: randomUUID(),
        runId: call.runId,
        threadId: run.thread_id,
        operationId: call.operationId,
        callId: call.callId,
        executorOwner: owner,
        origin: call.origin,
        toolName: call.name,
        operation: descriptor.tool!.operation,
        completion: descriptor.tool!.completion,
        arguments: structuredClone(call.arguments),
        source: launch.selection.source,
        configurationIdentity: binding.configurationIdentity,
      };
    };
    const lease: HostToolLease = {
      releaseSelection: () => selected.release(),
      extensionBinding: binding,
      slot: `extension:${binding.serviceId}@${binding.serviceVersion}`,
      implementationIdentity: selected.providerId,
      binding: {
        reference: binding.providerKey,
        generation: provider.generation,
        resources: {},
        tools: [schema],
      },
      revocationSignal: () => pin.revocationSignal,
      available: () => {
        try {
          pin.assertAvailable();
          return !released;
        } catch {
          return false;
        }
      },
      async authorize(call, signal) {
        const combined = AbortSignal.any([signal, pin.revocationSignal]);
        combined.throwIfAborted();
        validate(call);
        const current = await policy(call.runId),
          decision = gate(call, current.value),
          previous = approved.get(call.operationId),
          identity = canonical(call);
        if (
          decision.decision === 'deny' ||
          (previous &&
            (previous.identity !== identity ||
              previous.policy !== current.identity))
        )
          throw new Error('extension_tool_permission_changed');
        if (!previous && decision.decision === 'ask')
          await permissionService(kernel).authorize(
            call,
            {
              ownerReference: binding.providerKey,
              ownerGeneration: provider.generation,
              toolSchemaVersion: schema.version,
              policyGeneration: current.identity,
              reason: decision.reason ?? 'Extension tool permission required',
            },
            combined,
          );
        combined.throwIfAborted();
        validate(call);
        approved.set(call.operationId, { identity, policy: current.identity });
      },
      async execute(call, signal, owner): Promise<ToolExecutionReceipt> {
        const combined = AbortSignal.any([signal, pin.revocationSignal]);
        let context: ToolInvocationAuthority;
        try {
          combined.throwIfAborted();
          validate(call);
          const previous = approved.get(call.operationId),
            current = await policy(call.runId);
          approved.delete(call.operationId);
          if (
            !previous ||
            previous.identity !== canonical(call) ||
            previous.policy !== current.identity ||
            gate(call, current.value).decision === 'deny'
          )
            throw new Error('authorization changed');
          context = await authority(call, combined, owner);
          combined.throwIfAborted();
          validate(call);
        } catch {
          return undispatchedToolReceipt('extension_tool_dispatch_rejected');
        }
        let domainReceipt: ToolExecutionReceipt | undefined;
        let parts: OutputPart<IncomingMedia>[] = [];
        const completeDomain = (receipt: ToolExecutionReceipt): ToolExecutionReceipt => {
          if (!parts.length) return receipt;
          const completion = receipt.completion;
          if (completion.kind === 'not_dispatched') throw new Error('Undispatched invocation cannot publish output');
          return { ...receipt, completion: { ...completion, content: { data: completion.content?.data ?? null, parts: [...(completion.content?.parts ?? []), ...parts] } } };
        };
        // Scope lifetime follows the actual pin callback, including cancellation/worker exit.
        try {
          const output = await withToolInvocation(
            {
              authority: context,
              owner: provider,
              signal: combined,
              onOutput: value => { parts = value; },
              onEffectReceipt: (receipt) => {
                domainReceipt = receipt;
              },
            },
            (scope) =>
              pin.invoke(
                'execute',
                [parseVarinToolJson(call.arguments)],
                combined,
                scope,
              ),
          );
          if (domainReceipt) return completeDomain(domainReceipt);
          if (!validateOutput(output))
            return {
              completion: {
                kind: 'result',
                outcome: 'indeterminate',
                effect: 'unknown',
                content: { data: { error: 'extension_tool_output_schema_invalid', output }, parts },
              },
              executor_stopped: true,
            };
          return {
            completion: {
              kind: 'result',
              outcome: 'succeeded',
              effect: 'confirmed',
              content: { data: output, parts },
            },
            executor_stopped: true,
          };
        } catch {
          if (domainReceipt) return completeDomain(domainReceipt);
          // Broker transport keeps dispatched promises pending until actual response or process exit.
          return {
            completion: {
              kind: 'result',
              outcome: 'indeterminate',
              effect: 'unknown',
              content: { data: { error: 'extension_tool_callback_failed' }, parts },
            },
            executor_stopped: true,
          };
        }
      },
      release() {
        if (!released) {
          released = true;
          releaseConfiguration?.();
          approved.clear();
          pin.release();
          selected.release();
        }
      },
    };
    pin.assertAvailable();
    return {
      binding,
      generation: provider.generation,
      lease,
      revocationSignal: pin.revocationSignal,
    };
  } catch (error) {
    releaseConfiguration?.();
    pin.release();
    selected.release();
    throw error;
  }
}
export interface ExtensionToolScope {
  readonly initial: ExtensionToolLease[];
  /** Ownership of a delivered lease transfers to publish, including if it rejects. */
  start(
    publish: (
      slot: string,
      lease: ExtensionToolLease | undefined,
      revoked?: Pick<ExtensionToolLease, 'binding' | 'generation'>,
    ) => Promise<void>,
  ): void;
  inspect(): ThreadToolPreparation[];
  close(): void;
}
export type ExtensionToolPreparer = (
  run: ExtensionToolRun & { branchId: string },
  required: ExtensionToolBinding[],
  signal: AbortSignal,
) => Promise<ExtensionToolScope>;
export const extensionToolSlot = (binding: ExtensionToolBinding) =>
  `${binding.serviceId}@${binding.serviceVersion}`;
export function createExtensionTools(
  options: ExtensionToolOwnerOptions,
): ExtensionToolPreparer {
  return async (run, required, signal) => {
    let preparedOptions = options.prepareConfiguration ? { ...options, configurationIdentity: await options.prepareConfiguration(run, required) } : options;
    try {
    const runtime = options.runtime,
      initial: ExtensionToolLease[] = [],
      states = new Map<string, ThreadToolPreparation>(),
      tokens = new Map<string, string>();
    let closed = false,
      publish:
        | ((
            slot: string,
            lease: ExtensionToolLease | undefined,
            revoked?: Pick<ExtensionToolLease, 'binding' | 'generation'>,
          ) => Promise<void>)
        | undefined;
    const watches = new Map<string, () => void>();
    const delivered = new Map<string, ExtensionToolLease>();
    const routingScope = {
      threadId: run.threadId, branchId: run.branchId, sourceRunId: run.runId,
      ...(run.projectId ? { projectId: run.projectId } : {}),
    };
    const services = (state: VarinExtensionHostStateSnapshot) => {
      const entries = new Map<
        string,
        {
          id: string;
          version: number;
          declarations: VarinExtensionServiceProvision[];
        }
      >();
      for (const extension of state.catalog.extensions)
        if (extension.desired.enabled && extension.manifest.entrypoints?.host)
          for (const descriptor of extension.manifest.provides?.services ?? [])
            if (descriptor.tool) {
              const slot = `${descriptor.id}@${descriptor.version}`,
                entry = entries.get(slot) ?? {
                  id: descriptor.id,
                  version: descriptor.version,
                  declarations: [],
                };
              entry.declarations.push(descriptor);
              entries.set(slot, entry);
            }
      return entries;
    };
    const watch = (slot: string, retained: ExtensionToolLease) => {
      watches.get(slot)?.();
      const revoked = retained.revocationSignal;
      const onRevoke = () => {
        if (!closed) {
          tokens.delete(slot);
          states.set(slot, {
            serviceId: retained.binding.serviceId,
            version: retained.binding.serviceVersion,
            declarations: [],
            status: 'unavailable',
            error: 'extension_tool_revoked',
          });
          void publish?.(slot, undefined, retained).catch(() => undefined);
        }
      };
      revoked.addEventListener('abort', onRevoke, { once: true });
      watches.set(slot, () => revoked.removeEventListener('abort', onRevoke));
      if (revoked.aborted) onRevoke();
    };
    const prepare = async (
      id: string,
      version: number,
      routingRevision: number,
    ) => {
      const candidateOptions = preparedOptions;
      const releasePreparation = candidateOptions.configurationIdentity?.retainPreparation?.();
      try {
      const selected = await runtime.prepareService(
        {
          serviceId: id,
          version,
          method: 'execute',
          args: [],
          routing: routingScope,
        },
        { expectedRoutingRevision: routingRevision, signal },
      );
      try {
        signal.throwIfAborted(); requireToolSource(id, selected.descriptor.tool?.requirements, run.source);
        return await retainExtensionTool(candidateOptions, selected);
      } catch (error) { selected.release(); throw error; }
      } finally { releasePreparation?.(); }
    };
    const snapshot = await runtime.state();
    signal.throwIfAborted();
    if (
      !snapshot.catalog.authoritative ||
      (!required.length && !snapshot.routing.authoritative)
    )
      throw new Error('extension_tool_catalog_unavailable');
    try {
      for (const binding of required) {
        requireToolSource(binding.serviceId, binding.tool.requirements, run.source);
        // A live original exchange can outlast ordinary package replacement. Derive an
        // independent pin before consulting the installed package, which now may be newer.
        const original = runtime.services
          .getSnapshot()
          .providers.find(
            (candidate) =>
              candidate.providerKey === binding.providerKey &&
              candidate.extensionId === binding.extensionId &&
              candidate.extensionVersion === binding.extensionVersion &&
              runtime.supervisor.getRetainedArtifactIdentity(candidate) ===
                binding.artifactIntegrity &&
              runtime.supervisor.getRetainedComposition(candidate)?.root === binding.composition.root,
          );
        if (original) {
          const selected = runtime.services.bindPinned(
            binding.serviceId,
            binding.serviceVersion,
            original.providerId,
          );
          initial.push(await retainExtensionTool(preparedOptions, selected, binding));
          signal.throwIfAborted();
          continue;
        }
        const selected = await runtime.prepareService({ serviceId: binding.serviceId, version: binding.serviceVersion,
          method: 'execute', args: [], routing: routingScope }, { signal, frozenComposition: binding.composition });
        const retained = await retainExtensionTool(preparedOptions, selected, binding);
        initial.push(retained);
        signal.throwIfAborted();
      }
      if (!required.length && !run.fixed) for (const entry of services(snapshot).values()) {
        try {
          if (entry.declarations.every(descriptor => preparedOptions.configurationIdentity?.enabled?.(descriptor) === false)) continue;
          const resolved = await runtime.resolveServiceCompositions({ serviceId: entry.id, version: entry.version,
            method: 'execute', args: [], routing: routingScope }, { signal, expectedRoutingRevision: snapshot.routing.document.revision });
          const root = resolved.services[0];
          if (resolved.services.length !== 1 || !root || !snapshot.services.providers.some(provider => provider.status === 'active'
            && provider.providerKey === root.providerKey && runtime.supervisor.getRetainedComposition(provider)?.root === root.composition.root)) continue;
          initial.push(await prepare(entry.id, entry.version, snapshot.routing.document.revision));
        } catch (error) {
          if (error instanceof HostCompositionPreparationRequiredError) continue;
          states.set(`${entry.id}@${entry.version}`, { serviceId: entry.id, version: entry.version,
            declarations: entry.declarations, status: 'unavailable',
            error: error instanceof ExtensionToolConfigurationError || error instanceof ExtensionToolSourceError ? error.message : 'extension_tool_preparation_failed' });
        }
        signal.throwIfAborted();
      }
    } catch (error) {
      for (const retained of initial) retained.lease.release();
      throw error;
    }
    const tokenFor = async (state: VarinExtensionHostStateSnapshot, id: string, version: number): Promise<string> => {
      try {
        const resolved = await runtime.resolveServiceCompositions({ serviceId: id, version, method: 'execute', args: [], routing: routingScope },
          { signal, expectedRoutingRevision: state.routing.document.revision });
        return canonical(resolved.services.map(service => ({ provider: service.providerKey, graph: service.composition.root, descriptor: service.descriptor,
          configuration: preparedOptions.configurationIdentity?.(service.descriptor) ?? null })));
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof HostCompositionPreparationRequiredError) return canonical({ needsPreparation: error.extensionId,
          routing: state.routing.document, declarations: state.catalog.extensions.map(entry => [entry.manifest.id, entry.integrity, entry.desired.enabled, entry.manifest.requires, entry.capabilityGrants]) });
        return `unavailable:${error instanceof Error ? error.message : String(error)}`;
      }
    };
    for (const retained of initial) {
      const slot = extensionToolSlot(retained.binding);
      if (!required.length)
        tokens.set(
          slot,
          await tokenFor(
            snapshot,
            retained.binding.serviceId,
            retained.binding.serviceVersion,
          ),
        );
      states.set(slot, {
        serviceId: retained.binding.serviceId,
        version: retained.binding.serviceVersion,
        declarations: services(snapshot).get(slot)?.declarations ?? [],
        status: 'ready',
        prepared: retained.binding,
      });
      delivered.set(slot, retained);
    }
    let seenRevision = snapshot.revision;
    const refreshOnce = async () => {
      if (run.fixed) return;
      if (options.prepareConfiguration) {
        const configurationIdentity = await options.prepareConfiguration(run, []);
        if (closed || signal.aborted) { configurationIdentity.release?.(); return; }
        const previous = preparedOptions.configurationIdentity;
        preparedOptions = { ...options, configurationIdentity }; previous?.release?.();
      }
      const current = await runtime.state();
      if (
        closed ||
        signal.aborted ||
        !current.catalog.authoritative ||
        !current.routing.authoritative ||
        current.revision < seenRevision
      )
        return;
      seenRevision = current.revision;
      for (const [slot, entry] of services(current)) {
        if (entry.declarations.every(descriptor => preparedOptions.configurationIdentity?.enabled?.(descriptor) === false)) {
          tokens.delete(slot); states.delete(slot);
          const previous = delivered.get(slot);
          if (previous && publish) { await publish(slot, undefined, previous); delivered.delete(slot); watches.get(slot)?.(); watches.delete(slot); }
          continue;
        }
        const token = await tokenFor(current, entry.id, entry.version);
        if (tokens.get(slot) === token) continue;
        tokens.set(slot, token);
        states.set(slot, {
          serviceId: entry.id,
          version: entry.version,
          declarations: entry.declarations,
          status: 'preparing',
        });
        void prepare(entry.id, entry.version, current.routing.document.revision)
          .then(async (retained) => {
            if (closed || signal.aborted || tokens.get(slot) !== token) {
              retained.lease.release();
              return;
            }
            states.set(slot, {
              serviceId: entry.id,
              version: entry.version,
              declarations: entry.declarations,
              status: 'ready',
              prepared: retained.binding,
            });
            // A failed candidate leaves the former callable owner intact. Only original revocation withdraws it.
            if (publish) {
              await publish(slot, retained);
              // The publication, rather than a newer preparation token, owns this handoff.
              // Successful callbacks follow the same short publication chain in admission order.
              if (!closed) watch(slot, retained);
              delivered.set(slot, retained);
            } else retained.lease.release();
          })
          .catch((error: unknown) => {
            if (!closed && tokens.get(slot) === token)
              states.set(slot, {
                serviceId: entry.id,
                version: entry.version,
                declarations: entry.declarations,
                status: 'unavailable',
                error: error instanceof ExtensionToolConfigurationError || error instanceof ExtensionToolSourceError ? error.message : 'extension_tool_preparation_failed',
              });
          });
      }
    };
    let refreshing: Promise<void> | undefined;
    let refreshPending = false;
    const refresh = (): Promise<void> => {
      refreshPending = true;
      return refreshing ??= (async () => {
        while (refreshPending && !closed) { refreshPending = false; await refreshOnce(); }
      })().finally(() => { refreshing = undefined; });
    };
    let unsubscribe: () => void;
    try {
      unsubscribe = run.fixed
        ? () => undefined
        : runtime.subscribe(() => {
            if (publish) void refresh().catch(() => undefined);
          });
    } catch (error) {
      for (const retained of initial) retained.lease.release();
      throw error;
    }
    const unsubscribeConfiguration = run.fixed ? () => {} : options.subscribeConfiguration?.(() => {
      if (publish) void refresh().catch(() => undefined);
    }) ?? (() => {});
    const close = () => {
      if (closed) return;
      closed = true;
      preparedOptions.configurationIdentity?.release?.();
      unsubscribe();
      unsubscribeConfiguration();
      for (const unwatch of watches.values()) unwatch();
      watches.clear();
      signal.removeEventListener('abort', close);
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) {
      close();
      for (const retained of initial) retained.lease.release();
      signal.throwIfAborted();
    }
    return {
      initial,
      start(callback) {
        if (closed) return;
        publish = callback;
        for (const retained of initial)
          watch(extensionToolSlot(retained.binding), retained);
        void refresh().catch(() => undefined);
      },
      inspect: () => [...states.values()].map((v) => structuredClone(v)),
      close,
    };
    } catch (error) { preparedOptions.configurationIdentity?.release?.(); throw error; }
  };
}
