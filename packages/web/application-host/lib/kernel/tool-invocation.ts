/** Call-scoped authority carried only by a Host-created service invocation. Broker payloads
 * carry an opaque identifier; extension-supplied Run/workspace fields never grant authority.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseVarinToolJson, parseIncomingOutputPart, type JsonValue, type OutputPart, type IncomingMedia } from '@varin/extension-contract';
import { unknownToolReceipt, type ToolExecutionReceipt } from './tool-bridge.js';
import type { HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';
import { toolOperationId, validToolOrigin, type ExecutorOwner, type LaunchSource, type ToolOrigin } from './protocol.generated.js';

export interface ToolInvocationAuthority {
  readonly invocationId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly callId: string;
  readonly executorOwner: ExecutorOwner;
  readonly origin: ToolOrigin;
  readonly source: Readonly<LaunchSource> | null;
  readonly toolName: string;
  readonly operation: 'read' | 'effect';
  readonly completion: 'result' | 'job';
  readonly configurationIdentity?: string | null;
  readonly arguments: unknown;
}
interface Registration {
  authority: ToolInvocationAuthority;
  owner: Readonly<HostServiceOwnerIdentity>;
  signal: AbortSignal;
  accepting: boolean;
  nested: Set<Promise<unknown>>;
  parts: OutputPart<IncomingMedia>[];
  dependencyOwners: Map<string, number>;
  parent?: Registration;
  cell?: { environmentId: string; computerUsed(desktopId: string): void; usesComputer(desktopId: string): boolean; computerCancellation?(cancel: (reason: unknown) => void): () => void };
  effect?: { domain: string; work: Promise<ToolExecutionReceipt> };
}
// This recognizes the very same object owned by the service invocation. It neither schedules
// execution nor stores an independent Operation/receipt or accepts extension-reported identities.
const registrations = new WeakMap<HostInvocationScope, Registration>();
// A short-lived index of those same registrations, retained through their actual drain.
// It carries ancestry, never permission or another Operation/receipt authority.
const liveOperations = new Map<string, Registration>();
const serviceOwnerKey = (owner: HostServiceOwnerIdentity) => JSON.stringify([
  owner.extensionId, owner.entrypointId, owner.extensionVersion, owner.instanceKey, owner.generation,
]);
const ownsInvocation = (registration: Registration, owner: HostServiceOwnerIdentity): boolean =>
  serviceOwnerKey(registration.owner) === serviceOwnerKey(owner) || (registration.dependencyOwners.get(serviceOwnerKey(owner)) ?? 0) > 0;

/** Host-only bridge entry. The caller must first validate the original Catalog invocation and
 * immutable Run launch. `work` must be the real pin.invoke promise, never a cancelled reader race.
 */
export async function withToolInvocation<T>(options: {
  authority: ToolInvocationAuthority;
  owner: HostServiceOwnerIdentity;
  signal: AbortSignal;
  /** Only trusted Host domain handlers can supply original executor evidence. */
  onOutput?: (parts: OutputPart<IncomingMedia>[]) => void;
  onEffectReceipt?: (receipt: ToolExecutionReceipt) => void;
}, work: (scope: HostInvocationScope) => Promise<T>): Promise<T> {
  options.signal.throwIfAborted();
  const authority = structuredClone(options.authority);
  const { origin } = authority;
  if (!authority.invocationId || !authority.runId || !authority.threadId || !authority.callId
    || !validToolOrigin(origin) || authority.operationId !== toolOperationId(origin, authority.callId)
    || (origin.kind === 'policy_action' && origin.node_id !== authority.callId)) {
    throw new Error('tool_invocation_identity_invalid');
  }
  Object.freeze(authority.origin);
  Object.freeze(authority.executorOwner);
  if (authority.source) {
    if (authority.source.live_root) Object.freeze(authority.source.live_root);
    Object.freeze(authority.source);
  }
  Object.freeze(authority);
  const registration: Registration = { authority, owner: Object.freeze({ ...options.owner }), signal: options.signal, accepting: true, nested: new Set(), parts: [], dependencyOwners: new Map() };
  const scope: HostInvocationScope = Object.freeze({ id: randomUUID(), value: null,
    invokeDependency: <Result>(from: HostServiceOwnerIdentity, to: HostServiceOwnerIdentity, invoke: () => Promise<Result>): Promise<Result> => {
      if (!registration.accepting || registration.signal.aborted || !ownsInvocation(registration, from)) throw new Error('tool_invocation_unavailable');
      const key = serviceOwnerKey(to);
      registration.dependencyOwners.set(key, (registration.dependencyOwners.get(key) ?? 0) + 1);
      const work = Promise.resolve().then(invoke).finally(() => {
        const remaining = (registration.dependencyOwners.get(key) ?? 1) - 1;
        if (remaining) registration.dependencyOwners.set(key, remaining); else registration.dependencyOwners.delete(key);
      });
      registration.nested.add(work);
      void work.then(() => registration.nested.delete(work), () => registration.nested.delete(work));
      return work;
    },
  });
  if (liveOperations.has(authority.operationId)) throw new Error('tool_invocation_already_active');
  if (origin.kind === 'nested_call') {
    const parent = liveOperations.get(origin.parent_operation_id);
    if (parent && parent.authority.runId === authority.runId && parent.authority.threadId === authority.threadId) registration.parent = parent;
  }
  registrations.set(scope, registration);
  liveOperations.set(authority.operationId, registration);
  try { return await work(scope); }
  finally {
    // A broker response/exit stops new capabilities, but does not stop a Host file writer
    // already admitted by that invocation. Keep the original lease until its real promise settles.
    registration.accepting = false;
    try {
      await Promise.allSettled(registration.nested);
      if (registration.effect) {
        // An unclassified domain error is not evidence that its physical writer stopped.
        const receipt = await registration.effect.work.catch(unknownToolReceipt);
        options.onEffectReceipt?.(receipt);
      }
    } finally { options.onOutput?.(registration.parts); registrations.delete(scope); liveOperations.delete(authority.operationId); }
  }
}

