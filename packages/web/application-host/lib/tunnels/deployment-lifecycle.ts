import { createHash, randomUUID } from 'node:crypto';

/** An SSH alias alone is not identity. The driver must resolve it and verify this key on every connection. */
export interface DeploymentTarget {
  sshTargetId: string;
  hostKeyFingerprint: string;
}

export type DeploymentAction = 'deploy' | 'update' | 'uninstall';
export type DeploymentStage = 'install-frp' | 'configure-proxy' | 'issue-certificate'
  | 'configure-renewal' | 'configure-firewall' | 'configure-service' | 'verify-entrypoint' | 'remove-resources';
export interface DeploymentStep { id: string; stage: DeploymentStage }
export interface DeploymentResource {
  id: string;
  kind: 'component' | 'file' | 'service' | 'firewall-rule' | 'certificate' | 'user';
  ownership: 'owned' | 'shared';
  action: 'create' | 'replace' | 'reuse' | 'remove';
}
export interface DeploymentOwnership {
  deploymentId: string;
  target: DeploymentTarget;
  /** Exact owned IDs from the checked remote manifest, not a client assertion. */
  resourceIds: string[];
}

/** Trusted planner output. Payload is durable, JSON-only and credential-free; secrets stay with the SSH owner. */
export interface DeploymentPlanInput<Payload> {
  action: DeploymentAction;
  target: DeploymentTarget;
  payload: Payload;
  steps: DeploymentStep[];
  resources: DeploymentResource[];
  ownership?: DeploymentOwnership;
}
export interface ReviewedDeploymentPlan<Payload> extends DeploymentPlanInput<Payload> { digest: string }
export type DeploymentStepState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type DeploymentResourceResult = 'created' | 'updated' | 'reused' | 'removed' | 'unchanged';
export interface DeploymentOperationReference {
  operationId: string;
  planDigest: string;
  target: DeploymentTarget;
}

/**
 * Persistent remote receipt, written by the remote operation owner, not synthesized from an SSH exit code.
 * sequence is monotonic within operationId. stopped proves all its mutations/processes have ended and the
 * operation cannot later restart, including a delayed submission arriving after a stop tombstone. Missing receipts, SSH exits and cancellation acknowledgments prove none of this.
 * Only reviewed IDs and fixed enums may cross the diagnostic/status boundary; raw stderr is never retained here.
 */
export interface RemoteDeploymentReceipt extends DeploymentOperationReference {
  schemaVersion: 1;
  sequence: number;
  state: 'running' | 'completed' | 'failed' | 'stopped';
  stopped: boolean;
  steps: Array<{ id: string; state: DeploymentStepState }>;
  resources: Array<{ id: string; result: DeploymentResourceResult }>;
}
export interface DeploymentOperationRequest<Payload> extends DeploymentOperationReference {
  plan: ReviewedDeploymentPlan<Payload>;
}
export interface DeploymentDriver<Payload> {
  /** Read-only verification of the current resolved SSH target and accepted host key. */
  verifyTarget(target: DeploymentTarget): Promise<boolean>;
  /**
   * Submit, do not wait for the deployment to finish. Before any effect, atomically create the remote receipt
   * and acquire exclusive ownership of the target's managed resources. Bind operationId to planDigest and
   * target; reject a reused ID with different contents. Recheck plan preconditions/ownership before effects.
   * Payload/credentials are not command-line arguments. Return a durable receipt, never just exit status.
   */
  start(request: DeploymentOperationRequest<Payload>): Promise<RemoteDeploymentReceipt>;
  /** Strictly read-only: inspect receipt AND actual process/service state, never relaunch or repeat a step. */
  reconcile(reference: DeploymentOperationReference): Promise<RemoteDeploymentReceipt | null>;
  /** Idempotent stop request; fence delayed submissions too. A null/running receipt is not proof of cancellation. */
  cancel(reference: DeploymentOperationReference): Promise<RemoteDeploymentReceipt | null>;
}
export type DeploymentFailureCode = 'invalid_plan' | 'revision_conflict' | 'approval_mismatch'
  | 'target_changed' | 'operation_in_progress' | 'no_operation' | 'persistence_failed'
  | 'connection_interrupted' | 'receipt_invalid' | 'remote_failed' | 'stop_unconfirmed';
