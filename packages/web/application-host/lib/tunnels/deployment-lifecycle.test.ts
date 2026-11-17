import { describe, expect, it, vi } from 'vitest';

import {
  createDeploymentLifecycle,
  type DeploymentDriver,
  type DeploymentLifecycleOptions,
  type DeploymentOperationRequest,
  type DeploymentPlanInput,
  type DeploymentRecord,
  type DeploymentTarget,
  type RemoteDeploymentReceipt,
} from './deployment-lifecycle.js';

type Payload = { template: string; parameters: Record<string, string> };
const target: DeploymentTarget = { sshTargetId: 'vps-1', hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` };
const changedTarget: DeploymentTarget = { ...target, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}` };
const plan = (): DeploymentPlanInput<Payload> => ({
  action: 'deploy', target: { ...target }, payload: { template: 'debian-v1', parameters: { origin: 'https://example.test' } },
  steps: [{ id: 'frp', stage: 'install-frp' }, { id: 'entrypoint', stage: 'verify-entrypoint' }],
  resources: [
    { id: 'frps-service', kind: 'service', ownership: 'owned', action: 'create' },
    { id: 'caddy', kind: 'component', ownership: 'shared', action: 'reuse' },
  ],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 60; index += 1) await Promise.resolve(); };
function receipt(request: DeploymentOperationRequest<Payload>, patch: Partial<RemoteDeploymentReceipt> = {}): RemoteDeploymentReceipt {
  return {
    schemaVersion: 1, operationId: request.operationId, planDigest: request.planDigest, target: { ...request.target },
    sequence: 1, state: 'running', stopped: false,
    steps: request.plan.steps.map(({ id }, index) => ({ id, state: index === 0 ? 'running' : 'pending' })), resources: [], ...patch,
  };
}
function complete(request: DeploymentOperationRequest<Payload>, sequence = 2): RemoteDeploymentReceipt {
  return receipt(request, {
    sequence, state: 'completed', stopped: true, steps: request.plan.steps.map(({ id }) => ({ id, state: 'completed' })),
    resources: request.plan.resources.map(({ id, action }) => ({ id, result: ({ create: 'created', replace: 'updated', reuse: 'reused', remove: 'removed' } as const)[action] })),
  });
}
function fixture() {
  let stored: DeploymentRecord<Payload> = { schemaVersion: 1, revision: 0, preview: null, job: null };
  let remote: RemoteDeploymentReceipt | null = null;
  let operationNumber = 0;
  const requests: DeploymentOperationRequest<Payload>[] = [];
  const events: string[] = [];
  const storage = {
    read: vi.fn(async () => structuredClone(stored)),
    compareAndSwap: vi.fn(async (expectedRevision: number, candidate: DeploymentRecord<Payload>) => {
      if (expectedRevision !== stored.revision) return false;
      stored = structuredClone(candidate);
      events.push(`persist:${candidate.job?.state ?? 'preview'}`);
      return true;
    }),
  };
  const driver = {
    verifyTarget: vi.fn(async (_target: DeploymentTarget) => true),
    start: vi.fn(async (request: DeploymentOperationRequest<Payload>) => {
      requests.push(structuredClone(request));
      events.push('start');
      remote = receipt(request);
      return structuredClone(remote);
    }),
    reconcile: vi.fn<DeploymentDriver<Payload>['reconcile']>(async () => {
      events.push('reconcile');
      return structuredClone(remote);
    }),
    cancel: vi.fn<DeploymentDriver<Payload>['cancel']>(async () => {
      events.push('cancel');
      return structuredClone(remote);
    }),
  };
  const onStatus = vi.fn();
  const options: DeploymentLifecycleOptions<Payload> = {
    storage, driver, onStatus, createOperationId: () => `operation-${++operationNumber}`,
  };
  const lifecycle = createDeploymentLifecycle(options);
  const preview = async (input = plan()) => lifecycle.preview(input, stored.revision);
  const approve = async () => {
    const status = await preview();
    return lifecycle.approve({ expectedRevision: status.revision, planDigest: status.preview!.digest });
  };
  return { lifecycle, options, storage, driver, onStatus, requests, events, preview, approve,
    stored: () => structuredClone(stored), replace: (value: DeploymentRecord<Payload>) => { stored = structuredClone(value); },
    setRemote: (value: RemoteDeploymentReceipt | null) => { remote = structuredClone(value); } };
}

