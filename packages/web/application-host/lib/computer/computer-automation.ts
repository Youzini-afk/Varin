import { ComputerError, ComputerReleaseUnconfirmed } from './computer-error.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { computerWorkKey, computerExecutionKey, sameComputerWork, sameComputerExecution, type ComputerAccess, type ComputerAccessRequest, type ComputerActor, type ComputerAutomationState, type ComputerLease, type ComputerWorkRef, type ComputerExecutionRef, type ComputerWorkScope, type ComputerCleanup } from '@varin/protocol';
import { HarnessServiceError } from '../harness/service-error.js';

export interface ComputerAdmission {
  sequence: number;
  actor: ComputerActor;
  lease?: ComputerLease;
  key: string;
  signal: AbortSignal;
  assert(): void;
  /** Trusted cancellation of this actual admitted in-flight dispatch only. */
  cancel(reason: unknown): void;
}

/** Live authorization over existing Thread/Run identities. No model or renderer owns this state. */
export function createComputerAutomation(options: {
  resolveActor(work: ComputerWorkRef): Promise<ComputerActor | null>;
  resolveScope(work: ComputerWorkRef): Promise<ComputerWorkScope | null>;
  pendingReleases?(): readonly { actor: ComputerActor; desktopId: string }[];
  /** Original handoff/outbox provenance only; never an assignment or physical cleanup. */
  pendingControlFacts?(): readonly { actor: ComputerActor; desktopId: string }[];
  reserve?(lease: ComputerLease, signal: AbortSignal): Promise<void>;
  describeDesktop?(desktopId: string): Promise<string>;
  release(lease: ComputerLease): Promise<{ released: boolean }>;
  controlAvailable(desktopId: string): boolean;
  notify(actor: ComputerActor, text: string, wake: boolean, id: string, recipient?: 'actor' | 'root'): Promise<void>;
  revokeSession(actor: ComputerActor, desktopIds?: readonly string[]): Promise<void>;
  bindDesktop(actor: ComputerActor, desktopId: string): Promise<void>;
  cancelWork?(actor: ComputerActor, desktopIds: readonly string[], cancellationId: string): Promise<void>;
  notifyCancelled?(actor: ComputerActor, desktopIds: readonly string[], cancellationId: string): Promise<void>;
  onChange(state: ComputerAutomationState): void;
  onInvalidate?(work: ComputerWorkRef): void;
}) {
  const context = new AsyncLocalStorage<ComputerAdmission>();
  const leases = new Map<string, ComputerLease>();
  // Pi owns its existing ephemeral requests. Native metadata is read from the Catalog port.
  const requests = new Map<string, ComputerAccessRequest>();
  let nativeRequests: { snapshot(scope: ComputerWorkScope): Promise<ComputerAccessRequest[]>; cancel(actor: ComputerActor, desktopId: string | undefined, family: boolean): Promise<void> } | undefined;
  const releasedAssignments = new Set<string>();
  const pendingAssignments = new Set<string>();
  const controllers = new Map<string, { actor: ComputerActor; abort: AbortController; desktopId?: string; access: ComputerAccess }>();
  const cancellations = new Map<string, Promise<ComputerAutomationState>>();
  const cancellationState = new Map<string, Exclude<ComputerAutomationState['status'], 'enabled'>>();
  const revisions = new Map<string, number>();
  const cancelledThrough = new Map<string, number>();
  let admissionSequence = 0;
  const lastActors = new Map<string, ComputerActor>();
  const ended = new Set<string>();
  const transfers = new Set<string>();
  const unconfirmed = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const foreign = new Map<string, ComputerLease>();
  const ready = new Map<string, Promise<void>>();
  // A removed permission is not a completed physical release. Keep the original
  // lease with its in-flight callback so concurrent lifecycle callers join it.
  const releasing = new Map<string, { lease: ComputerLease; promise: Promise<void> }>();
  const failedReleases = new Map<string, ComputerLease>();
  const cleanupLeases = () => [...new Map([
    ...leases.values(), ...failedReleases.values(), ...[...releasing.values()].map(entry => entry.lease),
  ].map(lease => [lease.id, lease])).values()];
  const reservationAborts = new Map<string, AbortController>();
  const peerClaims = new Map<string, { identity: string; origin: string; assignmentId: string; actor: ComputerActor; lease?: ComputerLease; ready: Promise<string> }>();
  const revokedClaims = new Set<string>();
  const delegationFor = (actor: ComputerActor) => [...peerClaims.values()].find(entry => entry.actor === actor);
  const originFor = (actor: ComputerActor) => { const entry = delegationFor(actor); return entry ? JSON.stringify([entry.origin, entry.assignmentId]) : undefined; };
  const roundKey = (actor: ComputerActor) => JSON.stringify([originFor(actor) ?? null, actor.execution.work.runtime === 'agent' ? computerExecutionKey(actor.execution) : actor.rootExecution ? computerExecutionKey(actor.rootExecution) : computerWorkKey(actor.rootWork)]);
  const workKey = (actor: ComputerActor, desktopId?: string) => desktopId ? `${roundKey(actor)}\0${desktopId}` : roundKey(actor);
  const statusFor = (actor: ComputerActor, desktopId?: string) => {
    const prefixes = [roundKey(actor), `execution:${actorKey(actor)}`];
    const values = [...cancellationState].filter(([key]) => prefixes.some(prefix => key === prefix || (desktopId ? key === `${prefix}\0${desktopId}` : key.startsWith(`${prefix}\0`)))).map(([, value]) => value);
    return values.includes('cancelling') ? 'cancelling' as const : values.includes('cancel-unconfirmed') ? 'cancel-unconfirmed' as const : undefined;
  };
  const actorKey = (actor: ComputerActor) => JSON.stringify([originFor(actor) ?? null, computerExecutionKey(actor.execution)]);
  const rootActor = (actor: ComputerActor) => sameComputerWork(actor.execution.work, actor.rootWork);
  const hasEnded = (actor: ComputerActor) => !originFor(actor) && (ended.has(computerExecutionKey(actor.execution)) || Boolean(actor.execution.work.runtime === 'pi' && actor.rootExecution && ended.has(computerExecutionKey(actor.rootExecution))));
  const fenceKeys = (actor: ComputerActor, desktopId?: string) => { const keys = [roundKey(actor), `execution:${actorKey(actor)}`]; return desktopId ? [...keys, ...keys.map(key => `${key}\0${desktopId}`)] : keys; };
  const sameFamily = (left: ComputerActor, right: ComputerActor) => originFor(left) === originFor(right) && sameComputerWork(left.rootWork, right.rootWork);
  const scopeFor = (actor: ComputerActor): ComputerWorkScope => ({ work: actor.execution.work, rootWork: actor.rootWork,
    currentExecution: actor.execution, currentRootExecution: actor.rootExecution });
  const cleanupsFor = (scope: ComputerWorkScope): ComputerCleanup[] => {
    const result = new Map<string, ComputerCleanup>();
    const add = (actor: ComputerActor, desktopId: string | undefined, status: ComputerCleanup['status']) => {
      if (originFor(actor) || !sameComputerWork(actor.rootWork, scope.rootWork)) return;
      const execution = actor.execution;
      result.set(JSON.stringify([computerExecutionKey(execution), desktopId ?? null]), { execution, ...(desktopId ? { desktopId } : {}), status });
    };
    for (const actor of lastActors.values()) {
      const status = statusFor(actor);
      if (status) add(actor, undefined, status);
    }
    for (const lease of leases.values()) {
      if (lease.actor.execution.work.runtime === 'pi' ? !scope.currentRootExecution || !lease.actor.rootExecution || !sameComputerExecution(lease.actor.rootExecution, scope.currentRootExecution) : ended.has(computerExecutionKey(lease.actor.execution)) || sameComputerWork(lease.actor.execution.work, scope.work) && (!scope.currentExecution || !sameComputerExecution(lease.actor.execution, scope.currentExecution))) add(lease.actor, lease.desktopId, 'cancel-unconfirmed');
    }
    for (const lease of failedReleases.values()) add(lease.actor, lease.desktopId, 'cancel-unconfirmed');
    for (const { lease } of releasing.values()) add(lease.actor, lease.desktopId, 'cancelling');
    for (const entry of options.pendingReleases?.() ?? []) add(entry.actor, entry.desktopId, 'cancel-unconfirmed');
    return [...result.values()];
  };
  const stateFor = (actor: ComputerActor, scope = scopeFor(actor)): ComputerAutomationState => {
    const cleanups = cleanupsFor(scope);
    const current = scope.currentRootExecution;
    const currentRound = (candidate: ComputerActor) => !originFor(candidate) && sameComputerWork(candidate.rootWork, scope.rootWork)
      && (candidate.execution.work.runtime === 'agent' ? !hasEnded(candidate) && (!sameComputerWork(candidate.execution.work, scope.work) || Boolean(scope.currentExecution && sameComputerExecution(candidate.execution, scope.currentExecution))) : current ? Boolean(candidate.rootExecution && sameComputerExecution(candidate.rootExecution, current)) : candidate.rootExecution === null);
    const currentLeases = [...leases.values()].filter(lease => currentRound(lease.actor));
    const currentRequests = [...requests.values()].filter(request => sameComputerWork(request.actor.rootWork, scope.rootWork)
      && (request.status === 'granted' && currentRound(request.actor) || request.status === 'pending' && !hasEnded(request.actor)));
    return { ...scope, active: currentLeases.length > 0 || currentRequests.some(request => request.status === 'pending') || cleanups.length > 0,
      status: cleanups.some(cleanup => cleanup.status === 'cancelling') ? 'cancelling' : cleanups.length ? 'cancel-unconfirmed' : 'enabled',
      leases: currentLeases, requests: currentRequests, cleanups };
  };
  const invalidate = (work: ComputerWorkRef) => {
    // Projection consumers read their own current state; no request body or result is cached here.
    try { options.onInvalidate?.(work); } catch { /* presentation does not authorize operations */ }
  };
  const publish = (actor: ComputerActor) => {
    lastActors.set(actorKey(actor), actor);
    if (originFor(actor)) return;
    if (actor.execution.work.runtime === 'agent') { invalidate(actor.rootWork); return; }
    try { options.onChange(structuredClone(stateFor(actor))); } catch { /* presentation does not authorize operations */ }
  };
  const wake = (id: string) => { for (const listener of waiters.get(id) ?? []) listener(); };
  const resolve = async (work: ComputerWorkRef, desktopId?: string, started = ++admissionSequence, expected?: ComputerExecutionRef) => {
    const actor = await options.resolveActor(work);
    if (!actor || hasEnded(actor) || expected && !sameComputerExecution(actor.execution, expected)) throw new HarnessServiceError('forbidden', 'Computer Use requires a live authorized Thread/Run');
    if (started <= Math.max(...fenceKeys(actor, desktopId).map(key => cancelledThrough.get(key) ?? 0))) throw new HarnessServiceError('unavailable', 'This computer operation was cancelled before admission');
    lastActors.set(actorKey(actor), actor);
    return actor;
  };
  const assertRound = (actor: ComputerActor, desktopId?: string) => {
    if (hasEnded(actor)) throw new HarnessServiceError('forbidden', 'This Computer Use execution ended; old bindings cannot resume');
    if (fenceKeys(actor, desktopId).some(key => cancellationState.get(key) === 'cancelling')) {
      throw new HarnessServiceError('unavailable', 'The previous computer operation is still releasing input');
    }
  };
  const owner = (desktopId: string) => [...leases.values()].find(lease => lease.desktopId === desktopId && lease.access === 'control');
  const issue = async (actor: ComputerActor, desktopId: string, access: ComputerAccess, assignmentId?: string) => {
    assertRound(actor, desktopId);
    if (access === 'control') {
      if ((actor.roleAccess.kind === 'pi-role' && actor.roleAccess.readOnly)) throw new HarnessServiceError('forbidden', 'This retrieval/discussion thread can only observe assigned desktops');
      if (transfers.has(desktopId) || unconfirmed.has(desktopId) || !options.controlAvailable(desktopId)) throw new HarnessServiceError('forbidden', 'Desktop control is changing, held by a human, or its previous input release is unconfirmed');
      const holder = owner(desktopId);
      if (holder && actorKey(holder.actor) !== actorKey(actor)) throw new HarnessServiceError('forbidden', `Desktop is reserved by ${holder.actor.label}; the main thread must coordinate its release first`);
      if (holder) { if (assignmentId && holder.id !== assignmentId) throw new HarnessServiceError('forbidden', 'Release the existing assignment before granting another request'); await ready.get(holder.id); return holder; }
    }
    const same = [...leases.values()].find(lease => lease.desktopId === desktopId && actorKey(lease.actor) === actorKey(actor) && lease.access === access);
    if (same) { if (assignmentId && same.id !== assignmentId) throw new HarnessServiceError('forbidden', 'An existing assignment belongs to a different request'); await ready.get(same.id); return same; }
    const lease: ComputerLease = { id: assignmentId ?? randomUUID(), desktopId, actor, access, grantedAt: new Date().toISOString() };
    leases.set(lease.id, lease);
    const abort = new AbortController(); reservationAborts.set(lease.id, abort);
    const reservation = Promise.resolve().then(() => options.reserve?.(lease, abort.signal)); ready.set(lease.id, reservation);
    try { await reservation; assertRound(actor, desktopId); if (leases.get(lease.id) !== lease) throw new HarnessServiceError('forbidden', 'Desktop assignment was revoked during admission'); }
    catch (error) { await removeLease(lease).catch(() => undefined); throw error; }
    reservationAborts.delete(lease.id); publish(actor); return lease;
  };
  const authorize = async <T>(work: ComputerWorkRef, access: ComputerAccess, desktopId: string | undefined, run: () => Promise<T>, expected?: ComputerExecutionRef): Promise<T> => {
    const sequence = context.getStore()?.sequence ?? ++admissionSequence;
    const actor = await resolve(work, desktopId, sequence, expected);
    assertRound(actor, desktopId);
    if (access === 'control' && (actor.roleAccess.kind === 'pi-role' && actor.roleAccess.readOnly)) throw new HarnessServiceError('forbidden', 'This thread has read-only Computer Use access');
    let lease: ComputerLease | undefined;
    if (!rootActor(actor) && (desktopId || access === 'control')) {
      lease = [...leases.values()].find(item => item.desktopId === desktopId && actorKey(item.actor) === actorKey(actor)
        && roundKey(item.actor) === roundKey(actor) && (item.access === 'control' || access === 'observe'));
      if (!lease || pendingAssignments.has(lease.id) || (access === 'control' && lease.access !== 'control')) throw new HarnessServiceError('forbidden', actor.execution.work.runtime === 'agent'
        ? 'assignment-unavailable: Request a desktop assignment with computer_request, then explicitly computer_wait if you need its decision before continuing'
        : 'Request a desktop assignment from the main thread with computer.request before using Computer Use');
    } else if (desktopId) lease = await issue(actor, desktopId, access);
    const abort = new AbortController();
    const id = randomUUID();
    const admission: ComputerAdmission = {
      actor, ...(lease ? { lease } : {}), sequence, key: JSON.stringify([actorKey(actor), fenceKeys(actor, desktopId).map(key => revisions.get(key) ?? 0)]), signal: abort.signal,
      cancel: reason => abort.abort(reason),
      assert() {
        assertRound(actor, desktopId); abort.signal.throwIfAborted();
        if (lease && leases.get(lease.id) !== lease) throw new HarnessServiceError('forbidden', 'The desktop assignment was released or transferred; request a new assignment and observe the current scene');
      },
    };
    controllers.set(id, { actor, abort, access, ...(desktopId ? { desktopId } : {}) });
    try { const result = await context.run(admission, run); if (access === 'observe') admission.assert(); return result; }
    finally { controllers.delete(id); }
  };
  const removeLease = async (lease: ComputerLease) => {
    const pending = releasing.get(lease.id);
    if (pending) return pending.promise;
    if (!leases.has(lease.id) && !failedReleases.has(lease.id)) return;
    const release = Promise.resolve().then(async () => {
      reservationAborts.get(lease.id)?.abort(new Error('Desktop assignment was revoked'));
      reservationAborts.delete(lease.id);
      const reservation = ready.get(lease.id);
      leases.delete(lease.id); pendingAssignments.delete(lease.id);
      ready.delete(lease.id);
      for (const request of requests.values()) if (request.desktopId === lease.desktopId && actorKey(request.actor) === actorKey(lease.actor) && request.status === 'granted') { request.status = 'released'; request.revision += 1; wake(request.id); }
      publish(lease.actor);
      foreign.delete(lease.id);
      if (lease.access === 'control') transfers.add(lease.desktopId);
      try {
        await reservation?.catch(() => undefined);
        if (!(await context.exit(() => options.release(lease))).released) throw new ComputerReleaseUnconfirmed();
        releasedAssignments.add(lease.id); failedReleases.delete(lease.id); if (lease.access === 'control') unconfirmed.delete(lease.desktopId);
      }
      catch (error) { failedReleases.set(lease.id, lease); if (lease.access === 'control') unconfirmed.add(lease.desktopId); throw error; }
      finally { if (lease.access === 'control') transfers.delete(lease.desktopId); }
    });
    releasing.set(lease.id, { lease, promise: release });
    try { await release; } finally { if (releasing.get(lease.id)?.promise === release) releasing.delete(lease.id); }
  };
  const accessRequest = async (work: ComputerWorkRef, desktopId: string, access: ComputerAccess, reason: string): Promise<ComputerAccessRequest> => {
    const sequence = ++admissionSequence;
    const actor = await resolve(work, desktopId, sequence); assertRound(actor, desktopId);
    if (work.runtime === 'agent') throw new HarnessServiceError('unavailable', 'Computer assignment requests are not connected for Agent executions');
    if ((actor.roleAccess.kind === 'pi-role' && actor.roleAccess.readOnly) && access === 'control') throw new HarnessServiceError('forbidden', 'Retrieval/discussion threads can request observation only');
    if (!reason.trim()) throw new HarnessServiceError('invalid-params', 'Describe the work requiring this desktop');
    const pending = [...requests.values()].find(request => actorKey(request.actor) === actorKey(actor) && request.desktopId === desktopId && request.access === access && request.status === 'pending');
    if (pending) return structuredClone(pending);
    const desktopLabel = await options.describeDesktop?.(desktopId);
    await resolve(work, desktopId, sequence); assertRound(actor, desktopId);
    const request: ComputerAccessRequest = { id: randomUUID(), desktopId, actor, access, reason, status: 'pending', revision: 1, createdAt: new Date().toISOString(), ...(desktopLabel ? { desktopLabel } : {}) };
    requests.set(request.id, request); publish(actor);
    try {
      await options.notify(actor, `Computer Use request ${request.id} from ${actor.label}: ${access} access to desktop ${desktopId}. Task: ${reason}\nCoordinate the desktop and decide with computer.grant or computer.deny using this requestId.`, true, request.id, 'root');
    } catch (error) { requests.delete(request.id); publish(actor); throw error; }
    return structuredClone(request);
  };
  const decide = async (work: ComputerWorkRef, requestId: string, approved: boolean, detail?: string) => {
    const manager = await resolve(work); assertRound(manager);
    if (work.runtime === 'agent') throw new HarnessServiceError('unavailable', 'Computer assignment decisions are not connected for Agent executions');
    if (!rootActor(manager) || (manager.roleAccess.kind === 'pi-role' && manager.roleAccess.readOnly)) throw new HarnessServiceError('forbidden', 'Only the main thread can decide desktop requests');
    const request = requests.get(requestId);
    if (!request || !sameComputerWork(request.actor.rootWork, manager.execution.work)) throw new HarnessServiceError('not-found', 'Desktop request does not belong to this task family');
    if (request.status !== 'pending') return structuredClone(request);
    if (approved) {
      const target = await resolve(request.actor.execution.work);
      if (!sameComputerExecution(target.execution, request.actor.execution) || !sameComputerWork(target.rootWork, manager.execution.work)) throw new HarnessServiceError('forbidden', 'The requesting execution ended or changed');
      const holder = owner(request.desktopId);
      if (request.access === 'control' && holder && actorKey(holder.actor) === actorKey(manager)) await removeLease(holder);
      const lease = await issue({ ...target, rootExecution: manager.execution }, request.desktopId, request.access);
      try {
        await options.bindDesktop(target, request.desktopId); assertRound(lease.actor, request.desktopId);
        if (request.status !== 'pending' || leases.get(lease.id) !== lease) throw new HarnessServiceError('unavailable', 'The desktop request was cancelled during assignment');
      }
      catch (error) { await removeLease(lease); throw error; }
      request.actor = lease.actor;
    }
    request.status = approved ? 'granted' : 'denied'; request.revision += 1;
    if (detail) request.detail = detail;
    publish(manager); wake(request.id);
    await options.notify(request.actor, approved ? `Computer Use request ${request.id} granted: ${request.access} on ${request.desktopId}. Observe the current scene before acting. Release the assignment when this work segment is complete.`
      : `Computer Use request ${request.id} denied${detail ? `: ${detail}` : ''}. Continue other work or coordinate with the main thread.`, false, `decision:${request.id}`);
    return structuredClone(request);
  };
  const wait = async (work: ComputerWorkRef, requestId: string, signal: AbortSignal) => {
    const actor = await resolve(work);
    const request = requests.get(requestId);
    if (!request || actorKey(request.actor) !== actorKey(actor)) throw new HarnessServiceError('not-found', 'This execution did not create that request');
    if (request.status !== 'pending') return structuredClone(request);
    await new Promise<void>((resolveWait, reject) => {
      const finish = () => { cleanup(); resolveWait(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => { waiters.get(requestId)?.delete(finish); signal.removeEventListener('abort', abort); };
      const set = waiters.get(requestId) ?? new Set(); set.add(finish); waiters.set(requestId, set);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (request.status !== 'pending') finish();
    });
    return structuredClone(request);
  };
  const release = async (work: ComputerWorkRef, desktopId?: string) => {
    const actor = await resolve(work);
    const own = cleanupLeases().filter(lease => (actorKey(lease.actor) === actorKey(actor)
      || rootActor(actor) && sameFamily(lease.actor, actor)) && (!desktopId || lease.desktopId === desktopId));
    for (const lease of own) await removeLease(lease);
  };
  const cancelWork = async (actor: ComputerActor, desktopId?: string, exact = false) => {
    const key = exact ? `execution:${actorKey(actor)}${desktopId ? `\0${desktopId}` : ''}` : workKey(actor, desktopId);
    const accepted = [...cleanupLeases(), ...controllers.values(), ...(options.pendingReleases?.() ?? []), ...(options.pendingControlFacts?.() ?? [])];
    const captured = new Set(accepted.filter(entry => actor.execution.work.runtime === 'agent' && rootActor(actor) && sameFamily(entry.actor, actor)).map(entry => actorKey(entry.actor)));
    const belongs = (candidate: ComputerActor, target?: string) => (exact ? actorKey(candidate) === actorKey(actor) : actor.execution.work.runtime === 'agent' ? actorKey(candidate) === actorKey(actor) || captured.has(actorKey(candidate)) : roundKey(candidate) === roundKey(actor)) && (!desktopId || target === desktopId);
    const ongoing = cancellations.get(key);
    if (ongoing) return ongoing;
    const cancellationId = randomUUID();
    cancelledThrough.set(key, admissionSequence);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    cancellationState.set(key, 'cancelling');
    // Fence only executions captured by this Stop. New work segments in the same Run remain allowed.
    for (const candidate of accepted) if (belongs(candidate.actor, candidate.desktopId)) {
      const ownKey = `execution:${actorKey(candidate.actor)}${desktopId ? `\0${desktopId}` : ''}`;
      cancelledThrough.set(ownKey, admissionSequence); revisions.set(ownKey, (revisions.get(ownKey) ?? 0) + 1);
    }
    const requestCancellation = actor.execution.work.runtime === 'agent' ? nativeRequests?.cancel(actor, desktopId, !exact && rootActor(actor)) : undefined;
    const affected = cleanupLeases().filter(lease => belongs(lease.actor, lease.desktopId));
    const desktopsFor = (recipient: ComputerActor) => [...new Set(accepted.filter(entry => belongs(entry.actor, entry.desktopId)
      && actorKey(entry.actor) === actorKey(recipient)).flatMap(entry => entry.desktopId ? [entry.desktopId] : []))];
    const participants = accepted.filter(entry => belongs(entry.actor, entry.desktopId)).map(entry => entry.actor);
    const recipients = new Map([[actorKey(actor), actor], ...participants.map(caller => [actorKey(caller), caller] as const)]);
    for (const { actor: caller, abort, desktopId: target } of controllers.values()) if (belongs(caller, target)) abort.abort(new Error('User cancelled the current computer work'));
    for (const request of requests.values()) if (belongs(request.actor, request.desktopId) && request.status === 'pending') { request.status = 'denied'; request.revision += 1; request.detail = 'User cancelled the current computer work'; recipients.set(actorKey(request.actor), request.actor); wake(request.id); }
    publish(actor);
    const cancelled = (async () => {
      // Original physical cleanup starts independently of Catalog cancellation or identity reads.
      // Drain live leases first, then retry only the already-captured physical marker owners.
      const physical = (async () => {
        const leases = affected.map(removeLease);
        const owners = options.cancelWork ? (actor.execution.work.runtime === 'agent' ? [...recipients.values()] : [actor])
          .map(recipient => options.cancelWork!(recipient, desktopsFor(recipient), cancellationId)) : [];
        return Promise.allSettled([...leases, ...owners]);
      })();
      const metadata = Promise.allSettled([
        ...(requestCancellation ? [requestCancellation] : []),
        ...[...new Map(participants.map(participant => [actorKey(participant), participant])).values()].map(async recipient => {
          if (await isCurrent(recipient)) await options.revokeSession(recipient, desktopsFor(recipient));
        }),
      ]);
      const results = [...await physical, ...await metadata];
      const unconfirmed = results.some(result => result.status === 'rejected');
      cancellations.delete(key);
      if (unconfirmed) cancellationState.set(key, 'cancel-unconfirmed');
      else cancellationState.delete(key);
      publish(actor);
      const notices = await Promise.allSettled([...recipients.values()].map(async recipient => {
        if (recipient.execution.work.runtime === 'agent') {
          const desktopIds = desktopsFor(recipient);
          if (options.notifyCancelled) await options.notifyCancelled(recipient, desktopIds, cancellationId);
          return;
        }
        if (!await isCurrent(recipient)) return;
        await options.notify(recipient,
          `The user manually cancelled the current computer work. ${unconfirmed ? 'Input release has not been confirmed.' : 'The work was cancelled; already-dispatched actions may have left partial effects.'} Computer Use permissions are unchanged.`,
          false, `cancel:${cancellationId}:${computerExecutionKey(recipient.execution)}`);
      }));
      if (notices.some(result => result.status === 'rejected')) throw new HarnessServiceError('unavailable', 'Computer work was cancelled, but its notification could not be delivered');
      return stateFor(actor);
    })();
    cancellations.set(key, cancelled);
    try { return await cancelled; } finally { if (cancellations.get(key) === cancelled) cancellations.delete(key); }
  };
  const stop = async (execution: ComputerExecutionRef, desktopId?: string) => {
    // Accepted cleanup does not need a working Catalog channel to start physical stopping.
    const accepted = cleanupLeases().filter(lease => !desktopId || lease.desktopId === desktopId).map(lease => lease.actor);
    accepted.push(...[...controllers.values()].filter(entry => !desktopId || entry.desktopId === desktopId).map(entry => entry.actor));
    accepted.push(...(options.pendingReleases?.() ?? []).filter(entry => !desktopId || entry.desktopId === desktopId).map(entry => entry.actor));
    accepted.push(...(options.pendingControlFacts?.() ?? []).filter(entry => !desktopId || entry.desktopId === desktopId).map(entry => entry.actor));
    accepted.push(...[...lastActors.values()].filter(actor => Boolean(statusFor(actor, desktopId))));
    let actor = accepted.find(candidate => !originFor(candidate) && sameComputerExecution(candidate.execution, execution));
    if (!actor) {
      const scope = await options.resolveScope(execution.work);
      if (!scope) throw new ComputerError('computer-work-not-found', 'The selected Computer Use work no longer exists; reopen the conversation');
      actor = (options.pendingControlFacts?.() ?? []).find(entry => (!desktopId || entry.desktopId === desktopId) && sameComputerExecution(entry.actor.execution, execution))?.actor;
      if (!actor) {
        const current = await options.resolveActor(execution.work);
        if (current && sameComputerExecution(current.execution, execution)) actor = current;
      }
    }
    if (!actor) throw new ComputerError('computer-execution-stale', 'This execution has no remaining Computer Use cleanup; refresh the conversation before stopping its current Run');
    await cancelWork(actor, desktopId, !rootActor(actor));
    return snapshot(execution.work);
  };
  const finishRun = async (execution: ComputerExecutionRef) => {
    ended.add(computerExecutionKey(execution));
    const belongs = (actor: ComputerActor) => !originFor(actor) && (sameComputerExecution(actor.execution, execution)
      || Boolean(actor.execution.work.runtime === 'pi' && actor.rootExecution && sameComputerExecution(actor.rootExecution, execution)));
    const capturedLeases = cleanupLeases().filter(lease => belongs(lease.actor));
    // After restart the original physical owner may survive without a live
    // lease. Reuse its exact Stop callback; absence of an in-memory lease is
    // not a release receipt and must not make Bot Sleep succeed.
    const pendingOwners = new Map<string, { actor: ComputerActor; desktops: Set<string> }>();
    for (const pending of options.pendingReleases?.() ?? []) {
      if (!belongs(pending.actor) || capturedLeases.some(lease => lease.desktopId === pending.desktopId
        && sameComputerExecution(lease.actor.execution, pending.actor.execution))) continue;
      const key = actorKey(pending.actor);
      const owner = pendingOwners.get(key) ?? { actor: pending.actor, desktops: new Set<string>() };
      owner.desktops.add(pending.desktopId); pendingOwners.set(key, owner);
    }
    for (const { actor, abort } of controllers.values()) if (belongs(actor)) abort.abort(new Error('Computer Use execution ended'));
    for (const request of requests.values()) if (belongs(request.actor) && request.status === 'pending') { request.status = 'denied'; request.revision += 1; request.detail = 'Execution ended'; wake(request.id); }
    const results = await Promise.allSettled([
      ...(execution.work.runtime === 'agent' ? [...lastActors.values()].filter(actor => sameComputerExecution(actor.execution, execution)).map(actor => nativeRequests?.cancel(actor, undefined, false)) : []),
      ...capturedLeases.map(removeLease),
      ...[...pendingOwners.values()].map(owner => options.cancelWork
        ? options.cancelWork(owner.actor, [...owner.desktops], `finish:${computerExecutionKey(execution)}`)
        : Promise.reject(new ComputerReleaseUnconfirmed())),
      ...[...lastActors.values()].filter(belongs).map(actor => options.revokeSession(actor)),
    ]);
    for (const actor of lastActors.values()) if (belongs(actor)) {
      if (results.some(result => result.status === 'rejected')) cancellationState.set(roundKey(actor), 'cancel-unconfirmed');
      else if (!(options.pendingReleases?.() ?? []).some(entry => belongs(entry.actor))) cancellationState.delete(roundKey(actor));
      publish(actor);
    }
    if (results.some(result => result.status === 'rejected')) throw new HarnessServiceError('unavailable', 'Computer Use execution ended, but resource release was not confirmed');
  };
  const isCurrent = async (actor: ComputerActor) => {
    if (originFor(actor)) return false;
    const current = await options.resolveActor(actor.execution.work);
    return Boolean(current && sameComputerExecution(current.execution, actor.execution) && !hasEnded(actor));
  };
  const snapshot = async (work: ComputerWorkRef): Promise<ComputerAutomationState> => {
    const scope = await options.resolveScope(work);
    if (!scope) throw new ComputerError('computer-work-not-found', 'The selected Computer Use work no longer exists; reopen the conversation');
    const actor = await options.resolveActor(work) ?? [...lastActors.values()].find(actor => !originFor(actor) && sameComputerWork(actor.rootWork, scope.rootWork));
    const cleanups = cleanupsFor(scope);
    const state: ComputerAutomationState = actor ? structuredClone(stateFor(actor, scope))
      : { ...scope, active: cleanups.length > 0, status: cleanups.length ? 'cancel-unconfirmed' : 'enabled', leases: [], requests: [], cleanups };
    if (scope.work.runtime === 'agent' && nativeRequests) {
      state.requests = await nativeRequests.snapshot(scope);
      state.active ||= state.requests.some(request => request.status === 'pending' || request.status === 'granting');
    }
    return state;
  };
  return {
    attachRequests(authority: NonNullable<typeof nativeRequests>) { if (nativeRequests) throw new Error('Computer request authority already attached'); nativeRequests = authority; },
    assignment(id: string) { return leases.get(id); },
    assignmentState(id: string): 'active' | 'released' | 'unavailable' { return leases.has(id) ? 'active' : releasedAssignments.has(id) ? 'released' : 'unavailable'; },
    async grantRequest(execution: ComputerExecutionRef, rootWork: ComputerWorkRef, manager: ComputerExecutionRef | null, desktopId: string, access: ComputerAccess, assignmentId: string, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const target = await resolve(execution.work, desktopId, undefined, execution);
      if (!sameComputerWork(target.rootWork, rootWork) || sameComputerWork(target.execution.work, rootWork)) throw new HarnessServiceError('forbidden', 'Request belongs to another root work');
      signal?.throwIfAborted();
      const holder = owner(desktopId);
      if (access === 'control' && holder && sameComputerWork(holder.actor.execution.work, rootWork)) await removeLease(holder);
      signal?.throwIfAborted();
      pendingAssignments.add(assignmentId);
      const lease = await issue({ ...target, rootExecution: manager }, desktopId, access, assignmentId);
      return structuredClone(lease);
    },
    confirmRequest(assignmentId: string) { if (leases.has(assignmentId)) pendingAssignments.delete(assignmentId); },
    async releaseRequest(assignmentId: string) { const lease = leases.get(assignmentId) ?? failedReleases.get(assignmentId) ?? releasing.get(assignmentId)?.lease; if (lease) await removeLease(lease); },
    async manage<T>(work: ComputerWorkRef, expected: ComputerExecutionRef, task: (signal: AbortSignal) => Promise<T>, desktopId?: string): Promise<T> {
      const actor = await resolve(work, desktopId, undefined, expected); assertRound(actor);
      const abort = new AbortController(), id = randomUUID();
      controllers.set(id, { actor, abort, access: 'observe', ...(desktopId ? { desktopId } : {}) });
      try { return await task(abort.signal); } finally { controllers.delete(id); }
    },
    async cancelAssigned(work: ComputerWorkRef, execution: ComputerExecutionRef, desktopId: string) {
      const actor = await resolve(work, desktopId, undefined, execution);
      const controller = owner(desktopId)?.actor;
      if (controller && !(sameComputerExecution(controller.execution, execution) || rootActor(actor) && sameFamily(controller, actor))) throw new HarnessServiceError('forbidden', 'This work cannot cancel another desktop controller');
      if (!controller && !cleanupLeases().some(lease => lease.desktopId === desktopId && sameComputerExecution(lease.actor.execution, execution))) throw new HarnessServiceError('forbidden', 'This execution has no assignment to cancel');
      await cancelWork(actor, desktopId, !rootActor(actor));
    },
    context, invalidate, authorize, request: accessRequest, decide, wait, release, stop, finishRun, snapshot, isCurrent,
    async cancelDesktop(desktopId: string, captured?: ComputerActor) {
      const actor = owner(desktopId)?.actor ?? cleanupLeases().find(lease => lease.desktopId === desktopId)?.actor ?? captured;
      if (!actor) return;
      await cancelWork(actor, desktopId);
    },
    controller: (desktopId: string) => owner(desktopId)?.actor ?? null,
    acceptedExecutions(): ComputerExecutionRef[] {
      const actors = [...cleanupLeases(), ...controllers.values(), ...(options.pendingReleases?.() ?? [])].map(entry => entry.actor);
      return [...new Map(actors.filter(actor => !originFor(actor)).map(actor => [computerExecutionKey(actor.execution), actor.execution])).values()];
    },
    desktopFor(execution: ComputerExecutionRef) {
      const targets = [...new Set([...leases.values()].filter(lease => !originFor(lease.actor) && sameComputerExecution(lease.actor.execution, execution)).map(lease => lease.desktopId))];
      if (targets.length > 1) throw new HarnessServiceError('invalid-params', 'This execution has multiple desktop assignments; pass desktopId');
      return targets[0] ?? null;
    },
    cancellationStatus: statusFor,
    physicalReleaseConfirmed(actor: ComputerActor, desktopId: string) {
      return ![...failedReleases.values(), ...[...releasing.values()].map(entry => entry.lease), ...(options.pendingReleases?.() ?? [])]
        .some(entry => entry.desktopId === desktopId && sameComputerExecution(entry.actor.execution, actor.execution));
    },
    delegation: (lease: ComputerLease) => { const entry = delegationFor(lease.actor); return entry ? { origin: entry.origin, assignmentId: entry.assignmentId } : null; },
    setHumanControl(desktopId: string, human: boolean) {
      for (const lease of leases.values()) if (lease.desktopId === desktopId && lease.access === 'control') {
        lease.suspended = human; publish(lease.actor);
      }
    },
    async interruptDesktop(desktopId: string) {
      const actor = owner(desktopId)?.actor;
      const interrupted = [...controllers.values()].filter(entry => entry.desktopId === desktopId && entry.access === 'control').map(entry => computerExecutionKey(entry.actor.execution));
      for (const entry of controllers.values()) if (entry.desktopId === desktopId) entry.abort.abort(new Error('User took control of the desktop'));
      if (actor && await isCurrent(actor)) await options.revokeSession(actor, [desktopId]);
      return interrupted;
    },
    async notifyHandoff(actor: ComputerActor, text: string, id: string, deliveredByTool: readonly string[] = []) {
      const recipients = new Map([[actorKey(actor), actor]]);
      if (!rootActor(actor)) {
        const root = await options.resolveActor(actor.rootWork);
        if (root && actor.rootExecution && sameComputerExecution(root.execution, actor.rootExecution)) recipients.set(actorKey(root), root);
      }
      for (const recipient of recipients.values()) {
        if (recipient.execution.work.runtime !== 'pi' || deliveredByTool.includes(computerExecutionKey(recipient.execution))) continue;
        if (await isCurrent(recipient)) await options.notify(recipient, text, false, `${id}:${computerExecutionKey(recipient.execution)}`);
      }
    },
    resetDesktop(desktopId: string) {
      for (const lease of leases.values()) if (lease.desktopId === desktopId) {
        leases.delete(lease.id); foreign.delete(lease.id);
        for (const request of requests.values()) if (request.desktopId === desktopId && request.status === 'granted') { request.status = 'released'; request.revision += 1; wake(request.id); }
        publish(lease.actor);
      }
      unconfirmed.delete(desktopId);
      for (const [id, lease] of failedReleases) if (lease.desktopId === desktopId) failedReleases.delete(id);
    },
    /** Authenticated Host delegation shares the same physical desktop ownership as local Threads. */
    async claim(origin: string, assignmentId: string, actor: ComputerActor, desktopId: string, access: ComputerAccess) {
      const claimKey = JSON.stringify([origin, assignmentId]);
      if (revokedClaims.has(claimKey)) throw new HarnessServiceError('forbidden', 'The source Host revoked this desktop assignment');
      const identity = JSON.stringify([actor, desktopId, access]);
      const prior = peerClaims.get(claimKey);
      if (prior) { if (prior.identity !== identity) throw new HarnessServiceError('forbidden', 'Assignment identity changed'); return prior.ready; }
      const delegated = structuredClone(actor);
      const entry: { identity: string; origin: string; assignmentId: string; actor: ComputerActor; lease?: ComputerLease; ready: Promise<string> } = { identity, origin, assignmentId, actor: delegated, ready: Promise.resolve('') };
      peerClaims.set(claimKey, entry);
      entry.ready = issue(delegated, desktopId, access).then(async lease => {
        entry.lease = lease;
        if (revokedClaims.has(claimKey)) { await removeLease(lease); throw new HarnessServiceError('forbidden', 'The source Host revoked this desktop assignment'); }
        foreign.set(lease.id, lease); return lease.id;
      });
      return entry.ready;
    },
    async dropClaim(origin: string, assignmentId: string, actor: ComputerActor, desktopId: string, access: ComputerAccess) {
      const claimKey = JSON.stringify([origin, assignmentId]);
      const entry = peerClaims.get(claimKey);
      const identity = JSON.stringify([actor, desktopId, access]);
      if (entry && entry.identity !== identity) throw new HarnessServiceError('forbidden', 'Assignment identity changed');
      // A drop may reach this Host before a delayed claim packet. That exact assignment can never
      // become live afterwards; a fresh source lease has a different identity and remains usable.
      revokedClaims.add(claimKey);
      await entry?.ready.catch(() => undefined);
      if (entry?.lease) await removeLease(entry.lease);
    },
    async delegated<T>(token: string, desktopId: string, access: ComputerAccess, run: () => Promise<T>): Promise<T> {
      const lease = foreign.get(token);
      if (!lease || lease.desktopId !== desktopId || (access === 'control' && lease.access !== 'control')) throw new HarnessServiceError('forbidden', 'A live Host desktop assignment is required');
      const abort = new AbortController(); const id = randomUUID();
      const admission: ComputerAdmission = { actor: lease.actor, lease, sequence: ++admissionSequence, key: actorKey(lease.actor), signal: abort.signal, cancel: reason => abort.abort(reason), assert() {
        abort.signal.throwIfAborted(); if (foreign.get(token) !== lease || leases.get(token) !== lease) throw new HarnessServiceError('forbidden', 'The Host desktop assignment ended');
      } };
      controllers.set(id, { actor: lease.actor, abort, desktopId, access });
      try { admission.assert(); const result = await context.run(admission, run); if (access === 'observe') admission.assert(); return result; }
      finally { controllers.delete(id); }
    },
  };
}
