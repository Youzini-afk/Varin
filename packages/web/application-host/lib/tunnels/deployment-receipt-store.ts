import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import type {
  DeploymentOperationReference, DeploymentResource, DeploymentStep, DeploymentTarget, RemoteDeploymentReceipt,
} from './deployment-lifecycle.js';

export interface DeploymentReceiptBinding extends DeploymentOperationReference {
  deploymentId: string;
  /** Revision of the server inventory against which the operation was reviewed, not the latest receipt sequence. */
  reviewedRevision: number;
}
/** Supplied by the trusted remote runner after validating the full reviewed plan, never directly from an HTTP client. */
export interface DeploymentReceiptRequest extends DeploymentReceiptBinding {
  steps: DeploymentStep[];
  resources: DeploymentResource[];
}
export interface DeploymentReceiptProgress {
  steps: RemoteDeploymentReceipt['steps'];
  resources: RemoteDeploymentReceipt['resources'];
}
export interface DeploymentReceiptCompletion extends DeploymentReceiptProgress {
  state: 'completed' | 'failed' | 'stopped';
  /** The runner has independently proved that every owned subprocess/mutation ended. Promise settlement is insufficient. */
  stopped: true;
}
export interface DeploymentReceiptEvidence {
  deploymentId: string;
  revision: number;
  reviewedRevision: number;
  /** A nonterminal receipt is historical evidence only. It is NOT proof that an executor is still running. */
  outcome: 'terminal' | 'unknown';
  receipt: RemoteDeploymentReceipt;
}
export interface DeploymentReceiptSnapshot {
  deploymentId: string;
  revision: number;
  target: DeploymentTarget | null;
  activeOperationId: string | null;
}
export interface DeploymentReceiptEffectContext {
  /** Persist only verified progress, never output/log text. Accepted checkpoints drain before terminal commit. */
  checkpoint(progress: DeploymentReceiptProgress): Promise<DeploymentReceiptEvidence>;
}
export type DeploymentReceiptStoreFailure = 'invalid_request' | 'binding_mismatch' | 'revision_conflict'
  | 'operation_in_progress' | 'invalid_receipt' | 'storage_locked' | 'storage_failed' | 'writer_closed' | 'unsupported_platform';