describe('durable deployment lifecycle', () => {
  it('previews a stable exact payload digest without starting SSH or exposing the payload', async () => {
    const f = fixture();
    const input = plan();
    input.payload.parameters = { z: 'last', a: 'private-material-not-for-status' };
    const first = await f.preview(input);
    input.payload.parameters.a = 'changed after preview';
    expect(f.stored().preview?.payload.parameters.a).toBe('private-material-not-for-status');
    const same = plan();
    same.payload.parameters = { a: 'private-material-not-for-status', z: 'last' };
    const second = await f.preview(same);
    expect(second.preview?.digest).toBe(first.preview?.digest);
    const changed = await f.preview(input);
    expect(changed.preview?.digest).not.toBe(first.preview?.digest);
    expect(JSON.stringify(f.onStatus.mock.calls)).not.toContain('private-material');
    expect(f.driver.verifyTarget).not.toHaveBeenCalled();
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it('requires the current revision, exact preview digest, and verified target', async () => {
    const f = fixture();
    const preview = await f.preview();
    await expect(f.lifecycle.approve({ expectedRevision: 0, planDigest: preview.preview!.digest })).rejects.toMatchObject({ code: 'revision_conflict' });
    await expect(f.lifecycle.approve({ expectedRevision: 1, planDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'approval_mismatch' });
    f.driver.verifyTarget.mockResolvedValueOnce(false);
    await expect(f.lifecycle.approve({ expectedRevision: 1, planDigest: preview.preview!.digest })).rejects.toMatchObject({ code: 'target_changed' });
    expect(f.driver.verifyTarget).toHaveBeenCalledWith(target);
    expect(f.stored()).toMatchObject({ revision: 1, job: null });
    expect(f.driver.start).not.toHaveBeenCalled();
    f.driver.verifyTarget.mockRejectedValueOnce(new Error('private key /secret/path'));
    await expect(f.lifecycle.approve({ expectedRevision: 1, planDigest: preview.preview!.digest })).rejects.toThrow('The SSH target');
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it('does not dispatch when another client changes the preview during target verification', async () => {
    const f = fixture();
    const preview = await f.preview();
    const verified = deferred<boolean>();
    f.driver.verifyTarget.mockImplementationOnce(() => verified.promise);
    const approving = f.lifecycle.approve({ expectedRevision: 1, planDigest: preview.preview!.digest });
    await flush();
    const other = createDeploymentLifecycle(f.options);
    const changed = plan();
    changed.payload.template = 'new-reviewed-template';
    await other.preview(changed, 1);
    verified.resolve(true);
    await expect(approving).rejects.toMatchObject({ code: 'revision_conflict' });
    await f.lifecycle.whenIdle();
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.stored().preview?.payload.template).toBe('new-reviewed-template');
  });

  it('persists acceptance before asynchronous dispatch and completes only from durable evidence', async () => {
    const f = fixture();
    const accepted = await f.approve();
    expect(accepted.state).toBe('queued');
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'running', operation: { stage: 'install-frp' } });
    expect(f.events.indexOf('persist:queued')).toBeLessThan(f.events.indexOf('start'));
    expect(f.requests[0]?.plan.digest).toBe(accepted.operation?.planDigest);
    f.setRemote(complete(f.requests[0]!));
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'completed', error: null });
    expect(f.driver.start).toHaveBeenCalledOnce();
    expect(f.driver.reconcile).toHaveBeenCalledOnce();
    await expect(f.preview()).resolves.toMatchObject({ state: 'preview' });
  });

  it('keeps unknown effects owned after disconnect and restart, without replaying them', async () => {
    const f = fixture();
    f.driver.start.mockRejectedValueOnce(new Error('token=secret stderr'));
    await f.approve();
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'connection_interrupted' } });
    await expect(f.preview()).rejects.toMatchObject({ code: 'operation_in_progress' });
    const restored = createDeploymentLifecycle(f.options);
    await restored.start();
    expect(await restored.whenIdle()).toMatchObject({ state: 'interrupted' });
    expect(f.driver.reconcile).toHaveBeenCalledOnce();
    expect(f.driver.start).toHaveBeenCalledOnce();
    expect(JSON.stringify(restored.getStatus())).not.toContain('secret');
  });

  it('recovers a lost completion acknowledgment by read-only reconciliation', async () => {
    const f = fixture();
    f.driver.start.mockImplementationOnce(async (request) => {
      f.setRemote(complete(request));
      throw new Error('SSH disconnected after remote commit');
    });
    await f.approve();
    await f.lifecycle.whenIdle();
    const restored = createDeploymentLifecycle(f.options);
    await restored.start();
    expect(await restored.whenIdle()).toMatchObject({ state: 'completed' });
    expect(f.driver.start).toHaveBeenCalledOnce();
  });

  it('does not dispatch a queued record recovered after a Host crash', async () => {
    const f = fixture();
    await f.preview();
    const record = f.stored();
    f.replace({ ...record, preview: null, job: {
      operationId: 'operation-before-crash', plan: record.preview!, state: 'queued', cancelRequested: false, receipt: null, error: null,
    } });
    await f.lifecycle.start();
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted' });
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.driver.reconcile).toHaveBeenCalledWith({ operationId: 'operation-before-crash', planDigest: record.preview!.digest, target });
  });

  it('requests cancellation during submission but never reports cancellation before actual stop', async () => {
    const f = fixture();
    const submission = deferred<RemoteDeploymentReceipt>();
    let request!: DeploymentOperationRequest<Payload>;
    f.driver.start.mockImplementationOnce(async (value) => { request = value; return submission.promise; });
    await f.approve();
    await flush();
    const cancelling = await f.lifecycle.cancel(f.stored().revision);
    expect(cancelling).toMatchObject({ state: 'cancelling', operation: { cancelRequested: true } });
    expect(f.driver.cancel).not.toHaveBeenCalled();
    const running = receipt(request, { sequence: 2,
      steps: [{ id: 'frp', state: 'completed' }, { id: 'entrypoint', state: 'running' }],
      resources: [{ id: 'frps-service', result: 'created' }],
    });
    f.setRemote(running);
    submission.resolve(running);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'cancelling', error: { code: 'stop_unconfirmed' } });
    await expect(f.preview()).rejects.toMatchObject({ code: 'operation_in_progress' });
    f.setRemote({ ...running, sequence: 3, state: 'stopped', stopped: true,
      steps: [{ id: 'frp', state: 'completed' }, { id: 'entrypoint', state: 'failed' }] });
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'cancelled', error: null,
      operation: { resources: [{ id: 'frps-service', result: 'created' }] } });
    expect(f.driver.start).toHaveBeenCalledOnce();
    expect(f.driver.cancel).toHaveBeenCalledOnce();
  });

  it('does not treat cancellation errors, absent receipts, or unproved stop as cancellation', async () => {
    const f = fixture();
    await f.approve();
    await f.lifecycle.whenIdle();
    f.driver.cancel.mockRejectedValueOnce(new Error('sensitive stderr'));
    await f.lifecycle.cancel(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'stop_unconfirmed' } });
    f.setRemote(null);
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted' });
    f.setRemote(receipt(f.requests[0]!, { sequence: 2, state: 'stopped', stopped: false }));
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'receipt_invalid' } });
    await expect(f.preview()).rejects.toMatchObject({ code: 'operation_in_progress' });
  });

  it('reports real completion, not cancellation, when completion wins the race', async () => {
    const f = fixture();
    const submission = deferred<RemoteDeploymentReceipt>();
    let request!: DeploymentOperationRequest<Payload>;
    f.driver.start.mockImplementationOnce(async (value) => { request = value; return submission.promise; });
    await f.approve();
    await flush();
    await f.lifecycle.cancel(f.stored().revision);
    submission.resolve(complete(request));
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'completed', operation: { cancelRequested: true } });
    expect(f.driver.cancel).not.toHaveBeenCalled();
  });

  it.each(['operation', 'digest', 'target', 'step', 'resource'] as const)('rejects a receipt with mismatched %s identity', async (mismatch) => {
    const f = fixture();
    await f.approve();
    await f.lifecycle.whenIdle();
    const result = complete(f.requests[0]!);
    if (mismatch === 'operation') result.operationId = 'another-operation';
    if (mismatch === 'digest') result.planDigest = '0'.repeat(64);
    if (mismatch === 'target') result.target = changedTarget;
    if (mismatch === 'step') result.steps[0]!.id = 'unreviewed-step';
    if (mismatch === 'resource') result.resources[0]!.id = 'unreviewed-service';
    f.setRemote(result);
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'receipt_invalid' } });
    await expect(f.preview()).rejects.toMatchObject({ code: 'operation_in_progress' });
  });

  it('discards stale receipts and rejects contradictory receipt versions and regressed progress', async () => {
    const f = fixture();
    await f.approve();
    await f.lifecycle.whenIdle();
    const progress = receipt(f.requests[0]!, { sequence: 3,
      steps: [{ id: 'frp', state: 'completed' }, { id: 'entrypoint', state: 'running' }],
      resources: [{ id: 'frps-service', result: 'created' }],
    });
    f.setRemote(progress);
    await f.lifecycle.resume(f.stored().revision);
    await f.lifecycle.whenIdle();
    f.setRemote(receipt(f.requests[0]!, { sequence: 2 }));
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'running', operation: { stage: 'verify-entrypoint' } });
    f.setRemote({ ...progress, resources: [] });
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'receipt_invalid' } });
    f.setRemote(receipt(f.requests[0]!, { sequence: 4 }));
    await f.lifecycle.resume(f.stored().revision);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'receipt_invalid' } });
  });

  it('requires stopped and complete step/resource evidence for successful completion', async () => {
    const f = fixture();
    await f.approve();
    await f.lifecycle.whenIdle();
    for (const result of [
      { ...complete(f.requests[0]!), stopped: false },
      { ...complete(f.requests[0]!), steps: [{ id: 'frp', state: 'running' as const }, { id: 'entrypoint', state: 'completed' as const }] },
      { ...complete(f.requests[0]!), resources: [] },
    ]) {
      f.setRemote(result);
      await f.lifecycle.resume(f.stored().revision);
      expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'interrupted', error: { code: 'receipt_invalid' } });
    }
  });

  it('requires qualified uninstall ownership for this exact target and preserves shared resources', async () => {
    const f = fixture();
    const uninstall = plan();
    uninstall.action = 'uninstall';
    uninstall.steps = [{ id: 'remove', stage: 'remove-resources' }];
    uninstall.resources[0]!.action = 'remove';
    await expect(f.preview(uninstall)).rejects.toMatchObject({ code: 'invalid_plan' });
    uninstall.ownership = { deploymentId: 'deployment-1', target: changedTarget, resourceIds: ['frps-service'] };
    await expect(f.preview(uninstall)).rejects.toMatchObject({ code: 'invalid_plan' });
    uninstall.ownership.target = target;
    uninstall.ownership.resourceIds = [];
    await expect(f.preview(uninstall)).rejects.toMatchObject({ code: 'invalid_plan' });
    uninstall.ownership.resourceIds = ['frps-service', 'caddy'];
    uninstall.resources[1]!.action = 'remove';
    await expect(f.preview(uninstall)).rejects.toMatchObject({ code: 'invalid_plan' });
    uninstall.resources[1]!.action = 'reuse';
    const reviewed = await f.preview(uninstall);
    expect(reviewed.preview?.resources).toEqual(uninstall.resources);
    await f.lifecycle.approve({ expectedRevision: reviewed.revision, planDigest: reviewed.preview!.digest });
    await f.lifecycle.whenIdle();
    expect(f.requests[0]?.plan.ownership).toEqual(uninstall.ownership);
  });

  it('fails closed on corrupted durable plans or unknown schema versions', async () => {
    const f = fixture();
    await f.preview();
    const modified = f.stored();
    modified.preview!.payload.template = 'unreviewed-change';
    f.replace(modified);
    await expect(f.lifecycle.start()).rejects.toMatchObject({ code: 'persistence_failed' });
    f.replace({ ...modified, schemaVersion: 2 } as unknown as DeploymentRecord<Payload>);
    await expect(f.lifecycle.start()).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.driver.reconcile).not.toHaveBeenCalled();
  });


  it.each([undefined, false, []])('rejects malformed durable slots rather than assuming no operation: %j', async (job) => {
    const f = fixture();
    f.replace({ ...f.stored(), job } as unknown as DeploymentRecord<Payload>);
    await expect(f.lifecycle.start()).rejects.toMatchObject({ code: 'persistence_failed' });
    await expect(f.preview()).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it('rejects non-JSON payloads and unsafe shared mutations, and redacts ID factory failures', async () => {
    const f = fixture();
    for (const payload of [undefined, { value: undefined }, { value: Number.NaN }, new Date(), { value: () => 'secret' }]) {
      await expect(f.preview({ ...plan(), payload } as unknown as DeploymentPlanInput<Payload>)).rejects.toMatchObject({ code: 'invalid_plan' });
    }
    const invalid = plan();
    invalid.resources[1]!.action = 'replace';
    await expect(f.preview(invalid)).rejects.toMatchObject({ code: 'invalid_plan' });
    await f.preview();
    const owner = createDeploymentLifecycle({ ...f.options, createOperationId: () => { throw new Error('private ID factory error'); } });
    await expect(owner.approve({ expectedRevision: f.stored().revision, planDigest: f.stored().preview!.digest }))
      .rejects.toMatchObject({ code: 'invalid_plan', message: 'The deployment plan or its ownership evidence is invalid.' });
    expect(f.driver.start).not.toHaveBeenCalled();
  });

  it('has no side effects on acceptance persistence failure', async () => {
    const f = fixture();
    const preview = await f.preview();
    f.storage.compareAndSwap.mockRejectedValueOnce(new Error('private database path'));
    await expect(f.lifecycle.approve({ expectedRevision: preview.revision, planDigest: preview.preview!.digest })).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(f.driver.start).not.toHaveBeenCalled();
    expect(f.stored().job).toBeNull();
  });

  it('reconciles a remote result after local result persistence fails, without dispatching twice', async () => {
    const f = fixture();
    f.driver.start.mockImplementationOnce(async (request) => {
      const completed = complete(request);
      f.setRemote(completed);
      f.storage.compareAndSwap.mockRejectedValueOnce(new Error('private persistence error'));
      return completed;
    });
    await f.approve();
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'queued', error: { code: 'persistence_failed' } });
    const restored = createDeploymentLifecycle(f.options);
    await restored.start();
    expect(await restored.whenIdle()).toMatchObject({ state: 'completed' });
    expect(f.driver.start).toHaveBeenCalledOnce();
  });

  it('coalesces repeated read-only reconciliation and isolates failing observers and raw diagnostics', async () => {
    const f = fixture();
    f.onStatus.mockImplementation(() => { throw new Error('observer is gone'); });
    await f.approve();
    await f.lifecycle.whenIdle();
    const reconciling = deferred<RemoteDeploymentReceipt>();
    f.driver.reconcile.mockImplementationOnce(() => reconciling.promise);
    await f.lifecycle.resume(f.stored().revision);
    await f.lifecycle.resume(f.stored().revision);
    await f.lifecycle.resume(f.stored().revision);
    await flush();
    expect(f.driver.reconcile).toHaveBeenCalledOnce();
    const raw = { ...complete(f.requests[0]!), stderr: 'FRP_TOKEN=very-secret',
      steps: complete(f.requests[0]!).steps.map((step) => ({ ...step, diagnostic: 'private key contents' })) };
    reconciling.resolve(raw);
    expect(await f.lifecycle.whenIdle()).toMatchObject({ state: 'completed' });
    expect(JSON.stringify(f.lifecycle.getStatus())).not.toMatch(/very-secret|private key|stderr|diagnostic/);
    expect(JSON.stringify(f.stored().job?.receipt)).not.toMatch(/very-secret|private key|stderr|diagnostic/);
    const modified = f.stored();
    (modified.job!.plan.target as DeploymentTarget & { secret: string }).secret = 'secret-in-extra-property';
    (modified.job!.plan.steps[0] as { id: string; stage: string; secret: string }).secret = 'secret-in-extra-property';
    f.replace(modified);
    await f.lifecycle.start();
    expect(JSON.stringify(f.lifecycle.getStatus())).not.toContain('secret-in-extra-property');
  });
});
