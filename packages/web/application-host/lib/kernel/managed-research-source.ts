/** Experiment input stays in the source Storage until the coordinator installs its bytes. */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSourceCleanupScope, ManagedSourceLocalScope, SourceServiceOperation } from '../harness/managed-remote-types.js';
import { ManagedSourceDrainedError } from '../harness/managed-source-drain.js';
import { ExperimentInputCaptureError, prepareExperimentInput, reconcileExperimentCapture, type ExperimentInputCapture, type ExperimentInputSnapshot } from '../harness/experiment-workspace.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';
import type { KernelClient, KernelScopedClient } from './kernel-client.js';
import type { KernelBranchState, KernelRecordResult } from './protocol.generated.js';
export interface ManagedExperimentInput {
  snapshot: ExperimentInputSnapshot;
  entries: Array<{
    path: string;
    state: KernelBranchState;
  }>;
}
type Request = Extract<SourceServiceOperation, {
  kind: 'experiment_admit' | 'experiment_capture' | 'experiment_read';
}>;
type CaptureIntent = {
  identity: unknown;
  cwd: string;
  captureScopes: string[];
  capture?: ExperimentInputCapture;
  drained?: boolean;
  cleanupOperationId?: string;
};
const relative = (value: string): string => {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.includes('\0') || normalized.split('/').includes('..'))
    throw new Error('Experiment cwd must stay inside its exact source');
  return normalized.split('/').filter(part => part && part !== '.').join('/');
};
const owner = (scope: ManagedSourceCleanupScope) => {
  if (scope.scope.kind !== 'run' || !scope.operationId)
    throw new Error('Experiment input requires its original caller-owned source operation');
  const identity = { principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
    authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, scope: scope.scope, source: scope.source, operationId: scope.operationId };
  const id = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return { identity, recordId: `experiment.input-capture:${id}`, branchId: `experiment-source-${id}`,
    pinId: `experiment-source-pin:${id}`, caller: { workspaceId: scope.source.workspace_id,
      executionWorkspaceId: scope.source.execution_workspace_id, threadId: scope.scope.threadId, runId: scope.scope.runId,
      owner: { runtime: 'agent' as const, operationId: scope.operationId } } };
};
const intentOf = (record: KernelRecordResult, identity: unknown): CaptureIntent => {
  const intent = JSON.parse(record.payloadJson) as CaptureIntent;
  if (record.recordType !== 'experiment.input-capture' || !isDeepStrictEqual(intent.identity, identity)
    || typeof intent.cwd !== 'string' || !Array.isArray(intent.captureScopes) || !intent.captureScopes.every(value => typeof value === 'string'))
    throw new Error('Original experiment source capture changed');
  return intent;
};
const saveIntent = (scoped: KernelScopedClient, original: ReturnType<typeof owner>, value: CaptureIntent, record?: KernelRecordResult | null) =>
  scoped.putRecord({ operationId: `experiment-source-intent:${randomUUID()}`, recordId: original.recordId,
    workspaceId: original.caller.workspaceId, recordType: 'experiment.input-capture', state: 'capturing',
    threadId: original.caller.threadId, runId: original.caller.runId,
    payloadJson: JSON.stringify({ ...value, id: original.recordId.slice('experiment.input-capture:'.length), workspaceId: original.caller.workspaceId }),
    ownerIds: [], references: [], ...(record ? { expectedRecordRevision: record.recordRevision } : {}) });
