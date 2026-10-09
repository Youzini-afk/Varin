/** Plan data stays in the existing KnowledgeStore writer. No Catalog/body mirror. */
import { createHash } from 'node:crypto';
import type {
  PlanView, PlanSnapshot, PlanMutationInput, PlanMutationReceipt,
  PlanMutationResult, PlanForkInput, PlanForkCapture, PlanOrigin,
  PlanChanged, PlanSelection,
} from '@varin/protocol';
import { KnowledgeMutationError, type KnowledgeStore } from './store-contract.js';

type Payload = Record<string, unknown>;
type Row = { id: number; payload: Payload };
type TransactionOperation = import('triviumdb').TransactionOperation;
interface Owner {
  lookup(equalities: Record<string, string>): Row[];
  enqueue<T>(operation: () => T): Promise<T>;
  commit(operations: TransactionOperation[]): void;
  vector: number[];
  afterCommit(change: PlanChanged): void;
}
type Methods = Pick<KnowledgeStore, 'readPlanCandidate' | 'readPlan' | 'mutatePlan' | 'readPlanMutation' | 'capturePlanFork'>;
const fail = (message: string): never => { throw new KnowledgeMutationError('invalid', message); };
const text = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0
  ? value : fail(`Plan ${name} is required`);
const nullable = (value: unknown, name: string): string | null => value === null ? null : text(value, name);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function viewOf(value: PlanView): PlanView {
  if (!value || typeof value !== 'object') fail('Plan view is required');
  const view: PlanView = { threadId: text(value.threadId, 'Thread'), branchId: text(value.branchId, 'branch'),
    headId: nullable(value.headId, 'head'), inheritedRef: nullable(value.inheritedRef, 'inherited reference'),
    forkBasis: value.forkBasis === null ? null : value.forkBasis && typeof value.forkBasis === 'object'
      ? { sourceBranchId: text(value.forkBasis.sourceBranchId, 'fork source branch'),
        headId: nullable(value.forkBasis.headId, 'fork head'),
        sourceInheritedRef: nullable(value.forkBasis.sourceInheritedRef, 'fork source inherited reference') }
      : fail('Plan Catalog fork basis is required') };
  return view;
}
function originOf(value: PlanOrigin): PlanOrigin {
  if (value?.kind === 'user') return { kind: 'user', key: text(value.key, 'user command key') };
  if (value?.kind !== 'tool') return fail('Plan mutation origin is required');
  const origin: PlanOrigin = { kind: 'tool', operationId: text(value.operationId, 'Operation'),
    runId: text(value.runId, 'Run'), requestId: text(value.requestId, 'request'), callId: text(value.callId, 'call'), epoch: value.epoch };
  if (!Number.isSafeInteger(origin.epoch) || origin.epoch < 1
    || origin.operationId !== `${origin.requestId}:tool:${origin.callId}`) fail('Plan tool origin is not a real model call');
  return origin;
}
function selectionOf(value: PlanSelection | undefined): PlanSelection {
  if (!value || typeof value !== 'object') return fail('Plan visibility selection is required');
  return { latestRef: nullable(value.latestRef, 'selection latest reference'), selectedRef: nullable(value.selectedRef, 'selection reference') };
}

function inputOf(value: PlanMutationInput): PlanMutationInput {
  if (!value || typeof value !== 'object' || typeof value.content !== 'string') fail('Plan content is required');
  return { view: viewOf(value.view), origin: originOf(value.origin), expectedRef: nullable(value.expectedRef, 'expected reference'), content: value.content, ...(value.selection ? { selection: selectionOf(value.selection) } : {}) };
}

