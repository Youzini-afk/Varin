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
}

/** Live authorization over existing Thread/Run identities. No model or renderer owns this state. */
export function createComputerAutomation(options: {
  resolveActor(work: ComputerWorkRef): Promise<ComputerActor | null>;
  resolveScope(work: ComputerWorkRef): Promise<ComputerWorkScope | null>;
  pendingReleases?(): readonly { actor: ComputerActor; desktopId: string }[];
  reserve?(lease: ComputerLease, signal: AbortSignal): Promise<void>;
  describeDesktop?(desktopId: string): Promise<string>;
  release(lease: ComputerLease): Promise<{ released: boolean }>;
  controlAvailable(desktopId: string): boolean;
  notify(actor: ComputerActor, text: string, wake: boolean, id: string, recipient?: 'actor' | 'root'): Promise<void>;
  revokeSession(actor: ComputerActor): Promise<void>;
  bindDesktop(actor: ComputerActor, desktopId: string): Promise<void>;
  cancelWork?(actor: ComputerActor, desktopId?: string): Promise<void>;
  onChange(state: ComputerAutomationState): void;
}) {
  const context = new AsyncLocalStorage<ComputerAdmission>();
  const leases = new Map<string, ComputerLease>();
  const requests = new Map<string, ComputerAccessRequest>();
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
  const releasing = new Map<string, Promise<void>>();
  const failedReleases = new Map<string, ComputerLease>();
  const reservationAborts = new Map<string, AbortController>();
  const peerClaims = new Map<string, { identity: string; origin: string; assignmentId: string; actor: ComputerActor; lease?: ComputerLease; ready: Promise<string> }>();
  const revokedClaims = new Set<string>();
  const delegationFor = (actor: ComputerActor) => [...peerClaims.values()].find(entry => entry.actor === actor);
  const originFor = (actor: ComputerActor) => { const entry = delegationFor(actor); return entry ? JSON.stringify([entry.origin, entry.assignmentId]) : undefined; };
  const roundKey = (actor: ComputerActor) => JSON.stringify([originFor(actor) ?? null, actor.rootExecution ? computerExecutionKey(actor.rootExecution) : computerWorkKey(actor.rootWork)]);
  const workKey = (actor: ComputerActor, desktopId?: string) => desktopId ? `${roundKey(actor)}\0${desktopId}` : roundKey(actor);
  const statusFor = (actor: ComputerActor, desktopId?: string) => {
    const prefixes = [roundKey(actor), `execution:${actorKey(actor)}`];
    const values = [...cancellationState].filter(([key]) => prefixes.some(prefix => key === prefix || (desktopId ? key === `${prefix}\0${desktopId}` : key.startsWith(`${prefix}\0`)))).map(([, value]) => value);
    return values.includes('cancelling') ? 'cancelling' as const : values.includes('cancel-unconfirmed') ? 'cancel-unconfirmed' as const : undefined;
  };
  const actorKey = (actor: ComputerActor) => JSON.stringify([originFor(actor) ?? null, computerExecutionKey(actor.execution)]);
  const rootActor = (actor: ComputerActor) => sameComputerWork(actor.execution.work, actor.rootWork);
  const hasEnded = (actor: ComputerActor) => !originFor(actor) && (ended.has(computerExecutionKey(actor.execution)) || Boolean(actor.rootExecution && ended.has(computerExecutionKey(actor.rootExecution))));
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
      if (!scope.currentRootExecution || !lease.actor.rootExecution || !sameComputerExecution(lease.actor.rootExecution, scope.currentRootExecution)) add(lease.actor, lease.desktopId, 'cancel-unconfirmed');
    }
    for (const lease of failedReleases.values()) add(lease.actor, lease.desktopId, 'cancel-unconfirmed');
    for (const entry of options.pendingReleases?.() ?? []) add(entry.actor, entry.desktopId, 'cancel-unconfirmed');
    return [...result.values()];
  };
  const stateFor = (actor: ComputerActor, scope = scopeFor(actor)): ComputerAutomationState => {
    const cleanups = cleanupsFor(scope);
    const current = scope.currentRootExecution;
    const currentRound = (candidate: ComputerActor) => !originFor(candidate) && sameComputerWork(candidate.rootWork, scope.rootWork)
      && (current ? Boolean(candidate.rootExecution && sameComputerExecution(candidate.rootExecution, current)) : candidate.rootExecution === null);
    const currentLeases = [...leases.values()].filter(lease => currentRound(lease.actor));
    const currentRequests = [...requests.values()].filter(request => sameComputerWork(request.actor.rootWork, scope.rootWork)
      && (request.status === 'granted' && currentRound(request.actor) || request.status === 'pending' && !hasEnded(request.actor)));
    return { ...scope, active: currentLeases.length > 0 || currentRequests.some(request => request.status === 'pending') || cleanups.length > 0,
      status: cleanups.some(cleanup => cleanup.status === 'cancelling') ? 'cancelling' : cleanups.length ? 'cancel-unconfirmed' : 'enabled',
      leases: currentLeases, requests: currentRequests, cleanups };
  };
  const publish = (actor: ComputerActor) => {
    lastActors.set(actorKey(actor), actor);
    if (originFor(actor)) return;
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
  const issue = async (actor: ComputerActor, desktopId: string, access: ComputerAccess) => {
    assertRound(actor, desktopId);
    if (access === 'control') {
      if (actor.readOnly) throw new HarnessServiceError('forbidden', 'This retrieval/discussion thread can only observe assigned desktops');
      if (transfers.has(desktopId) || unconfirmed.has(desktopId) || !options.controlAvailable(desktopId)) throw new HarnessServiceError('forbidden', 'Desktop control is changing, held by a human, or its previous input release is unconfirmed');
      const holder = owner(desktopId);
      if (holder && actorKey(holder.actor) !== actorKey(actor)) throw new HarnessServiceError('forbidden', `Desktop is reserved by ${holder.actor.label}; the main thread must coordinate its release first`);
      if (holder) { await ready.get(holder.id); return holder; }
    }
    const same = [...leases.values()].find(lease => lease.desktopId === desktopId && actorKey(lease.actor) === actorKey(actor) && lease.access === access);
    if (same) { await ready.get(same.id); return same; }
    const lease: ComputerLease = { id: randomUUID(), desktopId, actor, access, grantedAt: new Date().toISOString() };
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
    if (access === 'control' && actor.readOnly) throw new HarnessServiceError('forbidden', 'This thread has read-only Computer Use access');
    let lease: ComputerLease | undefined;
    if (!rootActor(actor) && (desktopId || access === 'control')) {
      lease = [...leases.values()].find(item => item.desktopId === desktopId && actorKey(item.actor) === actorKey(actor)
        && roundKey(item.actor) === roundKey(actor) && (item.access === 'control' || access === 'observe'));
      if (!lease || (access === 'control' && lease.access !== 'control')) throw new HarnessServiceError('forbidden', actor.execution.work.runtime === 'agent'
        ? 'assignment-unavailable: Child Computer Use assignments are not connected; only catalog discovery is available'
        : 'Request a desktop assignment from the main thread with computer.request before using Computer Use');
    } else if (desktopId) lease = await issue(actor, desktopId, access);
    const abort = new AbortController();
    const id = randomUUID();
    const admission: ComputerAdmission = {
      actor, ...(lease ? { lease } : {}), sequence, key: JSON.stringify([actorKey(actor), fenceKeys(actor, desktopId).map(key => revisions.get(key) ?? 0)]), signal: abort.signal,
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
    if (pending) return pending;
    if (!leases.has(lease.id) && !failedReleases.has(lease.id)) return;
    const release = (async () => {
      reservationAborts.get(lease.id)?.abort(new Error('Desktop assignment was revoked'));
      reservationAborts.delete(lease.id);
      const reservation = ready.get(lease.id);
      leases.delete(lease.id);
      ready.delete(lease.id);
      for (const request of requests.values()) if (request.desktopId === lease.desktopId && actorKey(request.actor) === actorKey(lease.actor) && request.status === 'granted') { request.status = 'released'; wake(request.id); }
      publish(lease.actor);
      foreign.delete(lease.id);
      if (lease.access === 'control') transfers.add(lease.desktopId);
      try {
        await reservation?.catch(() => undefined);
        if (!(await context.exit(() => options.release(lease))).released) throw new ComputerReleaseUnconfirmed();
        failedReleases.delete(lease.id); if (lease.access === 'control') unconfirmed.delete(lease.desktopId);
      }
      catch (error) { failedReleases.set(lease.id, lease); if (lease.access === 'control') unconfirmed.add(lease.desktopId); throw error; }
      finally { if (lease.access === 'control') transfers.delete(lease.desktopId); }
    })();
    releasing.set(lease.id, release);
    try { await release; } finally { releasing.delete(lease.id); }
  };
  const accessRequest = async (work: ComputerWorkRef, desktopId: string, access: ComputerAccess, reason: string): Promise<ComputerAccessRequest> => {
    const sequence = ++admissionSequence;
    const actor = await resolve(work, desktopId, sequence); assertRound(actor, desktopId);
    if (work.runtime === 'agent') throw new HarnessServiceError('unavailable', 'Computer assignment requests are not connected for Agent executions');
    if (actor.readOnly && access === 'control') throw new HarnessServiceError('forbidden', 'Retrieval/discussion threads can request observation only');
    if (!reason.trim()) throw new HarnessServiceError('invalid-params', 'Describe the work requiring this desktop');
    const pending = [...requests.values()].find(request => actorKey(request.actor) === actorKey(actor) && request.desktopId === desktopId && request.access === access && request.status === 'pending');
    if (pending) return structuredClone(pending);
    const desktopLabel = await options.describeDesktop?.(desktopId);
    await resolve(work, desktopId, sequence); assertRound(actor, desktopId);
    const request: ComputerAccessRequest = { id: randomUUID(), desktopId, actor, access, reason, status: 'pending', createdAt: new Date().toISOString(), ...(desktopLabel ? { desktopLabel } : {}) };
    requests.set(request.id, request); publish(actor);
    try {
      await options.notify(actor, `Computer Use request ${request.id} from ${actor.label}: ${access} access to desktop ${desktopId}. Task: ${reason}\nCoordinate the desktop and decide with computer.grant or computer.deny using this requestId.`, true, request.id, 'root');
    } catch (error) { requests.delete(request.id); publish(actor); throw error; }
    return structuredClone(request);
  };
  const decide = async (work: ComputerWorkRef, requestId: string, approved: boolean, detail?: string) => {
    const manager = await resolve(work); assertRound(manager);
    if (work.runtime === 'agent') throw new HarnessServiceError('unavailable', 'Computer assignment decisions are not connected for Agent executions');
    if (!rootActor(manager) || manager.readOnly) throw new HarnessServiceError('forbidden', 'Only the main thread can decide desktop requests');
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
    request.status = approved ? 'granted' : 'denied';
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
    const own = [...leases.values()].filter(lease => (actorKey(lease.actor) === actorKey(actor)
      || rootActor(actor) && sameFamily(lease.actor, actor)) && (!desktopId || lease.desktopId === desktopId));
    for (const lease of own) await removeLease(lease);
  };
  const cancelWork = async (actor: ComputerActor, desktopId?: string, exact = false) => {
    const key = exact ? `execution:${actorKey(actor)}${desktopId ? `\0${desktopId}` : ''}` : workKey(actor, desktopId);
    const belongs = (candidate: ComputerActor, target?: string) => (exact ? actorKey(candidate) === actorKey(actor) : roundKey(candidate) === roundKey(actor)) && (!desktopId || target === desktopId);
    const ongoing = cancellations.get(key);
    if (ongoing) return ongoing;
    const cancellationId = randomUUID();
    cancelledThrough.set(key, admissionSequence);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
    cancellationState.set(key, 'cancelling');
    const affected = [...leases.values(), ...failedReleases.values()].filter(lease => belongs(lease.actor, lease.desktopId));
    const participants = [...affected.map(lease => lease.actor), ...[...controllers.values()].filter(entry => belongs(entry.actor, entry.desktopId)).map(entry => entry.actor)];
    const recipients = new Map([[actorKey(actor), actor], ...participants.map(caller => [actorKey(caller), caller] as const)]);
    for (const { actor: caller, abort, desktopId: target } of controllers.values()) if (belongs(caller, target)) abort.abort(new Error('User cancelled the current computer work'));
    for (const request of requests.values()) if (belongs(request.actor, request.desktopId) && request.status === 'pending') { request.status = 'denied'; request.detail = 'User cancelled the current computer work'; recipients.set(actorKey(request.actor), request.actor); wake(request.id); }
    publish(actor);
    const cancelled = (async () => {
      const results = await Promise.allSettled([
        ...affected.map(removeLease), ...[...new Map(participants.map(participant => [actorKey(participant), participant])).values()].map(async recipient => {
          if (await isCurrent(recipient)) await options.revokeSession(recipient);
        }),
      ]);
      if (options.cancelWork) results.push(...await Promise.allSettled([options.cancelWork(actor, desktopId)]));
      const unconfirmed = results.some(result => result.status === 'rejected');
      cancellations.delete(key);
      if (unconfirmed) cancellationState.set(key, 'cancel-unconfirmed');
      else cancellationState.delete(key);
      publish(actor);
      const notices = await Promise.allSettled([...recipients.values()].map(async recipient => {
        if (recipient.execution.work.runtime !== 'pi' || !await isCurrent(recipient)) return;
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
    const accepted = [...leases.values(), ...failedReleases.values()].filter(lease => !desktopId || lease.desktopId === desktopId).map(lease => lease.actor);
    accepted.push(...[...controllers.values()].filter(entry => !desktopId || entry.desktopId === desktopId).map(entry => entry.actor));
    accepted.push(...(options.pendingReleases?.() ?? []).filter(entry => !desktopId || entry.desktopId === desktopId).map(entry => entry.actor));
    accepted.push(...[...lastActors.values()].filter(actor => Boolean(statusFor(actor, desktopId))));
    let actor = accepted.find(candidate => !originFor(candidate) && sameComputerExecution(candidate.execution, execution));
    if (!actor) {
      const scope = await options.resolveScope(execution.work);
      if (!scope) throw new ComputerError('computer-work-not-found', 'The selected Computer Use work no longer exists; reopen the conversation');
      const current = await options.resolveActor(execution.work);
      if (current && sameComputerExecution(current.execution, execution)) actor = current;
    }
    if (!actor) throw new ComputerError('computer-execution-stale', 'This execution has no remaining Computer Use cleanup; refresh the conversation before stopping its current Run');
    await cancelWork(actor, desktopId, !rootActor(actor));
    return snapshot(execution.work);
  };
  const finishRun = async (execution: ComputerExecutionRef) => {
    ended.add(computerExecutionKey(execution));
    const belongs = (actor: ComputerActor) => !originFor(actor) && (sameComputerExecution(actor.execution, execution)
      || Boolean(actor.rootExecution && sameComputerExecution(actor.rootExecution, execution)));
    for (const { actor, abort } of controllers.values()) if (belongs(actor)) abort.abort(new Error('Computer Use execution ended'));
    for (const request of requests.values()) if (belongs(request.actor) && request.status === 'pending') { request.status = 'denied'; request.detail = 'Execution ended'; wake(request.id); }
    const results = await Promise.allSettled([
      ...[...leases.values(), ...failedReleases.values()].filter(lease => belongs(lease.actor)).map(removeLease),
      ...[...lastActors.values()].filter(belongs).map(actor => options.revokeSession(actor)),
    ]);
    for (const actor of lastActors.values()) if (belongs(actor)) {
      if (results.some(result => result.status === 'rejected')) cancellationState.set(roundKey(actor), 'cancel-unconfirmed');
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
    if (actor) return structuredClone(stateFor(actor, scope));
    const cleanups = cleanupsFor(scope);
    return { ...scope, active: cleanups.length > 0, status: cleanups.length ? 'cancel-unconfirmed' : 'enabled', leases: [], requests: [], cleanups };
  };
  return {
    context, authorize, request: accessRequest, decide, wait, release, stop, finishRun, snapshot, isCurrent,
    async cancelDesktop(desktopId: string) {
      const actor = owner(desktopId)?.actor ?? [...failedReleases.values()].find(lease => lease.desktopId === desktopId)?.actor;
      if (!actor) return;
      await cancelWork(actor, desktopId);
    },
    controller: (desktopId: string) => owner(desktopId)?.actor ?? null,
    acceptedExecutions(): ComputerExecutionRef[] {
      const actors = [...leases.values(), ...failedReleases.values(), ...controllers.values(), ...(options.pendingReleases?.() ?? [])].map(entry => entry.actor);
      return [...new Map(actors.filter(actor => !originFor(actor)).map(actor => [computerExecutionKey(actor.execution), actor.execution])).values()];
    },
    desktopFor(execution: ComputerExecutionRef) {
      const targets = [...new Set([...leases.values()].filter(lease => !originFor(lease.actor) && sameComputerExecution(lease.actor.execution, execution)).map(lease => lease.desktopId))];
      if (targets.length > 1) throw new HarnessServiceError('invalid-params', 'This execution has multiple desktop assignments; pass desktopId');
      return targets[0] ?? null;
    },
    cancellationStatus: statusFor,
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
      if (actor && await isCurrent(actor)) await options.revokeSession(actor);
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
        for (const request of requests.values()) if (request.desktopId === desktopId && request.status === 'granted') { request.status = 'released'; wake(request.id); }
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
      const admission: ComputerAdmission = { actor: lease.actor, lease, sequence: ++admissionSequence, key: actorKey(lease.actor), signal: abort.signal, assert() {
        abort.signal.throwIfAborted(); if (foreign.get(token) !== lease || leases.get(token) !== lease) throw new HarnessServiceError('forbidden', 'The Host desktop assignment ended');
      } };
      controllers.set(id, { actor: lease.actor, abort, desktopId, access });
      try { admission.assert(); const result = await context.run(admission, run); if (access === 'observe') admission.assert(); return result; }
      finally { controllers.delete(id); }
    },
  };
}