export function createManagedResearchSource(kernel: KernelClient) {
  // Derived immutable lookup only; original branch/receipt and the current
  // source grant remain authoritative. Byte pages do not reread the manifest.
  const inputs = new Map<string, { snapshot: ExperimentInputSnapshot; files: Map<string, KernelBranchState> }>();
  const flights = new Map<string, {
    intent: CaptureIntent;
    work: Promise<ManagedExperimentInput>;
  }>();
  const cwdFor = async (scope: ManagedSourceLocalScope, value: string, signal?: AbortSignal): Promise<string> => {
    const scoped = kernel.scoped(scope.grant);
    if (scope.source.mode === 'fixed_branch') {
      const cwd = relative(value);
      if (cwd) {
        const branch = await scoped.readBranch({ branchId: scope.source.branch_id!, revision: scope.source.revision!, paths: [cwd], includeEntries: true }, signal);
        if (!branch.entries.some(entry => entry.path === cwd && entry.state.kind === 'directory'))
          throw new Error('Fixed research cwd is not a directory');
      }
      return cwd;
    }
    if (!scope.physicalRoot)
      throw new Error('Original physical experiment source is unavailable');
    if (!path.isAbsolute(value))
      return relative(value);
    const resolved = await canonicalizePathIdentity(value);
    if (!isPathWithinRoot(resolved, scope.physicalRoot.canonicalRoot))
      throw new Error('Experiment cwd escapes the original source');
    return relative(path.relative(scope.physicalRoot.canonicalRoot, resolved));
  };
  const recover = async (scoped: KernelScopedClient, capture: ExperimentInputCapture): Promise<ExperimentInputSnapshot | null> => {
    const receipt = await scoped.getOperation(`experiment-input-branch:${capture.branchId}`);
    if (!receipt)
      return null;
    const result = receipt.result as {
      branchId?: string;
      root?: string;
    } | undefined;
    if (receipt.state !== 'committed' || result?.branchId !== capture.branchId || !result.root)
      throw new Error('Original source input creation is unconfirmed');
    const branch = await scoped.readBranch({ branchId: capture.branchId, includeEntries: false });
    if (branch.workspaceId !== capture.workspaceId || branch.root !== result.root || branch.currentRoot !== result.root)
      throw new Error('Original source input branch changed');
    return { ...capture, root: result.root };
  };
  const manifest = async (scoped: KernelScopedClient, snapshot: ExperimentInputSnapshot): Promise<ManagedExperimentInput> => {
    const entries: ManagedExperimentInput['entries'] = [];
    let cursor: number | undefined;
    do {
      const page = await scoped.readBranch({ branchId: snapshot.branchId, includeEntries: true, pageSize: 1024, ...(cursor === undefined ? {} : { cursor }) });
      if (page.workspaceId !== snapshot.workspaceId || page.root !== snapshot.root || page.currentRoot !== snapshot.root)
        throw new Error('Original source input branch changed');
      entries.push(...page.entries.map(({ path: name, state }) => ({ path: name, state })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { snapshot, entries };
  };
  const capture = async (scope: ManagedSourceLocalScope, intent: CaptureIntent, signal: AbortSignal): Promise<ManagedExperimentInput> => {
    const original = owner({ ...scope, operationId: scope.grant.operationId ?? null });
    const source = kernel.scoped(scope.grant);
    // Source authority admits reading the selected project/revision. The service
    // owns its temporary Storage records and input branch under the same Operation.
    const grant = await kernel.issueGrant({ grantId: `experiment-source-capture:${randomUUID()}`,
      owningWorkspace: original.caller.workspaceId, executionWorkspace: original.caller.executionWorkspaceId,
      threadId: original.caller.threadId, runId: original.caller.runId, operationId: scope.grant.operationId,
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    const scoped = kernel.scoped(grant);
    try {
      let record = await scoped.getRecord(original.caller.workspaceId, original.recordId);
      if (record) {
        const saved = intentOf(record, original.identity);
        if (saved.cwd !== intent.cwd || !isDeepStrictEqual(saved.captureScopes, intent.captureScopes))
          throw new Error('Original experiment input selection changed');
        if (saved.capture) {
          const snapshot = await recover(scoped, saved.capture);
          if (snapshot)
            return await manifest(scoped, snapshot);
        }
      }
      const save = async (value: CaptureIntent) => {
        record = await saveIntent(scoped, original, value, record);
      };
      await save(intent);
      let snapshot: ExperimentInputSnapshot;
      let createDispatched = false;
      try {
        if (scope.source.mode !== 'fixed_branch') {
          if (!scope.physicalRoot)
            throw new Error('Original physical experiment source is unavailable');
          snapshot = await prepareExperimentInput(kernel, original.caller, scope.physicalRoot.canonicalRoot, {
            sourceAuthority: { scoped: source, rootId: scope.physicalRoot.rootId }, captureScopes: intent.captureScopes, cwd: intent.cwd,
            branchId: original.branchId, signal, beforeBranchCreate: async (value) => { await save({ ...intent, capture: value }); },
          });
        }
        else {
          const pinned = await source.pinBranch({ operationId: `${original.pinId}:acquire`, branchId: scope.source.branch_id!, revision: scope.source.revision!, pinId: original.pinId });
          if (typeof pinned.root !== 'string' || pinned.pinId !== original.pinId)
            throw new Error('Original fixed experiment source pin changed');
          const input: ExperimentInputCapture = { schemaVersion: 2, branchId: original.branchId, sourceRoot: null,
            workspaceId: original.caller.workspaceId, executionWorkspaceId: original.caller.executionWorkspaceId,
            captureScopes: intent.captureScopes, capturedPathCount: null, inventoryFingerprint: null, captureSemantics: null,
            source: { kind: 'fixed-branch', branchId: scope.source.branch_id!, revision: scope.source.revision!, root: pinned.root },
            ...(intent.cwd ? { cwd: intent.cwd } : {}) };
          await save({ ...intent, capture: input });
          signal.throwIfAborted();
          createDispatched = true;
          const branch = await scoped.createBranch({ operationId: `experiment-input-branch:${original.branchId}`, branchId: original.branchId,
            workspaceId: original.caller.workspaceId, baseRef: `pin:${original.pinId}`, entries: [], draftBasePaths: [], captureScopes: intent.captureScopes });
          if (branch.root !== pinned.root || branch.branchId !== original.branchId)
            throw new Error('Fixed experiment input creation changed its root');
          snapshot = { ...input, root: pinned.root };
          // Keep the original pin through retries and lost create replies. Only
          // retirement of this caller-owned source releases it.
        }
        const { root: _root, ...captured } = snapshot;
        await save({ ...intent, capture: captured, drained: true });
        return await manifest(scoped, snapshot);
      }
      catch (error) {
        if (!(error instanceof ExperimentInputCaptureError) || error.drained) {
          const saved = record && intentOf(record, original.identity);
          await save({ ...intent, ...(saved?.capture ? { capture: saved.capture } : {}), drained: true });
        }
        if (error instanceof ExperimentInputCaptureError && !error.drained)
          throw error;
        if (createDispatched && !kernel.isReady)
          throw error;
        throw new ManagedSourceDrainedError(error);
      }
    }
    finally {
      await kernel.retireGrant(grant.grantId);
    }
  };
  return {
    clearViews(): void { inputs.clear(); },
    async handle(scope: ManagedSourceLocalScope, request: Request, signal: AbortSignal): Promise<unknown> {
      try {
        const original = owner({ ...scope, operationId: scope.grant.operationId ?? null });
        if (scope.grant.operationId !== request.operationId)
          throw new ManagedSourceDrainedError(new Error('Experiment source operation differs'));
        if (request.kind === 'experiment_admit')
          return { cwd: await cwdFor(scope, request.cwd ?? '', signal) };
        if (request.kind === 'experiment_capture') {
          const intent = { identity: original.identity, cwd: await cwdFor(scope, request.cwd, signal), captureScopes: [...request.captureScopes] };
          const previous = flights.get(original.recordId);
          if (previous) {
            if (!isDeepStrictEqual(previous.intent, intent))
              throw new ManagedSourceDrainedError(new Error('Experiment input selection changed'));
            return await previous.work;
          }
          const work = capture(scope, intent, signal).then(input => {
            inputs.set(original.recordId, { snapshot: input.snapshot, files: new Map(input.entries.map(entry => [entry.path, entry.state])) });
            return input;
          });
          flights.set(original.recordId, { intent, work });
          return await work.finally(() => { flights.delete(original.recordId); });
        }
        const scoped = kernel.scoped(scope.grant);
        let input = inputs.get(original.recordId);
        if (!input) {
          const record = await scoped.getRecord(original.caller.workspaceId, original.recordId);
          const intent = record && intentOf(record, original.identity);
          const snapshot = intent?.capture && await recover(scoped, intent.capture);
          if (!snapshot) throw new ManagedSourceDrainedError(new Error('Original experiment input is unavailable'));
          input = { snapshot, files: new Map() };
          inputs.set(original.recordId, input);
        }
        const { snapshot, files } = input;
        let state = files.get(request.path);
        if (!state) {
          const branch = await scoped.readBranch({ branchId: snapshot.branchId, paths: [request.path], includeEntries: true });
          if (branch.root !== snapshot.root || branch.currentRoot !== snapshot.root) throw new Error('Original source input branch changed');
          state = branch.entries.find(value => value.path === request.path)?.state;
          if (state) files.set(request.path, state);
        }
        if (state?.kind !== 'regular-file')
          throw new ManagedSourceDrainedError(new Error('Original experiment input file is unavailable'));
        const result = await scoped.getBlob(state.objectHash, { branchId: snapshot.branchId, path: request.path }, { offset: request.offset, length: request.length });
        if (signal.aborted)
          throw new ManagedSourceDrainedError(signal.reason);
        return result;
      }
      catch (error) {
        if (error instanceof ManagedSourceDrainedError || error instanceof ExperimentInputCaptureError && !error.drained)
          throw error;
        // Apart from the capture worker (which carries its own drain fact), these
        // are joined metadata/byte reads. An error reply has ended the reader.
        if (kernel.isReady && kernel.kernelEpoch === scope.resourceEpoch)
          throw new ManagedSourceDrainedError(error);
        throw error;
      }
    },
    async release(scope: ManagedSourceCleanupScope): Promise<void> {
      if (!scope.operationId || scope.scope.kind !== 'run')
        return;
      if (!kernel.isReady)
        throw new Error('Original experiment source storage is unavailable');
      const original = owner(scope);
      await flights.get(original.recordId)?.work.catch(() => undefined);
      inputs.delete(original.recordId);
      // This is maintenance of the recorded input, not renewed permission to read the project.
      const grant = await kernel.issueGrant({ grantId: `experiment-source-cleanup:${randomUUID()}`,
        owningWorkspace: original.caller.workspaceId, executionWorkspace: original.caller.executionWorkspaceId,
        threadId: original.caller.threadId, runId: original.caller.runId, operationId: scope.operationId,
        capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] });
      const scoped = kernel.scoped(grant);
      try {
        const record = await scoped.getRecord(original.caller.workspaceId, original.recordId);
        if (!record)
          return;
        const intent = intentOf(record, original.identity);
        // The same Storage's new exclusive kernel owner proves the former native
        // capture threads ended. Same-epoch interruption still needs its lease receipt.
        if (scope.source.mode !== 'fixed_branch' && intent.drained !== true && kernel.kernelEpoch === scope.resourceEpoch) {
          if (!scope.physicalRoot || await reconcileExperimentCapture(kernel, original.caller, scope.physicalRoot.canonicalRoot, intent.captureScopes) !== 'drained')
            throw new Error('Original experiment source capture has not drained');
        }
        const cleanup = intent.cleanupOperationId ? await scoped.getOperation(intent.cleanupOperationId) : null;
        const receipt = await scoped.getOperation(`experiment-input-branch:${original.branchId}`);
        if (receipt && receipt.state !== 'committed' && receipt.state !== 'failed')
          throw new Error('Original experiment source creation is unconfirmed');
        if (cleanup?.state === 'committed') {
          const result = cleanup.result as {
            branchId?: string;
            deleted?: boolean;
          } | undefined;
          if (cleanup.state !== 'committed' || result?.branchId !== original.branchId || result.deleted !== true)
            throw new Error('Original experiment input cleanup is unconfirmed');
        }
        else if (cleanup && cleanup.state !== 'failed') {
          throw new Error('Original experiment input cleanup is unconfirmed');
        }
        else if (receipt?.state === 'committed') {
          const result = receipt.result as {
            branchId?: string;
            root?: string;
          } | undefined;
          const branch = await scoped.readBranch({ branchId: original.branchId, includeEntries: false });
          if (result?.branchId !== original.branchId || branch.workspaceId !== original.caller.workspaceId
            || branch.root !== result.root || branch.currentRoot !== result.root)
            throw new Error('Original experiment input branch changed before cleanup');
          const cleanupOperationId = `experiment-source-release:${randomUUID()}`;
          // Persist this exact maintenance command before dispatch. A
          // lost ACK observes it; a failed transaction can retry with
          // a new grant without reusing different native parameters.
          await saveIntent(scoped, original, { ...intent, cleanupOperationId }, record);
          await scoped.deleteBranch({ operationId: cleanupOperationId, branchId: original.branchId });
        }
        if (scope.source.mode === 'fixed_branch')
          await scoped.unpinBranch({ operationId: `${original.pinId}:cleanup:${randomUUID()}`, branchId: scope.source.branch_id!, pinId: original.pinId });
        await scoped.releaseRecord(`experiment-source-intent-release:${original.recordId}`, original.caller.workspaceId, original.recordId);
      }
      finally {
        await kernel.retireGrant(grant.grantId);
      }
    },
  };
}