const MESSAGES: Record<DeploymentReceiptStoreFailure, string> = {
  invalid_request: 'The remote deployment receipt request is invalid.',
  binding_mismatch: 'This operation or deployment is bound to a different reviewed revision, plan, or target.',
  revision_conflict: 'The remote deployment inventory changed after review.',
  operation_in_progress: 'The earlier deployment operation has not been proved stopped.',
  invalid_receipt: 'The supplied deployment progress or stop evidence is invalid.',
  storage_locked: 'The deployment receipt writer is locked. No stale writer is removed automatically.',
  storage_failed: 'The deployment receipt could not be read or durably committed.',
  writer_closed: 'This operation no longer accepts progress updates.',
  unsupported_platform: 'Durable deployment receipts require a POSIX server filesystem.',
};
export class DeploymentReceiptStoreError extends Error {
  constructor(readonly code: DeploymentReceiptStoreFailure) {
    super(MESSAGES[code]);
    this.name = 'DeploymentReceiptStoreError';
  }
}
interface StoredOperation {
  request: DeploymentReceiptRequest;
  receipt: RemoteDeploymentReceipt;
}
interface Ledger {
  schemaVersion: 1;
  deploymentId: string;
  revision: number;
  target: DeploymentTarget;
  activeOperationId: string | null;
  /** Retained terminal entries are tombstones. Removing them would re-enable delayed duplicate submissions. */
  operations: StoredOperation[];
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STAGES = ['install-frp', 'configure-proxy', 'issue-certificate', 'configure-renewal', 'configure-firewall',
  'configure-service', 'verify-entrypoint', 'remove-resources'];
const STEP_STATES = ['pending', 'running', 'completed', 'failed', 'skipped'];
const KINDS = ['component', 'file', 'service', 'firewall-rule', 'certificate', 'user'];
const RESULTS = { create: 'created', replace: 'updated', reuse: 'reused', remove: 'removed' } as const;
const error = (code: DeploymentReceiptStoreFailure): never => { throw new DeploymentReceiptStoreError(code); };
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const codeIs = (value: unknown, code: string) => value !== null && typeof value === 'object' && 'code' in value && value.code === code;
const platform = () => { if (process.platform === 'win32') error('unsupported_platform'); };
function normalizeTarget(input: DeploymentTarget): DeploymentTarget {
  if (!input || !id(input.sshTargetId) || typeof input.hostKeyFingerprint !== 'string'
    || !/^SHA256:[a-zA-Z0-9+/=_-]{16,128}$/.test(input.hostKeyFingerprint)) return error('invalid_request');
  return { sshTargetId: input.sshTargetId, hostKeyFingerprint: input.hostKeyFingerprint };
}
function binding(input: DeploymentReceiptBinding): DeploymentReceiptBinding {
  if (!input || !id(input.deploymentId) || !id(input.operationId) || !revision(input.reviewedRevision)
    || typeof input.planDigest !== 'string' || !DIGEST.test(input.planDigest)) return error('invalid_request');
  return { deploymentId: input.deploymentId, reviewedRevision: input.reviewedRevision,
    operationId: input.operationId, planDigest: input.planDigest, target: normalizeTarget(input.target) };
}
function uniqueIds(entries: Array<{ id: string }>): boolean {
  return Array.from(entries).every((entry) => entry && id(entry.id)) && new Set(entries.map((entry) => entry.id)).size === entries.length;
}
function request(input: DeploymentReceiptRequest): DeploymentReceiptRequest {
  const normalized = binding(input);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || !uniqueIds(input.steps)
    || !Array.isArray(input.resources) || !uniqueIds(input.resources)) return error('invalid_request');
  const steps = input.steps.map((step): DeploymentStep => {
    if (!STAGES.includes(step.stage)) return error('invalid_request');
    return { id: step.id, stage: step.stage };
  });
  const resources = input.resources.map((resource): DeploymentResource => {
    if (!KINDS.includes(resource.kind) || typeof resource.action !== 'string' || !Object.hasOwn(RESULTS, resource.action)
      || !['owned', 'shared'].includes(resource.ownership)
      || (resource.ownership === 'shared' && resource.action !== 'reuse')) return error('invalid_request');
    return { id: resource.id, kind: resource.kind, action: resource.action, ownership: resource.ownership };
  });
  return { ...normalized, steps, resources };
}
function normalizeReceipt(input: RemoteDeploymentReceipt, operation: DeploymentReceiptRequest): RemoteDeploymentReceipt {
  if (!input || input.schemaVersion !== 1 || input.operationId !== operation.operationId || input.planDigest !== operation.planDigest
    || !equal(normalizeTarget(input.target), operation.target) || !revision(input.sequence)
    || !['running', 'completed', 'failed', 'stopped'].includes(input.state)
    || input.stopped !== (input.state !== 'running')
    || !Array.isArray(input.steps) || !uniqueIds(input.steps) || input.steps.length !== operation.steps.length
    || !Array.isArray(input.resources) || !uniqueIds(input.resources)) return error('invalid_receipt');
  if (input.steps.some((step) => !STEP_STATES.includes(step.state) || !operation.steps.some((planned) => planned.id === step.id))
    || input.resources.some((resource) => !operation.resources.some((planned) => resource.id === planned.id
      && (resource.result === 'unchanged' || resource.result === RESULTS[planned.action])))) return error('invalid_receipt');
  if (input.state === 'completed' && (input.steps.some((step) => !['completed', 'skipped'].includes(step.state))
    || input.resources.length !== operation.resources.length)) return error('invalid_receipt');
  return { schemaVersion: 1, operationId: operation.operationId, planDigest: operation.planDigest,
    target: { ...operation.target }, sequence: input.sequence, state: input.state, stopped: input.stopped,
    steps: input.steps.map(({ id: stepId, state }) => ({ id: stepId, state })),
    resources: input.resources.map(({ id: resourceId, result }) => ({ id: resourceId, result })),
  };
}
function validateLedger(input: Ledger, deploymentId: string): Ledger {
  if (!input || input.schemaVersion !== 1 || input.deploymentId !== deploymentId || !revision(input.revision)
    || input.revision === 0 || !Array.isArray(input.operations) || input.operations.length === 0
    || (input.activeOperationId !== null && !id(input.activeOperationId))) return error('storage_failed');
  const target = normalizeTarget(input.target);
  const operations = input.operations.map((operation): StoredOperation => {
    const normalized = request(operation.request);
    if (normalized.deploymentId !== deploymentId || normalized.reviewedRevision >= input.revision
      || !equal(normalized.target, target)) return error('storage_failed');
    return { request: normalized, receipt: normalizeReceipt(operation.receipt, normalized) };
  });
  if (new Set(operations.map((operation) => operation.request.operationId)).size !== operations.length) return error('storage_failed');
  const unresolved = operations.filter((operation) => !operation.receipt.stopped);
  if (unresolved.length > 1 || (unresolved[0]?.request.operationId ?? null) !== input.activeOperationId) return error('storage_failed');
  return { schemaVersion: 1, deploymentId, revision: input.revision, target, activeOperationId: input.activeOperationId, operations };
}
function evidence(ledger: Ledger, operation: StoredOperation): DeploymentReceiptEvidence {
  return structuredClone({ deploymentId: ledger.deploymentId, revision: ledger.revision,
    reviewedRevision: operation.request.reviewedRevision, outcome: operation.receipt.stopped ? 'terminal' : 'unknown', receipt: operation.receipt });
}
function assertBinding(operation: StoredOperation, expected: DeploymentReceiptBinding) {
  if (!equal(binding(operation.request), binding(expected))) error('binding_mismatch');
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Server-side, POSIX-only receipt storage. Use a private, trusted directory on a local filesystem whose
 * rename/fsync semantics meet this contract. No SSH, subprocess, queue, or automatic retry lives here.
 * A short mkdir lock serializes ledger transactions across processes. It is NEVER stolen by age/PID:
 * a crash can leave a lock requiring explicit operator investigation. Reconciliation changes no contents;
 * terminal reads fsync directory entries before claiming durability, including a previously failed rename sync.
 * An unresolved operation keeps deployment ownership across owner restarts. Missing systemd units, empty
 * logs, timeouts, or an observer disconnect do not prove stop. This store cannot adjudicate them.
 */
export function createDeploymentReceiptStore(directory: string) {
  const root = path.resolve(directory);
  const names = (deploymentId: string) => {
    if (!id(deploymentId)) return error('invalid_request');
    const stem = createHash('sha256').update(deploymentId).digest('hex');
    return { file: path.join(root, `${stem}.json`), lock: path.join(root, `${stem}.lock`) };
  };
  const checkRoot = async (): Promise<boolean> => {
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return error('storage_failed');
      return true;
    } catch (cause) { if (codeIs(cause, 'ENOENT')) return false; throw cause; }
  };
  const read = async (deploymentId: string): Promise<Ledger | null> => {
    platform();
    const { file } = names(deploymentId);
    try {
      if (!await checkRoot()) return null;
      let handle;
      try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (cause) {
        if (codeIs(cause, 'ENOENT')) return null;
        throw cause;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) return error('storage_failed');
        const ledger = validateLedger(JSON.parse(await handle.readFile('utf8')) as Ledger, deploymentId);
        if (ledger.operations.some((operation) => operation.receipt.stopped)) {
          // A prior rename may be visible even though its directory sync failed. Seal that evidence before
          // reporting terminal durability. fsync changes no contents and never restarts/locks an operation.
          await syncDirectory(path.dirname(root));
          await syncDirectory(root);
        }
        return ledger;
      } finally { await handle.close(); }
    } catch { return error('storage_failed'); }
  };
  const write = async (ledger: Ledger) => {
    const { file } = names(ledger.deploymentId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    let failure: unknown;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify(ledger)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      // Do not acknowledge durability if directory fsync fails after rename.
      await syncDirectory(root);
    } catch (cause) { failure = cause; }
    try { await handle?.close(); } catch (cause) { failure ??= cause; }
    try { await unlink(temporary); } catch (cause) { if (!codeIs(cause, 'ENOENT')) failure ??= cause; }
    if (failure) throw failure;
  };
  const transaction = async <T>(deploymentId: string, action: (ledger: Ledger | null) => Promise<T>): Promise<T> => {
    platform();
    const { lock } = names(deploymentId);
    let locked = false;
    let result: T | undefined;
    let failure: DeploymentReceiptStoreError | undefined;
    try {
      try { await mkdir(root, { mode: 0o700 }); } catch (cause) {
        if (!codeIs(cause, 'EEXIST')) throw cause;
      }
      if (!await checkRoot()) error('storage_failed');
      // A competing/previous mkdir may have returned before its parent sync succeeded.
      await syncDirectory(path.dirname(root));
      try { await mkdir(lock, { mode: 0o700 }); locked = true; } catch (cause) {
        if (codeIs(cause, 'EEXIST')) error('storage_locked');
        throw cause;
      }
      await syncDirectory(root);
      result = await action(await read(deploymentId));
    } catch (cause) {
      failure = cause instanceof DeploymentReceiptStoreError ? cause : new DeploymentReceiptStoreError('storage_failed');
    }
    if (locked) {
      try { await rmdir(lock); await syncDirectory(root); } catch { failure ??= new DeploymentReceiptStoreError('storage_failed'); }
    }
    if (failure) throw failure;
    return result as T;
  };
  const commit = async (ledger: Ledger) => {
    if (ledger.revision === Number.MAX_SAFE_INTEGER) return error('storage_failed');
    ledger.revision += 1;
    await write(ledger);
  };
  const acceptedEvidence = (ledger: Ledger | null, input: DeploymentReceiptRequest, stopped: boolean) => {
    const previous = ledger?.operations.find((operation) => operation.request.operationId === input.operationId);
    if (!previous) return null;
    assertBinding(previous, input);
    if (!equal(previous.request, input)) return error('binding_mismatch');
    if (stopped && !previous.receipt.stopped) return error('operation_in_progress');
    return { created: false, evidence: evidence(ledger!, previous) };
  };
  const accept = async (input: DeploymentReceiptRequest, stopped: boolean) => {
    // Exact duplicates need no write lock, including after a crash left a stale lock beside a durable receipt.
    const known = acceptedEvidence(await read(input.deploymentId), input, stopped);
    if (known) return known;
    return transaction(input.deploymentId, async (existing) => {
      const duplicate = acceptedEvidence(existing, input, stopped);
      if (duplicate) return duplicate;
      if (existing && !equal(existing.target, input.target)) return error('binding_mismatch');
      if (input.reviewedRevision !== (existing?.revision ?? 0)) return error('revision_conflict');
      if (existing?.activeOperationId) return error('operation_in_progress');
      const ledger: Ledger = existing ?? { schemaVersion: 1, deploymentId: input.deploymentId, revision: 0,
        target: input.target, activeOperationId: null, operations: [] };
      const operation: StoredOperation = { request: input, receipt: {
        schemaVersion: 1, operationId: input.operationId, planDigest: input.planDigest, target: input.target,
        sequence: 0, state: stopped ? 'stopped' : 'running', stopped,
        steps: input.steps.map(({ id: stepId }) => ({ id: stepId, state: 'pending' })), resources: [],
      } };
      ledger.operations.push(operation);
      ledger.activeOperationId = stopped ? null : input.operationId;
      await commit(ledger);
      return { created: true, evidence: evidence(ledger, operation) };
    });
  };
  const reconcile = async (input: DeploymentReceiptBinding): Promise<DeploymentReceiptEvidence | null> => {
    const expected = binding(input);
    const ledger = await read(expected.deploymentId);
    if (!ledger) return null;
    if (!equal(ledger.target, expected.target)) return error('binding_mismatch');
    const operation = ledger.operations.find((entry) => entry.request.operationId === expected.operationId);
    if (!operation) return null;
    assertBinding(operation, expected);
    return evidence(ledger, operation);
  };
  const record = async (input: DeploymentReceiptRequest, progress: DeploymentReceiptProgress, completion?: DeploymentReceiptCompletion) =>
    transaction(input.deploymentId, async (ledger) => {
      const operation = ledger?.operations.find((entry) => entry.request.operationId === input.operationId);
      if (!ledger || !operation) return error('storage_failed');
      assertBinding(operation, input);
      if (operation.receipt.stopped || ledger.activeOperationId !== input.operationId) return error('writer_closed');
      if (!progress || (completion && (!['completed', 'failed', 'stopped'].includes(completion.state) || completion.stopped !== true))) return error('invalid_receipt');
      const previous = operation.receipt;
      if (previous.sequence === Number.MAX_SAFE_INTEGER) return error('storage_failed');
      const next = normalizeReceipt({ ...previous, sequence: previous.sequence + 1,
        state: completion?.state ?? 'running', stopped: Boolean(completion), steps: progress.steps, resources: progress.resources }, input);
      if (previous.steps.some((step) => ['completed', 'failed', 'skipped'].includes(step.state)
        && next.steps.find((entry) => entry.id === step.id)?.state !== step.state)
        || previous.resources.some((resource) => resource.result !== 'unchanged'
          && next.resources.find((entry) => entry.id === resource.id)?.result !== resource.result)) return error('invalid_receipt');
      operation.receipt = next;
      if (next.stopped) ledger.activeOperationId = null;
      await commit(ledger);
      return evidence(ledger, operation);
    });

  return {
    /** Does not create the directory, acquire a lock, rewrite receipts, inspect processes, or start any work. */
    snapshot: async (deploymentId: string): Promise<DeploymentReceiptSnapshot> => {
      const ledger = await read(deploymentId);
      return { deploymentId, revision: ledger?.revision ?? 0, target: ledger ? { ...ledger.target } : null,
        activeOperationId: ledger?.activeOperationId ?? null };
    },
    reconcile,
    /** Tombstone a never-started operation. Cannot cancel/declare stopped an already accepted operation. */
    preventStart: async (input: DeploymentReceiptRequest) => (await accept(request(input), true)).evidence,
    /**
     * Only the first durable acceptance invokes effect. A duplicate returns historical evidence, including
     * unknown outcome, without invoking any callback. Throwing does not fabricate failure or release ownership.
     * The callback is trusted runner code, must not leave untracked children, and supplies explicit stop proof.
     */
    execute: async (input: DeploymentReceiptRequest,
      effect: (context: DeploymentReceiptEffectContext) => Promise<DeploymentReceiptCompletion>): Promise<DeploymentReceiptEvidence> => {
      const expected = request(input);
      const accepted = await accept(expected, false);
      if (!accepted.created) return accepted.evidence;
      let closed = false;
      let checkpoints = Promise.resolve();
      let checkpointFailed = false;
      const context: DeploymentReceiptEffectContext = {
        checkpoint: (progress) => {
          if (closed) return Promise.reject(new DeploymentReceiptStoreError('writer_closed'));
          let copy: DeploymentReceiptProgress;
          try { copy = structuredClone(progress); } catch { return Promise.reject(new DeploymentReceiptStoreError('invalid_receipt')); }
          const result = checkpoints.then(() => {
            if (checkpointFailed) return error('invalid_receipt');
            return record(expected, copy);
          });
          checkpoints = result.then(() => undefined, () => { checkpointFailed = true; });
          return result;
        },
      };
      let completion: DeploymentReceiptCompletion | null = null;
      try { completion = structuredClone(await effect(context)); } catch { /* The actual outcome is unknown, not failed. */ }
      closed = true;
      await checkpoints;
      if (completion && !checkpointFailed) return record(expected, completion, completion);
      return (await reconcile(expected)) ?? error('storage_failed');
    },
  };
}