const FAILURE_MESSAGES: Record<DeploymentFailureCode, string> = {
  invalid_plan: 'The deployment plan or its ownership evidence is invalid.',
  revision_conflict: 'Deployment state changed. Review the current plan before continuing.',
  approval_mismatch: 'Approval must match the exact current deployment preview.',
  target_changed: 'The SSH target or its accepted host key no longer matches the preview.',
  operation_in_progress: 'An earlier server operation has not been confirmed stopped.',
  no_operation: 'There is no active server operation to reconcile or cancel.',
  persistence_failed: 'Deployment state could not be saved or read.',
  connection_interrupted: 'The remote outcome is unknown. Reconnect to inspect it without repeating changes.',
  receipt_invalid: 'The remote deployment receipt could not be verified.',
  remote_failed: 'The remote operation stopped without completing the reviewed plan.',
  stop_unconfirmed: 'Cancellation was requested, but the remote operation has not been confirmed stopped.',
};
export class DeploymentLifecycleError extends Error {
  constructor(readonly code: DeploymentFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = 'DeploymentLifecycleError';
  }
}
export type DeploymentJobState = 'queued' | 'running' | 'cancelling' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
export interface DeploymentJob<Payload> {
  operationId: string;
  plan: ReviewedDeploymentPlan<Payload>;
  state: DeploymentJobState;
  cancelRequested: boolean;
  receipt: RemoteDeploymentReceipt | null;
  error: DeploymentFailureCode | null;
}
/** Owned by the existing Host durable settings owner. This module never introduces a second file writer. */
export interface DeploymentRecord<Payload> {
  schemaVersion: 1;
  revision: number;
  preview: ReviewedDeploymentPlan<Payload> | null;
  job: DeploymentJob<Payload> | null;
}
export interface DeploymentStorage<Payload> {
  read(): Promise<DeploymentRecord<Payload>>;
  /** Atomic and durable BEFORE resolving true. False means no write; throwing must not mean a known success. */
  compareAndSwap(expectedRevision: number, next: DeploymentRecord<Payload>): Promise<boolean>;
}
export interface DeploymentPreview {
  digest: string;
  action: DeploymentAction;
  target: DeploymentTarget;
  steps: DeploymentStep[];
  resources: DeploymentResource[];
}
export interface DeploymentStatus {
  revision: number;
  state: 'idle' | 'preview' | DeploymentJobState;
  preview: DeploymentPreview | null;
  operation: (DeploymentOperationReference & {
    action: DeploymentAction;
    cancelRequested: boolean;
    stage: DeploymentStage | null;
    steps: RemoteDeploymentReceipt['steps'];
    resources: RemoteDeploymentReceipt['resources'];
  }) | null;
  error: { code: DeploymentFailureCode; message: string } | null;
}
export interface DeploymentLifecycleOptions<Payload> {
  storage: DeploymentStorage<Payload>;
  driver: DeploymentDriver<Payload>;
  onStatus?(status: DeploymentStatus): void;
  createOperationId?(): string;
}

const STAGES: readonly string[] = ['install-frp', 'configure-proxy', 'issue-certificate', 'configure-renewal',
  'configure-firewall', 'configure-service', 'verify-entrypoint', 'remove-resources'];
const RESOURCE_KINDS: readonly string[] = ['component', 'file', 'service', 'firewall-rule', 'certificate', 'user'];
const RESOURCE_ACTIONS: readonly string[] = ['create', 'replace', 'reuse', 'remove'];
const STEP_STATES: readonly string[] = ['pending', 'running', 'completed', 'failed', 'skipped'];
const RESOURCE_RESULTS: readonly string[] = ['created', 'updated', 'reused', 'removed', 'unchanged'];
const JOB_STATES: readonly string[] = ['queued', 'running', 'cancelling', 'interrupted', 'completed', 'failed', 'cancelled'];
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const terminal = (state: DeploymentJobState) => state === 'completed' || state === 'failed' || state === 'cancelled';
const fail = (code: DeploymentFailureCode): never => { throw new DeploymentLifecycleError(code); };
const sameTarget = (a: DeploymentTarget, b: DeploymentTarget) =>
  a.sshTargetId === b.sshTargetId && a.hostKeyFingerprint === b.hostKeyFingerprint;