export function createPlanStore(owner: Owner): Methods {
  const one = (type: string, key: string): Row | null => {
    const rows = owner.lookup({ type, dedupeKey: key });
    if (rows.length > 1) fail('Plan identity has duplicate authoritative records');
    return rows[0] ?? null;
  };
  const load = (ref: string | null, threadId: string): PlanSnapshot | null => {
    if (ref === null) return null;
    const row = one('plan_version', ref);
    if (!row) return fail('Plan version is unavailable');
    const p = row.payload;
    if (p['threadId'] !== threadId || p['ref'] !== ref) fail('Plan reference belongs to another Thread');
    if (typeof p['content'] !== 'string' || !Number.isSafeInteger(p['updatedAt'])
      || !['user', 'agent'].includes(String(p['updatedBy']))) fail('Plan version is corrupt');
    return { ref, threadId, branchId: text(p['branchId'], 'stored branch'), sourceHeadId: nullable(p['sourceHeadId'], 'stored head'),
      previousRef: nullable(p['previousRef'], 'previous reference'), content: p['content'] as string,
      updatedBy: p['updatedBy'] as 'user' | 'agent', updatedAt: p['updatedAt'] as number };
  };
  const ownerKey = (view: PlanView): string => `plan-owner:${digest([view.threadId, view.branchId])}`;
  const branch = (view: PlanView): { row: Row | null; latestRef: string | null } => {
    if (view.forkBasis) {
      const capture = one('plan_fork', `plan-fork:${digest(view.branchId)}`)?.payload['capture'] as PlanForkCapture | undefined;
      if (!capture || capture.sourceThreadId !== view.threadId || capture.sourceBranchId !== view.forkBasis.sourceBranchId
        || capture.targetBranchId !== view.branchId || capture.headId !== view.forkBasis.headId
        || capture.inheritedRef !== view.forkBasis.sourceInheritedRef || capture.capturedRef !== view.inheritedRef) {
        fail('Plan fork capture does not match Catalog creation');
      }
    } else if (view.inheritedRef !== null) {
      fail('Plan root has no inherited reference');
    }
    // A failed fork can leave an orphan capture naming a real root/legacy branch.
    // Only Catalog creation evidence above makes a capture authoritative for that branch.
    const row = one('plan_owner', ownerKey(view));
    if (!row) return { row, latestRef: view.inheritedRef };
    if (row.payload['threadId'] !== view.threadId || row.payload['branchId'] !== view.branchId
      || row.payload['inheritedRef'] !== view.inheritedRef) fail('Plan branch basis changed');
    const latestRef = nullable(row.payload['currentRef'], 'current reference');
    const current = load(latestRef, view.threadId);
    if (!current || current.branchId !== view.branchId) fail('Plan branch owner is corrupt');
    return { row, latestRef };
  };
  const selected = (view: PlanView, latestRef: string | null, selection: PlanSelection): PlanSnapshot | null => {
    if (selection.latestRef !== latestRef) throw new KnowledgeMutationError('conflict', 'Plan selection is stale');
    return load(selection.selectedRef, view.threadId);
  };
  const identities = (input: PlanMutationInput) => {
    const { view, origin } = input;
    // Operation identity survives recovery. Scope and frozen origin belong in the
    // checked intent, so changing them cannot evade an existing receipt.
    const key = digest(origin.kind === 'tool'
      ? ['tool', origin.operationId]
      : ['user', view.threadId, view.branchId, origin.key]);
    const intentHash = digest({ threadId: view.threadId, branchId: view.branchId, headId: view.headId,
      inheritedRef: view.inheritedRef, forkBasis: view.forkBasis, origin, expectedRef: input.expectedRef, content: input.content });
    return { key: `plan-receipt:${key}`, ref: `plan:${key}`, intentHash };
  };
  const result = (receipt: PlanMutationReceipt): PlanMutationResult => ({ receipt, plan: load(receipt.ref, receipt.threadId) });
  const prior = (input: PlanMutationInput): PlanMutationResult | null => {
    const ids = identities(input), row = one('plan_receipt', ids.key);
    if (!row) return null;
    const receipt = row.payload['receipt'] as PlanMutationReceipt | undefined;
    if (!receipt || receipt.threadId !== input.view.threadId || receipt.branchId !== input.view.branchId
      || receipt.intentHash !== ids.intentHash || JSON.stringify(originOf(receipt.origin)) !== JSON.stringify(input.origin)
      || !['applied', 'conflict'].includes(receipt.status)) return fail('Plan mutation origin was reused with a different intent');
    nullable(receipt.ref, 'receipt reference');
    return result(receipt);
  };
  const insert = (payload: Payload): TransactionOperation => ({ type: 'insert', vector: owner.vector, payload });
  return {
    readPlanCandidate(input, ref) {
      const view = viewOf(input);
      const requested = ref === undefined ? undefined : nullable(ref, 'candidate reference');
      return owner.enqueue(() => {
        const latestRef = branch(view).latestRef;
        const plan = load(requested === undefined ? latestRef : requested, view.threadId);
        return { latestRef, candidate: plan ? { ref: plan.ref, sourceHeadId: plan.sourceHeadId, previousRef: plan.previousRef, updatedAt: plan.updatedAt } : null };
      });
    },
    readPlan(input, proof) {
      const view = viewOf(input), selection = selectionOf(proof);
      return owner.enqueue(() => selected(view, branch(view).latestRef, selection));
    },
    readPlanMutation(value) {
      const input = inputOf(value);
      return owner.enqueue(() => prior(input));
    },
    mutatePlan(value) {
      const input = inputOf(value);
      return owner.enqueue(() => {
        const replay = prior(input);
        if (replay) return replay;
        const { view, origin } = input, ids = identities(input), currentOwner = branch(view);
        const selection = selectionOf(input.selection);
        // CAS is against the actual latest owner, never merely a historical visible version.
        if (currentOwner.latestRef === input.expectedRef && selection.latestRef !== currentOwner.latestRef) {
          throw new KnowledgeMutationError('conflict', 'Plan selection is stale');
        }
        const conflict = currentOwner.latestRef !== input.expectedRef || selection.selectedRef !== currentOwner.latestRef;
        const current = conflict ? null : selected(view, currentOwner.latestRef, selection);
        const receipt: PlanMutationReceipt = { threadId: view.threadId, branchId: view.branchId,
          origin, intentHash: ids.intentHash, status: conflict ? 'conflict' : 'applied', ref: conflict ? currentOwner.latestRef : ids.ref };
        const receiptRow = insert({ type: 'plan_receipt', dedupeKey: ids.key, receipt });
        if (conflict) { owner.commit([receiptRow]); return result(receipt); }
        const version: PlanSnapshot = { ref: ids.ref, threadId: view.threadId, branchId: view.branchId,
          sourceHeadId: view.headId, previousRef: current?.ref ?? null, content: input.content,
          updatedBy: origin.kind === 'user' ? 'user' : 'agent', updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1) };
        const pointer = { type: 'plan_owner', dedupeKey: ownerKey(view), threadId: view.threadId,
          branchId: view.branchId, inheritedRef: view.inheritedRef, currentRef: version.ref };
        owner.commit([insert({ type: 'plan_version', dedupeKey: version.ref, ...version }),
          currentOwner.row ? { type: 'updatePayload', id: currentOwner.row.id, payload: pointer } : insert(pointer), receiptRow]);
        owner.afterCommit({ threadId: view.threadId, branchId: view.branchId, ref: version.ref });
        return { receipt, plan: version };
      });
    },
    capturePlanFork(value: PlanForkInput) {
      const view = viewOf(value.source), targetBranchId = text(value.targetBranchId, 'fork target');
      const selection = value.selection === undefined ? undefined : selectionOf(value.selection);
      if (targetBranchId === view.branchId) fail('Plan fork must name a distinct branch');
      const identity = { sourceThreadId: view.threadId, sourceBranchId: view.branchId,
        targetBranchId, headId: view.headId, inheritedRef: view.inheritedRef };
      const key = `plan-fork:${digest(targetBranchId)}`;
      return owner.enqueue(() => {
        const existing = one('plan_fork', key);
        if (existing) {
          const capture = existing.payload['capture'] as PlanForkCapture | undefined;
          if (!capture || Object.entries(identity).some(([name, value]) => capture[name as keyof PlanForkCapture] !== value)) {
            return fail('Plan fork target was reused with different input');
          }
          // Verify that null stays null and an existing captured reference is intact.
          load(nullable(capture.capturedRef, 'fork reference'), view.threadId);
          return capture;
        }
        const capturedRef = selected(view, branch(view).latestRef, selectionOf(selection))?.ref ?? null;
        const capture: PlanForkCapture = { ...identity, capturedRef };
        owner.commit([insert({ type: 'plan_fork', dedupeKey: key, capture })]);
        return capture;
      });
    },
  };
}
