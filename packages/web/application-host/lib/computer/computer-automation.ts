import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ComputerAccess, ComputerAccessRequest, ComputerActor, ComputerAutomationState, ComputerLease } from '@varin/protocol';
import { HarnessServiceError } from '../harness/service-error.js';

export interface ComputerAdmission {
  actor: ComputerActor;
  key: string;
  signal: AbortSignal;
  assert(): void;
}

/** Live authorization over existing Thread/Run identities. No model or renderer owns this state. */
export function createComputerAutomation(options: {
  resolveActor(sessionId: string): Promise<ComputerActor | null>;
  reserve?(lease: ComputerLease, signal: AbortSignal): Promise<void>;
  describeDesktop?(desktopId: string): Promise<string>;
  release(lease: ComputerLease): Promise<{ released: boolean }>;
  controlAvailable(desktopId: string): boolean;
  notify(actor: ComputerActor, text: string, wake: boolean, id: string): Promise<void>;
  revokeSession(actor: ComputerActor): Promise<void>;
  bindDesktop(actor: ComputerActor, desktopId: string): Promise<void>;
  onChange(state: ComputerAutomationState): void;
}) {
  const context = new AsyncLocalStorage<ComputerAdmission>();
  const leases = new Map<string, ComputerLease>();
  const requests = new Map<string, ComputerAccessRequest>();
  const controllers = new Map<string, { actor: ComputerActor; abort: AbortController }>();
  const rounds = new Map<string, ComputerAutomationState['status']>();
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
  const peerClaims = new Map<string, { identity: string; lease?: ComputerLease; ready: Promise<string> }>();
  const revokedClaims = new Set<string>();
  const roundKey = (actor: ComputerActor) => `${actor.rootSessionId}:${actor.rootRunId}`;
  const actorKey = (actor: ComputerActor) => `${actor.sessionId}:${actor.runId}`;
  const stateFor = (actor: ComputerActor): ComputerAutomationState => ({
    rootSessionId: actor.rootSessionId, runId: actor.rootRunId,
    active: !ended.has(actor.rootRunId) && !actor.rootRunId.startsWith('idle:'),
    status: rounds.get(roundKey(actor)) ?? 'enabled',
    leases: [...leases.values()].filter(lease => roundKey(lease.actor) === roundKey(actor)),
    requests: [...requests.values()].filter(request => request.actor.rootSessionId === actor.rootSessionId
      && (roundKey(request.actor) === roundKey(actor) || request.status === 'pending' && !ended.has(request.actor.runId))),
  });
  const publish = (actor: ComputerActor) => {
    lastActors.set(actor.rootSessionId, actor);
    try { options.onChange(structuredClone(stateFor(actor))); } catch { /* presentation does not authorize operations */ }
  };
  const wake = (id: string) => { for (const listener of waiters.get(id) ?? []) listener(); };
  const resolve = async (sessionId: string) => {
    const actor = await options.resolveActor(sessionId);
    if (!actor || ended.has(actor.runId)) throw new HarnessServiceError('forbidden', 'Computer Use requires a live authorized Thread/Run');
    lastActors.set(actor.sessionId, actor);
    return actor;
  };
  const assertRound = (actor: ComputerActor) => {
    if (ended.has(actor.runId) || ended.has(actor.rootRunId)) throw new HarnessServiceError('forbidden', 'This Computer Use execution ended; old bindings cannot resume');
    if ((rounds.get(roundKey(actor)) ?? 'enabled') !== 'enabled') {
      throw new HarnessServiceError('forbidden', 'The user stopped Computer Use for this round. Continue with other authorized work; do not resume desktop automation until the next round.');
    }
  };
  const owner = (desktopId: string) => [...leases.values()].find(lease => lease.desktopId === desktopId && lease.access === 'control');
  const issue = async (actor: ComputerActor, desktopId: string, access: ComputerAccess) => {
    assertRound(actor);
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
    try { await reservation; assertRound(actor); if (leases.get(lease.id) !== lease) throw new HarnessServiceError('forbidden', 'Desktop assignment was revoked during admission'); }
    catch (error) { await removeLease(lease).catch(() => undefined); throw error; }
    reservationAborts.delete(lease.id); publish(actor); return lease;
  };
  const authorize = async <T>(sessionId: string, access: ComputerAccess, desktopId: string | undefined, run: () => Promise<T>): Promise<T> => {
    const actor = await resolve(sessionId);
    assertRound(actor);
    if (access === 'control' && actor.readOnly) throw new HarnessServiceError('forbidden', 'This thread has read-only Computer Use access');
    let lease: ComputerLease | undefined;
    if (actor.sessionId !== actor.rootSessionId && (desktopId || access === 'control')) {
      lease = [...leases.values()].find(item => item.desktopId === desktopId && actorKey(item.actor) === actorKey(actor)
        && item.actor.rootRunId === actor.rootRunId && (item.access === 'control' || access === 'observe'));
      if (!lease || (access === 'control' && lease.access !== 'control')) throw new HarnessServiceError('forbidden', 'Request a desktop assignment from the main thread with computer.request before using Computer Use');
    } else if (desktopId) lease = await issue(actor, desktopId, access);
    const abort = new AbortController();
    const id = randomUUID();
    const admission: ComputerAdmission = {
      actor, key: actorKey(actor), signal: abort.signal,
      assert() {
        assertRound(actor); abort.signal.throwIfAborted();
        if (lease && leases.get(lease.id) !== lease) throw new HarnessServiceError('forbidden', 'The desktop assignment was released or transferred; request a new assignment and observe the current scene');
      },
    };
    controllers.set(id, { actor, abort });
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
        if (!(await context.exit(() => options.release(lease))).released) throw new HarnessServiceError('unavailable', 'The previous desktop input release was not confirmed');
        failedReleases.delete(lease.id); if (lease.access === 'control') unconfirmed.delete(lease.desktopId);
      }
      catch (error) { failedReleases.set(lease.id, lease); if (lease.access === 'control') unconfirmed.add(lease.desktopId); throw error; }
      finally { if (lease.access === 'control') transfers.delete(lease.desktopId); }
    })();
    releasing.set(lease.id, release);
    try { await release; } finally { releasing.delete(lease.id); }
  };
  const accessRequest = async (sessionId: string, desktopId: string, access: ComputerAccess, reason: string): Promise<ComputerAccessRequest> => {
    const actor = await resolve(sessionId); assertRound(actor);
    if (actor.readOnly && access === 'control') throw new HarnessServiceError('forbidden', 'Retrieval/discussion threads can request observation only');
    if (!reason.trim()) throw new HarnessServiceError('invalid-params', 'Describe the work requiring this desktop');
    const pending = [...requests.values()].find(request => actorKey(request.actor) === actorKey(actor) && request.desktopId === desktopId && request.access === access && request.status === 'pending');
    if (pending) return structuredClone(pending);
    const desktopLabel = await options.describeDesktop?.(desktopId);
    assertRound(actor);
    const request: ComputerAccessRequest = { id: randomUUID(), desktopId, actor, access, reason, status: 'pending', createdAt: new Date().toISOString(), ...(desktopLabel ? { desktopLabel } : {}) };
    requests.set(request.id, request); publish(actor);
    try {
      await options.notify({ ...actor, sessionId: actor.rootSessionId }, `Computer Use request ${request.id} from ${actor.label}: ${access} access to desktop ${desktopId}. Task: ${reason}\nCoordinate the desktop and decide with computer.grant or computer.deny using this requestId.`, true, request.id);
    } catch (error) { requests.delete(request.id); publish(actor); throw error; }
    return structuredClone(request);
  };
  const decide = async (sessionId: string, requestId: string, approved: boolean, detail?: string) => {
    const manager = await resolve(sessionId); assertRound(manager);
    if (manager.sessionId !== manager.rootSessionId || manager.readOnly) throw new HarnessServiceError('forbidden', 'Only the main thread can decide desktop requests');
    const request = requests.get(requestId);
    if (!request || request.actor.rootSessionId !== manager.rootSessionId) throw new HarnessServiceError('not-found', 'Desktop request does not belong to this task family');
    if (request.status !== 'pending') return structuredClone(request);
    if (approved) {
      const target = await resolve(request.actor.sessionId);
      if (target.runId !== request.actor.runId || target.rootSessionId !== manager.rootSessionId) throw new HarnessServiceError('forbidden', 'The requesting execution ended or changed');
      const holder = owner(request.desktopId);
      if (request.access === 'control' && holder && actorKey(holder.actor) === actorKey(manager)) await removeLease(holder);
      const lease = await issue({ ...target, rootRunId: manager.runId }, request.desktopId, request.access);
      try { await options.bindDesktop(target, request.desktopId); assertRound(lease.actor); }
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
  const wait = async (sessionId: string, requestId: string, signal: AbortSignal) => {
    const actor = await resolve(sessionId);
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
  const release = async (sessionId: string, desktopId?: string) => {
    const actor = await resolve(sessionId);
    const own = [...leases.values()].filter(lease => (actorKey(lease.actor) === actorKey(actor)
      || actor.sessionId === actor.rootSessionId && lease.actor.rootSessionId === actor.rootSessionId) && (!desktopId || lease.desktopId === desktopId));
    for (const lease of own) await removeLease(lease);
  };
  const stop = async (sessionId: string) => {
    const actor = await resolve(sessionId);
    if (actor.sessionId !== actor.rootSessionId) throw new HarnessServiceError('forbidden', 'Stop the round through its main conversation');
    const key = roundKey(actor);
    rounds.set(key, 'stopping');
    const affected = [...leases.values(), ...failedReleases.values()].filter(lease => lease.actor.rootSessionId === actor.rootSessionId && lease.actor.rootRunId === actor.runId);
    const recipients = new Map([[actor.sessionId, actor], ...[...lastActors.values()].filter(caller => caller.rootSessionId === actor.rootSessionId
      && (roundKey(caller) === key || caller.rootRunId.startsWith('idle:')) && !ended.has(caller.runId)).map(caller => [caller.sessionId, caller] as const)]);
    for (const { actor: caller, abort } of controllers.values()) if (roundKey(caller) === key) abort.abort(new Error('User stopped Computer Use for this round'));
    for (const request of requests.values()) if (request.actor.rootSessionId === actor.rootSessionId && request.status === 'pending') { request.status = 'denied'; request.detail = 'User stopped Computer Use for this round'; wake(request.id); }
    publish(actor);
    const results = await Promise.allSettled([
      ...affected.map(removeLease), ...[...recipients.values()].map(recipient => options.revokeSession(recipient)),
    ]);
    rounds.set(key, results.some(result => result.status === 'rejected') ? 'stop-unconfirmed' : 'stopped'); publish(actor);
    const notices = await Promise.allSettled([...recipients.values()].map(recipient => options.notify(recipient,
      'The user stopped Computer Use for this round. Desktop access is revoked until this round ends; do not reacquire it or automate the GUI through another tool. Continue other authorized work. Existing applications and desktops remain open.', false, `stop:${key}:${recipient.sessionId}`)));
    if (notices.some(result => result.status === 'rejected')) throw new HarnessServiceError('unavailable', 'Computer Use is revoked, but a stop notification could not be delivered');
    return stateFor(actor);
  };
  const finishRun = async (runId: string) => {
    ended.add(runId);
    for (const { actor, abort } of controllers.values()) if (actor.runId === runId || actor.rootRunId === runId) abort.abort(new Error('Computer Use execution ended'));
    for (const request of requests.values()) if (request.actor.runId === runId || request.actor.rootRunId === runId) { if (request.status === 'pending') { request.status = 'denied'; request.detail = 'Execution ended'; wake(request.id); } }
    const results = await Promise.allSettled([
      ...[...leases.values(), ...failedReleases.values()].filter(lease => lease.actor.runId === runId || lease.actor.rootRunId === runId).map(removeLease),
      ...[...new Map([...lastActors.values()].filter(actor => actor.runId === runId || actor.rootRunId === runId).map(actor => [actor.sessionId, actor])).values()].map(actor => options.revokeSession(actor)),
    ]);
    const actor = [...lastActors.values()].find(actor => actor.rootRunId === runId);
    if (actor) { if (results.some(result => result.status === 'rejected')) rounds.set(roundKey(actor), 'stop-unconfirmed'); publish(actor); }
    if (results.some(result => result.status === 'rejected')) throw new HarnessServiceError('unavailable', 'Computer Use execution ended, but resource release was not confirmed');
  };
  return {
    context, authorize, request: accessRequest, decide, wait, release, stop, finishRun,
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
      const claimKey = `${origin}:${assignmentId}`;
      if (revokedClaims.has(claimKey)) throw new HarnessServiceError('forbidden', 'The source Host revoked this desktop assignment');
      const identity = JSON.stringify([actor.sessionId, actor.runId, actor.rootSessionId, actor.rootRunId, actor.readOnly, desktopId, access]);
      const prior = peerClaims.get(claimKey);
      if (prior) { if (prior.identity !== identity) throw new HarnessServiceError('forbidden', 'Assignment identity changed'); return prior.ready; }
      const namespace = (id: string) => `peer:${origin}:${id}`;
      const delegated = { ...actor, sessionId: namespace(actor.sessionId), rootSessionId: namespace(actor.rootSessionId), runId: namespace(actor.runId), rootRunId: namespace(actor.rootRunId) };
      const entry: { identity: string; lease?: ComputerLease; ready: Promise<string> } = { identity, ready: Promise.resolve('') };
      entry.ready = issue(delegated, desktopId, access).then(async lease => {
        entry.lease = lease;
        if (revokedClaims.has(claimKey)) { await removeLease(lease); throw new HarnessServiceError('forbidden', 'The source Host revoked this desktop assignment'); }
        foreign.set(lease.id, lease); return lease.id;
      });
      peerClaims.set(claimKey, entry);
      return entry.ready;
    },
    async dropClaim(origin: string, assignmentId: string, actor: ComputerActor, desktopId: string, access: ComputerAccess) {
      const claimKey = `${origin}:${assignmentId}`;
      const entry = peerClaims.get(claimKey);
      const identity = JSON.stringify([actor.sessionId, actor.runId, actor.rootSessionId, actor.rootRunId, actor.readOnly, desktopId, access]);
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
      const admission: ComputerAdmission = { actor: lease.actor, key: actorKey(lease.actor), signal: abort.signal, assert() {
        abort.signal.throwIfAborted(); if (foreign.get(token) !== lease || leases.get(token) !== lease) throw new HarnessServiceError('forbidden', 'The Host desktop assignment ended');
      } };
      controllers.set(id, { actor: lease.actor, abort });
      try { admission.assert(); const result = await context.run(admission, run); if (access === 'observe') admission.assert(); return result; }
      finally { controllers.delete(id); }
    },
    async snapshot(sessionId: string): Promise<ComputerAutomationState> {
      const actor = await options.resolveActor(sessionId) ?? lastActors.get(sessionId);
      return actor ? structuredClone(stateFor(actor)) : { rootSessionId: sessionId, runId: '', active: false, status: 'enabled', leases: [], requests: [] };
    },
  };
}