/** Reject non-JSON payloads rather than hashing a different plan from the one the driver receives. */
function canonical(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) return fail('invalid_plan');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return fail('invalid_plan');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return fail('invalid_plan');
    result = `[${value.map((entry) => canonical(entry, seen)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}
function target(value: DeploymentTarget): DeploymentTarget {
  if (!value || typeof value.sshTargetId !== 'string' || !ID.test(value.sshTargetId) || typeof value.hostKeyFingerprint !== 'string'
    || !/^SHA256:[a-zA-Z0-9+/=_-]{16,128}$/.test(value.hostKeyFingerprint)) return fail('invalid_plan');
  return { sshTargetId: value.sshTargetId, hostKeyFingerprint: value.hostKeyFingerprint };
}
function uniqueIds(values: Array<{ id: string }>) {
  if (values.some((entry) => !entry || typeof entry.id !== 'string' || !ID.test(entry.id))
    || new Set(values.map((entry) => entry.id)).size !== values.length) fail('invalid_plan');
}
function review<Payload>(input: DeploymentPlanInput<Payload>): ReviewedDeploymentPlan<Payload> {
  if (!input || !['deploy', 'update', 'uninstall'].includes(input.action)
    || !Array.isArray(input.steps) || input.steps.length === 0 || !Array.isArray(input.resources)) return fail('invalid_plan');
  uniqueIds(input.steps);
  uniqueIds(input.resources);
  const steps = input.steps.map((step): DeploymentStep => {
    if (!STAGES.includes(step.stage)) return fail('invalid_plan');
    return { id: step.id, stage: step.stage };
  });
  const resources = input.resources.map((resource): DeploymentResource => {
    if (!RESOURCE_KINDS.includes(resource.kind) || !RESOURCE_ACTIONS.includes(resource.action)
      || !['owned', 'shared'].includes(resource.ownership)
      || (resource.ownership === 'shared' && resource.action !== 'reuse')) return fail('invalid_plan');
    return { id: resource.id, kind: resource.kind, ownership: resource.ownership, action: resource.action };
  });
  const plan: DeploymentPlanInput<Payload> = {
    action: input.action, target: target(input.target), payload: JSON.parse(canonical(input.payload)) as Payload, steps, resources,
  };
  if (input.ownership) {
    if (typeof input.ownership.deploymentId !== 'string' || !ID.test(input.ownership.deploymentId) || !Array.isArray(input.ownership.resourceIds)) return fail('invalid_plan');
    const ids = input.ownership.resourceIds;
    uniqueIds(ids.map((id) => ({ id })));
    plan.ownership = { deploymentId: input.ownership.deploymentId, target: target(input.ownership.target), resourceIds: [...ids] };
    if (!sameTarget(plan.target, plan.ownership.target)) return fail('invalid_plan');
  }
  if (plan.action === 'uninstall') {
    if (!plan.ownership || resources.some((resource) => resource.action !== 'remove' && resource.action !== 'reuse')) return fail('invalid_plan');
  }
  if (resources.some((resource) => resource.action === 'remove'
    && (!plan.ownership || !plan.ownership.resourceIds.includes(resource.id)))) return fail('invalid_plan');
  return { ...plan, digest: createHash('sha256').update(canonical(plan)).digest('hex') };
}
function publicPreview<Payload>(plan: ReviewedDeploymentPlan<Payload>): DeploymentPreview {
  return structuredClone({ digest: plan.digest, action: plan.action, target: plan.target, steps: plan.steps, resources: plan.resources });
}
function reference<Payload>(job: DeploymentJob<Payload>): DeploymentOperationReference {
  return { operationId: job.operationId, planDigest: job.plan.digest, target: structuredClone(job.plan.target) };
}
function receiptFor<Payload>(input: RemoteDeploymentReceipt, job: DeploymentJob<Payload>): RemoteDeploymentReceipt {
  if (!input || input.schemaVersion !== 1 || input.operationId !== job.operationId || input.planDigest !== job.plan.digest
    || !input.target || !sameTarget(input.target, job.plan.target) || !Number.isSafeInteger(input.sequence) || input.sequence < 0
    || !['running', 'completed', 'failed', 'stopped'].includes(input.state) || typeof input.stopped !== 'boolean'
    || (input.state === 'running' ? input.stopped : !input.stopped)
    || !Array.isArray(input.steps) || !Array.isArray(input.resources)) return fail('receipt_invalid');
  try { uniqueIds(input.steps); uniqueIds(input.resources); } catch { return fail('receipt_invalid'); }
  if (input.steps.length !== job.plan.steps.length || input.steps.some((step) => !STEP_STATES.includes(step.state)
    || !job.plan.steps.some((planned) => planned.id === step.id))) return fail('receipt_invalid');
  if (input.resources.some((resource) => !RESOURCE_RESULTS.includes(resource.result)
    || !job.plan.resources.some((planned) => planned.id === resource.id
      && (resource.result === 'unchanged' || ({ create: 'created', replace: 'updated', reuse: 'reused', remove: 'removed' }[planned.action]) === resource.result)))) return fail('receipt_invalid');
  if (input.state === 'completed' && (input.steps.some((step) => step.state !== 'completed' && step.state !== 'skipped')
    || input.resources.length !== job.plan.resources.length)) return fail('receipt_invalid');
  // Whitelist fields even when the transport hands us extra diagnostics or arbitrary exception text.
  return {
    schemaVersion: 1, ...reference(job), sequence: input.sequence, state: input.state, stopped: input.stopped,
    steps: input.steps.map(({ id, state }) => ({ id, state })), resources: input.resources.map(({ id, result }) => ({ id, result })),
  };
}

/**
 * One Host-owned deployment slot, not a general task queue. Acceptance is durable before SSH dispatch.
 * Restart/disconnect recovery ONLY reconciles: even a queued operation may already have remote effects.
 * A receipt proving quiescence is required to release the slot. Closing an observer never cancels work.
 */
export function createDeploymentLifecycle<Payload>(options: DeploymentLifecycleOptions<Payload>) {
  let saved: DeploymentRecord<Payload> = { schemaVersion: 1, revision: 0, preview: null, job: null };
  let localError: DeploymentFailureCode | null = null;
  let writes = Promise.resolve();
  let work = Promise.resolve();
  const scheduled = new Set<string>();
  const getStatus = (): DeploymentStatus => {
    const job = saved.job;
    const code = localError ?? job?.error ?? null;
    const currentStep = job?.receipt?.steps.find((step) => step.state === 'running');
    return structuredClone({
      revision: saved.revision,
      state: saved.preview ? 'preview' : job?.state ?? 'idle',
      preview: saved.preview ? publicPreview(saved.preview) : null,
      operation: job ? { ...reference(job), action: job.plan.action, cancelRequested: job.cancelRequested,
        stage: job.plan.steps.find((step) => step.id === currentStep?.id)?.stage ?? null,
        steps: job.receipt?.steps ?? job.plan.steps.map(({ id }) => ({ id, state: 'pending' as const })),
        resources: job.receipt?.resources ?? [] } : null,
      error: code ? { code, message: FAILURE_MESSAGES[code] } : null,
    });
  };
  const publish = () => { try { options.onStatus?.(getStatus()); } catch { /* Observers do not own the operation. */ } };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation);
    writes = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = async () => {
    try {
      const record = structuredClone(await options.storage.read());
      if (!record || record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 0
        || (record.preview !== null && (typeof record.preview !== 'object' || Array.isArray(record.preview)))
        || (record.job !== null && (typeof record.job !== 'object' || Array.isArray(record.job)))) return fail('persistence_failed');
      if (record.preview) {
        const checked = review(record.preview);
        if (checked.digest !== record.preview.digest) return fail('persistence_failed');
        record.preview = checked;
      }
      if (record.job) {
        const job = record.job;
        if (typeof job.operationId !== 'string' || !ID.test(job.operationId) || !JOB_STATES.includes(job.state) || typeof job.cancelRequested !== 'boolean'
          || (job.receipt !== null && (typeof job.receipt !== 'object' || Array.isArray(job.receipt)))
          || (job.error !== null && !Object.hasOwn(FAILURE_MESSAGES, job.error))
          || review(job.plan).digest !== job.plan.digest || (record.preview && !terminal(job.state))) return fail('persistence_failed');
        job.plan = review(job.plan);
        if (job.receipt) job.receipt = receiptFor(job.receipt, job);
        if (terminal(job.state) && (!job.receipt?.stopped || job.receipt.state === 'running')) return fail('persistence_failed');
        if (job.state === 'completed' && job.receipt?.state !== 'completed') return fail('persistence_failed');
        if (job.state === 'cancelled' && (!job.cancelRequested || job.receipt?.state !== 'stopped')) return fail('persistence_failed');
        if (job.state === 'failed' && !['failed', 'stopped'].includes(job.receipt!.state)) return fail('persistence_failed');
      }
      saved = record;
      localError = null;
      return record;
    } catch { return fail('persistence_failed'); }
  };
  const current = async (expectedRevision: number) => {
    const record = await read();
    if (record.revision !== expectedRevision) return fail('revision_conflict');
    return record;
  };
  const persist = async (record: DeploymentRecord<Payload>, next: Omit<DeploymentRecord<Payload>, 'revision'>) => {
    if (record.revision === Number.MAX_SAFE_INTEGER) return fail('persistence_failed');
    const candidate = { ...next, revision: record.revision + 1 };
    let committed: boolean;
    try { committed = await options.storage.compareAndSwap(record.revision, structuredClone(candidate)); } catch { return fail('persistence_failed'); }
    if (!committed) return fail('revision_conflict');
    saved = candidate;
    localError = null;
    publish();
  };
  const active = (record: DeploymentRecord<Payload>) => record.job && !terminal(record.job.state);
  const updateJob = (operationId: string, transform: (job: DeploymentJob<Payload>) => DeploymentJob<Payload> | null) => serial(async () => {
    // A remote effect is never retried here. Only a failed CAS of its read-only evidence may be retried.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record = await read();
      if (!record.job || record.job.operationId !== operationId) return;
      const next = transform(structuredClone(record.job));
      if (!next) return;
      try { await persist(record, { ...record, job: next }); return; } catch (error) {
        if (!(error instanceof DeploymentLifecycleError) || error.code !== 'revision_conflict') throw error;
      }
    }
    fail('revision_conflict');
  });
  const interrupted = (operationId: string, code: DeploymentFailureCode) => updateJob(operationId, (job) => {
    if (terminal(job.state)) return null;
    return { ...job, state: 'interrupted', error: code };
  });
  const acceptReceipt = async (operationId: string, input: RemoteDeploymentReceipt | null) => updateJob(operationId, (job) => {
    if (!input) return terminal(job.state) ? null : { ...job, state: 'interrupted', error: 'connection_interrupted' };
    let receipt: RemoteDeploymentReceipt;
    try { receipt = receiptFor(input, job); } catch {
      return terminal(job.state) ? null : { ...job, state: 'interrupted', error: 'receipt_invalid' };
    }
    const previous = job.receipt;
    if (previous && receipt.sequence < previous.sequence) return null;
    if (previous && receipt.sequence === previous.sequence && canonical(receipt) !== canonical(previous)) {
      return terminal(job.state) ? null : { ...job, state: 'interrupted', error: 'receipt_invalid' };
    }
    if (terminal(job.state)) return null;
    if (previous && (previous.steps.some((step) => ['completed', 'failed', 'skipped'].includes(step.state)
      && receipt.steps.find((next) => next.id === step.id)?.state !== step.state)
      || previous.resources.some((resource) => resource.result !== 'unchanged'
        && receipt.resources.find((next) => next.id === resource.id)?.result !== resource.result))) {
      return { ...job, state: 'interrupted', error: 'receipt_invalid' };
    }
    if (receipt.state === 'completed') return { ...job, receipt, state: 'completed', error: null };
    if (receipt.state === 'failed') return { ...job, receipt, state: 'failed', error: 'remote_failed' };
    if (receipt.state === 'stopped') return { ...job, receipt, state: job.cancelRequested ? 'cancelled' : 'failed',
      error: job.cancelRequested ? null : 'remote_failed' };
    return { ...job, receipt, state: job.cancelRequested ? 'cancelling' : 'running',
      error: job.cancelRequested ? 'stop_unconfirmed' : null };
  });
  const schedule = (kind: 'start' | 'reconcile' | 'cancel', job: DeploymentJob<Payload>) => {
    const key = `${kind}:${job.operationId}`;
    if (scheduled.has(key)) return;
    scheduled.add(key);
    work = work.then(async () => {
      const latest = await serial(read);
      if (!latest.job || latest.job.operationId !== job.operationId || terminal(latest.job.state)) return;
      const request = reference(job);
      let receipt: RemoteDeploymentReceipt | null;
      try {
        if (kind === 'start') receipt = await options.driver.start({ ...request, plan: structuredClone(job.plan) });
        else receipt = await options.driver[kind](request);
      } catch {
        await interrupted(job.operationId, kind === 'cancel' ? 'stop_unconfirmed' : 'connection_interrupted');
        return;
      }
      await acceptReceipt(job.operationId, receipt);
    }).catch((error: unknown) => {
      localError = error instanceof DeploymentLifecycleError ? error.code : 'persistence_failed';
      publish();
    }).finally(() => { scheduled.delete(key); });
  };

  return {
    getStatus,
    /** Restore local state and inspect an outstanding operation. Never dispatch an old queued intent. */
    start: () => serial(async () => {
      const record = await read();
      if (active(record)) schedule('reconcile', record.job!);
      publish();
      return getStatus();
    }),
    preview: (input: DeploymentPlanInput<Payload>, expectedRevision: number) => serial(async () => {
      const record = await current(expectedRevision);
      if (active(record)) return fail('operation_in_progress');
      let plan: ReviewedDeploymentPlan<Payload>;
      try { plan = review(structuredClone(input)); } catch { return fail('invalid_plan'); }
      await persist(record, { ...record, preview: plan });
      return getStatus();
    }),
    approve: (approval: { expectedRevision: number; planDigest: string }) => serial(async () => {
      const record = await current(approval.expectedRevision);
      if (active(record)) return fail('operation_in_progress');
      const plan = record.preview;
      if (!plan || !DIGEST.test(approval.planDigest) || approval.planDigest !== plan.digest) return fail('approval_mismatch');
      let verified: boolean;
      try { verified = await options.driver.verifyTarget(structuredClone(plan.target)); } catch { return fail('target_changed'); }
      if (verified !== true) return fail('target_changed');
      let operationId: string;
      try { operationId = (options.createOperationId ?? randomUUID)(); } catch { return fail('invalid_plan'); }
      if (typeof operationId !== 'string' || !ID.test(operationId) || operationId === record.job?.operationId) return fail('invalid_plan');
      const job: DeploymentJob<Payload> = { operationId, plan, state: 'queued', cancelRequested: false, receipt: null, error: null };
      await persist(record, { ...record, preview: null, job });
      const accepted = getStatus();
      schedule('start', job);
      return accepted;
    }),
    resume: (expectedRevision: number) => serial(async () => {
      const record = await current(expectedRevision);
      if (!active(record)) return fail('no_operation');
      schedule('reconcile', record.job!);
      return getStatus();
    }),
    cancel: (expectedRevision: number) => serial(async () => {
      const record = await current(expectedRevision);
      if (!active(record)) return fail('no_operation');
      const job: DeploymentJob<Payload> = { ...record.job!, cancelRequested: true, state: 'cancelling', error: null };
      await persist(record, { ...record, job });
      const accepted = getStatus();
      schedule('cancel', job);
      return accepted;
    }),
    /** Wait for currently scheduled transport calls, not for a still-running remote deployment. */
    whenIdle: async () => {
      let pending: Promise<void>;
      do { pending = work; await pending; await writes; } while (pending !== work);
      return getStatus();
    },
  };
}