/** Trusted script-domain lifecycle attachment, never a broker-supplied identity. */
export async function withScriptCell<T>(context: HostCapabilityCallContext,
  cell: { environmentId: string; computerUsed(desktopId: string): void; usesComputer(desktopId: string): boolean; computerCancellation?(cancel: (reason: unknown) => void): () => void }, work: () => Promise<T>): Promise<T> {
  requireToolInvocation(context);
  const registration = registrations.get(context.invocation!)!;
  if (registration.cell) throw new Error('script_cell_already_active');
  registration.cell = cell;
  try { return await work(); }
  finally { delete registration.cell; }
}

/** The actual Computer dispatch calls this only after resolving its admitted desktop. */
export function noteInvocationComputerUse(context: HostCapabilityCallContext, desktopId: string, cancel?: (reason: unknown) => void): () => void {
  requireToolInvocation(context);
  const removers: Array<() => void> = [];
  try {
    for (let current = registrations.get(context.invocation!); current; current = current.parent) {
      if (current.signal.aborted) throw new Error('tool_invocation_unavailable');
      current.cell?.computerUsed(desktopId);
      const remove = cancel && current.cell?.computerCancellation?.(cancel);
      if (remove) removers.push(remove);
    }
  } catch (error) { for (const remove of removers) remove(); throw error; }
  return () => { for (const remove of removers) remove(); };
}

/** A nested Computer cancellation must not wait for the same active cell that waits for it. */
export function assertNoScriptComputerStopCycle(context: HostCapabilityCallContext, desktopId: string): void {
  requireToolInvocation(context);
  for (let current = registrations.get(context.invocation!)?.parent; current; current = current.parent) {
    if (current.cell?.usesComputer(desktopId)) throw new Error('script_environment_dependency_cycle: finish the current cell, then cancel this desktop from an independent ordinary tool call');
  }
}

/** Reject only a proved cycle to the actual active ancestor cell. */
export function assertNoScriptCellCycle(context: HostCapabilityCallContext, environmentId: string): void {
  requireToolInvocation(context);
  for (let current = registrations.get(context.invocation!)?.parent; current; current = current.parent) {
    if (current.cell?.environmentId === environmentId) throw new Error('script_environment_dependency_cycle');
  }
}

/** Domain adapters use this typed boundary; they do not cast unknown broker data to authority. */
export function requireToolInvocation(context: HostCapabilityCallContext): ToolInvocationAuthority {
  const registration = context.invocation ? registrations.get(context.invocation) : undefined;
  if (!registration || !registration.accepting || registration.signal.aborted || context.signal.aborted
    || !ownsInvocation(registration, context.owner)) {
    throw new Error('tool_invocation_unavailable');
  }
  return registration.authority;
}


/** Bind an effectful trusted domain to this exact admitted call. The original domain journal
 * remains the effect owner. This only retains its actual promise and projects its receipt back
 * through the existing ToolBridge; extension JSON can never supply stop/effect evidence. */
export function runToolDomainCall(
  context: HostCapabilityCallContext,
  input: { domain: string; toolName: string; operation: 'read' | 'effect'; arguments: JsonValue },
  execute: (authority: ToolInvocationAuthority) => Promise<ToolExecutionReceipt>,
): Promise<JsonValue> {
  const authority = requireToolInvocation(context);
  if (authority.operation !== input.operation || authority.toolName !== input.toolName || !isDeepStrictEqual(authority.arguments, input.arguments)) {
    throw new Error('tool_domain_call_changed');
  }
  const registration = registrations.get(context.invocation!)!;
  if (registration.effect && registration.effect.domain !== input.domain) throw new Error('tool_domain_owner_changed');
  if (!registration.effect) {
    const work = Promise.resolve().then(() => execute(authority));
    registration.effect = { domain: input.domain, work };
    // An extension may abandon its capability promise. withToolInvocation still observes it.
    void work.catch(() => undefined);
  }
  return registration.effect.work.then(receipt => {
    if (receipt.completion.kind !== 'result' && receipt.completion.kind !== 'job_accepted') throw new Error('tool_domain_result_unavailable');
    return parseVarinToolJson(receipt.completion.kind === 'job_accepted' && receipt.completion.content === undefined
      ? { operationId: authority.operationId, phase: receipt.completion.phase }
      : receipt.completion.content?.data);
  });
}

/** Register before invoking the actual Kernel caller; observer cancellation does not end it. */
export function runNestedToolCall<T>(context: HostCapabilityCallContext, execute: (authority: ToolInvocationAuthority) => Promise<T>): Promise<T> {
  const authority = requireToolInvocation(context);
  const registration = registrations.get(context.invocation!)!;
  const work = Promise.resolve().then(() => execute(authority));
  registration.nested.add(work);
  void work.then(() => registration.nested.delete(work), () => registration.nested.delete(work));
  return work;
}

/** Explicit publication belongs to this exact live callback, including its failure path. */
export function emitToolOutput(context: HostCapabilityCallContext, value: unknown): void {
  const authority = requireToolInvocation(context);
  if (authority.completion !== 'result') throw new Error('Job output belongs to its owning domain: supply OutputBody parts at acceptance or terminal receipt; call.output cannot rewrite a Job acceptance');
  const part = parseIncomingOutputPart(value);
  registrations.get(context.invocation!)!.parts.push(part);
}
