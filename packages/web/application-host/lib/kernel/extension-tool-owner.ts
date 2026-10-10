/** Ordinary installed services, selected and prepared by the existing routing/supervisor owner. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  ApplicationExtensionRuntime,
  HostServiceBinding,
} from '@varin/extension-host';
import {
  parseVarinExtensionServiceProvision,
  parseVarinToolJson,
  resolveVarinExtensionServiceRouting,
  type VarinExtensionServiceProvision,
  type VarinExtensionHostStateSnapshot,
} from '@varin/extension-contract';
import {
  evaluateGate,
  validatePermissionMode,
  validatePermissionRule,
  type PermissionPolicy,
} from '@varin/protocol';
import { compileToolJsonSchema } from '@varin/pi-host/tool-schema';
import type { ThreadToolPreparation } from '@varin/application-client';
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
    name: tool.name,
    version: createHash('sha256').update(canonical(descriptor)).digest('hex'),
    description: tool.description,
    schema: structuredClone(tool.inputSchema),
    output_schema: structuredClone(tool.outputSchema),
    metadata: {
      service_id: descriptor.id,
      service_version: descriptor.version,
      completion: tool.completion,
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
export interface ExtensionToolOwnerOptions {
  runtime: ApplicationExtensionRuntime;
  kernel: KernelClient;
  currentPolicy(runId: string): Promise<PermissionPolicy>;
}
export async function retainExtensionTool(
  options: ExtensionToolOwnerOptions,
  selected: HostServiceBinding,
  required?: ExtensionToolBinding,
): Promise<ExtensionToolLease> {
  const { runtime, kernel } = options,
    pin = selected.pin();
  try {
    const descriptor = parseVarinExtensionServiceProvision(selected.descriptor),
      schema = extensionToolSchema(descriptor);
    const provider = runtime.services
      .getSnapshot()
      .providers.find((p) => p.providerId === selected.providerId);
    const artifact =
      provider && runtime.supervisor.getActiveArtifactIdentity(provider);
    if (!provider || !artifact)
      throw new Error('extension_tool_artifact_unavailable');
    // A service has no separate configuration authority in this contract. Null states that fact.
    const binding: ExtensionToolBinding = {
      providerKey: selected.providerKey,
      extensionId: provider.extensionId,
      extensionVersion: provider.extensionVersion,
      serviceId: descriptor.id,
      serviceVersion: descriptor.version,
      artifactIntegrity: artifact,
      declarationHash: schema.version,
      configurationIdentity: null,
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
        origin: call.origin,
        toolName: call.name,
        operation: descriptor.tool!.operation,
        arguments: structuredClone(call.arguments),
        source: launch.selection.source,
      };
    };
    const lease: HostToolLease = {
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
        // Scope lifetime follows the actual pin callback, including cancellation/worker exit.
        try {
          const output = await withToolInvocation(
            { authority: context, owner: provider, signal: combined, onEffectReceipt: receipt => { domainReceipt = receipt; } },
            (scope) =>
              pin.invoke(
                'execute',
                [parseVarinToolJson(call.arguments)],
                combined,
                scope,
              ),
          );
          if (domainReceipt) return domainReceipt;
          if (!validateOutput(output))
            return {
              completion: {
                kind: 'result',
                outcome: 'indeterminate',
                effect: 'unknown',
                content: {
                  error: 'extension_tool_output_schema_invalid',
                  output,
                },
              },
              executor_stopped: true,
            };
          return {
            completion: {
              kind: 'result',
              outcome: 'succeeded',
              effect: 'confirmed',
              content: output,
            },
            executor_stopped: true,
          };
        } catch {
          if (domainReceipt) return domainReceipt;
          // Broker transport keeps dispatched promises pending until actual response or process exit.
          return {
            completion: {
              kind: 'result',
              outcome: 'indeterminate',
              effect: 'unknown',
              content: { error: 'extension_tool_callback_failed' },
            },
            executor_stopped: true,
          };
        }
      },
      release() {
        if (!released) {
          released = true;
          approved.clear();
          pin.release();
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
    pin.release();
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
  run: { runId: string; threadId: string; projectId?: string },
  required: ExtensionToolBinding[],
  signal: AbortSignal,
) => Promise<ExtensionToolScope>;
export const extensionToolSlot = (binding: ExtensionToolBinding) =>
  `${binding.serviceId}@${binding.serviceVersion}`;
export function createExtensionTools(
  options: ExtensionToolOwnerOptions,
): ExtensionToolPreparer {
  return async (run, required, signal) => {
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
    const routingScope = {
      sessionId: run.threadId,
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
      const selected = await runtime.prepareService(
        {
          serviceId: id,
          version,
          method: 'execute',
          args: [],
          routing: routingScope,
        },
        { expectedRoutingRevision: routingRevision },
      );
      return retainExtensionTool(options, selected);
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
        const entry = snapshot.catalog.extensions.find(
          (e) =>
            e.manifest.id === binding.extensionId &&
            e.desired.enabled &&
            e.integrity === binding.artifactIntegrity,
        );
        if (
          !entry?.manifest.provides?.services?.some(
            (d) =>
              d.id === binding.serviceId &&
              d.version === binding.serviceVersion &&
              d.tool,
          )
        )
          throw new Error('extension_tool_exact_artifact_unavailable');
        // A saved invocation selects its exact artifact/service owner independently of
        // today's routing. The existing supervisor alone activates that installed package.
        await runtime.activateExtension(binding.extensionId);
        signal.throwIfAborted();
        const provider = runtime.services
          .getSnapshot()
          .providers.find(
            (candidate) =>
              candidate.status === 'active' &&
              candidate.providerKey === binding.providerKey &&
              candidate.extensionId === binding.extensionId &&
              candidate.extensionVersion === binding.extensionVersion,
          );
        if (!provider)
          throw new Error('extension_tool_exact_binding_unavailable');
        const selected = runtime.services.bind(
          binding.serviceId,
          binding.serviceVersion,
          provider.providerId,
        );
        const retained = await retainExtensionTool(options, selected, binding);
        initial.push(retained);
        signal.throwIfAborted();
      }
      if (!required.length)
        for (const entry of services(snapshot).values()) {
          // Read the existing routing owner's pure resolution, without starting a cold provider.
          // Candidate construction and legacy explicit-selection precedence match prepareService.
          const legacy =
            snapshot.services.selections[`${entry.id}@${entry.version}`];
          let providerId = legacy;
          if (!providerId) {
            const candidates = snapshot.catalog.extensions
              .filter(
                (e) =>
                  e.desired.enabled &&
                  e.manifest.entrypoints?.host &&
                  e.manifest.provides?.services?.some(
                    (d) => d.id === entry.id && d.version === entry.version,
                  ),
              )
              .map((e) => ({
                extensionId: e.manifest.id,
                providerId: e.manifest.id,
                providerKey: `${e.manifest.id}:host:${entry.id}@${entry.version}`,
              }));
            const resolution = resolveVarinExtensionServiceRouting({
              candidates,
              document: snapshot.routing.document,
              serviceId: entry.id,
              version: entry.version,
              context: routingScope,
            });
            if (resolution.status !== 'resolved') continue;
            providerId = snapshot.services.providers.find(
              (p) =>
                p.status === 'active' &&
                p.providerKey === resolution.providerKey,
            )?.providerId;
          }
          if (!providerId) continue;
          const selected = runtime.services.bind(
            entry.id,
            entry.version,
            providerId,
          );
          if (!selected.descriptor.tool) continue;
          initial.push(await retainExtensionTool(options, selected));
          signal.throwIfAborted();
        }
    } catch (error) {
      for (const retained of initial) retained.lease.release();
      throw error;
    }
    const tokenFor = (
      state: VarinExtensionHostStateSnapshot,
      id: string,
      version: number,
    ) =>
      canonical({
        routing: state.routing.document,
        selection: state.services.selections[`${id}@${version}`] ?? null,
        candidates: state.catalog.extensions
          .filter((e) =>
            e.manifest.provides?.services?.some(
              (d) => d.id === id && d.version === version,
            ),
          )
          .map((e) => ({
            id: e.manifest.id,
            integrity: e.integrity,
            enabled: e.desired.enabled,
            services: e.manifest.provides?.services?.filter(
              (d) => d.id === id && d.version === version,
            ),
          })),
      });
    for (const retained of initial) {
      const slot = extensionToolSlot(retained.binding);
      if (!required.length)
        tokens.set(
          slot,
          tokenFor(
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
    }
    let seenRevision = snapshot.revision;
    const refresh = async () => {
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
        const token = tokenFor(current, entry.id, entry.version);
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
            } else retained.lease.release();
          })
          .catch(() => {
            if (!closed && tokens.get(slot) === token)
              states.set(slot, {
                serviceId: entry.id,
                version: entry.version,
                declarations: entry.declarations,
                status: 'unavailable',
                error: 'extension_tool_preparation_failed',
              });
          });
      }
    };
    let unsubscribe: () => void;
    try {
      unsubscribe = runtime.subscribe(() => {
        if (publish) void refresh().catch(() => undefined);
      });
    } catch (error) {
      for (const retained of initial) retained.lease.release();
      throw error;
    }
    const close = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
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
  };
}
