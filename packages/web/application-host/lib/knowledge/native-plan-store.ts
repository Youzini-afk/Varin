/** Native plan data stays in the existing KnowledgeStore writer. No Catalog/body mirror. */
import { createHash } from 'node:crypto';
import type {
  NativePlanView, NativePlanSnapshot, NativePlanMutationInput, NativePlanMutationReceipt,
  NativePlanMutationResult, NativePlanForkInput, NativePlanForkCapture, NativePlanOrigin,
  NativePlanChanged, NativePlanSelection,
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
  afterCommit(change: NativePlanChanged): void;
}
type Methods = Pick<KnowledgeStore, 'readNativePlanCandidate' | 'readNativePlan' | 'mutateNativePlan' | 'readNativePlanMutation' | 'captureNativePlanFork'>;
const fail = (message: string): never => { throw new KnowledgeMutationError('invalid', message); };
const text = (value: unknown, name: string): string => typeof value === 'string' && value.length > 0
  ? value : fail(`Native plan ${name} is required`);
const nullable = (value: unknown, name: string): string | null => value === null ? null : text(value, name);
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function viewOf(value: NativePlanView): NativePlanView {
  if (!value || typeof value !== 'object') fail('Native plan view is required');
  const view: NativePlanView = { threadId: text(value.threadId, 'Thread'), branchId: text(value.branchId, 'branch'),
    headId: nullable(value.headId, 'head'), inheritedRef: nullable(value.inheritedRef, 'inherited reference'),
    forkBasis: value.forkBasis === null ? null : value.forkBasis && typeof value.forkBasis === 'object'
      ? { sourceBranchId: text(value.forkBasis.sourceBranchId, 'fork source branch'),
        headId: nullable(value.forkBasis.headId, 'fork head'),
        sourceInheritedRef: nullable(value.forkBasis.sourceInheritedRef, 'fork source inherited reference') }
      : fail('Native plan Catalog fork basis is required') };
  return view;
}
function originOf(value: NativePlanOrigin): NativePlanOrigin {
  if (value?.kind === 'user') return { kind: 'user', key: text(value.key, 'user command key') };
  if (value?.kind !== 'tool') return fail('Native plan mutation origin is required');
  const origin: NativePlanOrigin = { kind: 'tool', operationId: text(value.operationId, 'Operation'),
    runId: text(value.runId, 'Run'), requestId: text(value.requestId, 'request'), callId: text(value.callId, 'call'), epoch: value.epoch };
  if (!Number.isSafeInteger(origin.epoch) || origin.epoch < 1
    || origin.operationId !== `${origin.requestId}:tool:${origin.callId}`) fail('Native plan tool origin is not a real model call');
  return origin;
}
function selectionOf(value: NativePlanSelection | undefined): NativePlanSelection {
  if (!value || typeof value !== 'object') return fail('Native plan visibility selection is required');
  return { latestRef: nullable(value.latestRef, 'selection latest reference'), selectedRef: nullable(value.selectedRef, 'selection reference') };
}

function inputOf(value: NativePlanMutationInput): NativePlanMutationInput {
  if (!value || typeof value !== 'object' || typeof value.content !== 'string') fail('Native plan content is required');
  return { view: viewOf(value.view), origin: originOf(value.origin), expectedRef: nullable(value.expectedRef, 'expected reference'), content: value.content, ...(value.selection ? { selection: selectionOf(value.selection) } : {}) };
}

export function createNativePlanStore(owner: Owner): Methods {
  const one = (type: string, key: string): Row | null => {
    const rows = owner.lookup({ type, dedupeKey: key });
    if (rows.length > 1) fail('Native plan identity has duplicate authoritative records');
    return rows[0] ?? null;
  };
  const load = (ref: string | null, threadId: string): NativePlanSnapshot | null => {
    if (ref === null) return null;
    const row = one('native_plan_version', ref);
    if (!row) return fail('Native plan version is unavailable');
    const p = row.payload;
    if (p['threadId'] !== threadId || p['ref'] !== ref) fail('Native plan reference belongs to another Thread');
    if (typeof p['content'] !== 'string' || !Number.isSafeInteger(p['updatedAt'])
      || !['user', 'agent'].includes(String(p['updatedBy']))) fail('Native plan version is corrupt');
    return { ref, threadId, branchId: text(p['branchId'], 'stored branch'), sourceHeadId: nullable(p['sourceHeadId'], 'stored head'),
      previousRef: nullable(p['previousRef'], 'previous reference'), content: p['content'] as string,
      updatedBy: p['updatedBy'] as 'user' | 'agent', updatedAt: p['updatedAt'] as number };
  };
  const ownerKey = (view: NativePlanView): string => `native-plan-owner:${digest([view.threadId, view.branchId])}`;
  const branch = (view: NativePlanView): { row: Row | null; latestRef: string | null } => {
    if (view.forkBasis) {
      const capture = one('native_plan_fork', `native-plan-fork:${digest(view.branchId)}`)?.payload['capture'] as NativePlanForkCapture | undefined;
      if (!capture || capture.sourceThreadId !== view.threadId || capture.sourceBranchId !== view.forkBasis.sourceBranchId
        || capture.targetBranchId !== view.branchId || capture.headId !== view.forkBasis.headId
        || capture.inheritedRef !== view.forkBasis.sourceInheritedRef || capture.capturedRef !== view.inheritedRef) {
        fail('Native plan fork capture does not match Catalog creation');
      }
    } else if (view.inheritedRef !== null) {
      fail('Native plan root has no inherited reference');
    }
    // A failed fork can leave an orphan capture naming a real root/legacy branch.
    // Only Catalog creation evidence above makes a capture authoritative for that branch.
    const row = one('native_plan_owner', ownerKey(view));
    if (!row) return { row, latestRef: view.inheritedRef };
    if (row.payload['threadId'] !== view.threadId || row.payload['branchId'] !== view.branchId
      || row.payload['inheritedRef'] !== view.inheritedRef) fail('Native plan branch basis changed');
    const latestRef = nullable(row.payload['currentRef'], 'current reference');
    const current = load(latestRef, view.threadId);
    if (!current || current.branchId !== view.branchId) fail('Native plan branch owner is corrupt');
    return { row, latestRef };
  };
  const selected = (view: NativePlanView, latestRef: string | null, selection: NativePlanSelection): NativePlanSnapshot | null => {
    if (selection.latestRef !== latestRef) throw new KnowledgeMutationError('conflict', 'Native plan selection is stale');
    return load(selection.selectedRef, view.threadId);
  };
  const identities = (input: NativePlanMutationInput) => {
    const { view, origin } = input;
    // Operation identity survives recovery. Scope and frozen origin belong in the
    // checked intent, so changing them cannot evade an existing receipt.
    const key = digest(origin.kind === 'tool'
      ? ['tool', origin.operationId]
      : ['user', view.threadId, view.branchId, origin.key]);
    const intentHash = digest({ threadId: view.threadId, branchId: view.branchId, headId: view.headId,
      inheritedRef: view.inheritedRef, forkBasis: view.forkBasis, origin, expectedRef: input.expectedRef, content: input.content });
    return { key: `native-plan-receipt:${key}`, ref: `native-plan:${key}`, intentHash };
  };
  const result = (receipt: NativePlanMutationReceipt): NativePlanMutationResult => ({ receipt, plan: load(receipt.ref, receipt.threadId) });
  const prior = (input: NativePlanMutationInput): NativePlanMutationResult | null => {
    const ids = identities(input), row = one('native_plan_receipt', ids.key);
    if (!row) return null;
    const receipt = row.payload['receipt'] as NativePlanMutationReceipt | undefined;
    if (!receipt || receipt.threadId !== input.view.threadId || receipt.branchId !== input.view.branchId
      || receipt.intentHash !== ids.intentHash || JSON.stringify(originOf(receipt.origin)) !== JSON.stringify(input.origin)
      || !['applied', 'conflict'].includes(receipt.status)) return fail('Native plan mutation origin was reused with a different intent');
    nullable(receipt.ref, 'receipt reference');
    return result(receipt);
  };
  const insert = (payload: Payload): TransactionOperation => ({ type: 'insert', vector: owner.vector, payload });
  return {
    readNativePlanCandidate(input, ref) {
      const view = viewOf(input);
      const requested = ref === undefined ? undefined : nullable(ref, 'candidate reference');
      return owner.enqueue(() => {
        const latestRef = branch(view).latestRef;
        const plan = load(requested === undefined ? latestRef : requested, view.threadId);
        return { latestRef, candidate: plan ? { ref: plan.ref, sourceHeadId: plan.sourceHeadId, previousRef: plan.previousRef, updatedAt: plan.updatedAt } : null };
      });
    },
    readNativePlan(input, proof) {
      const view = viewOf(input), selection = selectionOf(proof);
      return owner.enqueue(() => selected(view, branch(view).latestRef, selection));
    },
    readNativePlanMutation(value) {
      const input = inputOf(value);
      return owner.enqueue(() => prior(input));
    },
    mutateNativePlan(value) {
      const input = inputOf(value);
      return owner.enqueue(() => {
        const replay = prior(input);
        if (replay) return replay;
        const { view, origin } = input, ids = identities(input), currentOwner = branch(view);
        const selection = selectionOf(input.selection);
        // CAS is against the actual latest owner, never merely a historical visible version.
        if (currentOwner.latestRef === input.expectedRef && selection.latestRef !== currentOwner.latestRef) {
          throw new KnowledgeMutationError('conflict', 'Native plan selection is stale');
        }
        const conflict = currentOwner.latestRef !== input.expectedRef || selection.selectedRef !== currentOwner.latestRef;
        const current = conflict ? null : selected(view, currentOwner.latestRef, selection);
        const receipt: NativePlanMutationReceipt = { threadId: view.threadId, branchId: view.branchId,
          origin, intentHash: ids.intentHash, status: conflict ? 'conflict' : 'applied', ref: conflict ? currentOwner.latestRef : ids.ref };
        const receiptRow = insert({ type: 'native_plan_receipt', dedupeKey: ids.key, receipt });
        if (conflict) { owner.commit([receiptRow]); return result(receipt); }
        const version: NativePlanSnapshot = { ref: ids.ref, threadId: view.threadId, branchId: view.branchId,
          sourceHeadId: view.headId, previousRef: current?.ref ?? null, content: input.content,
          updatedBy: origin.kind === 'user' ? 'user' : 'agent', updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1) };
        const pointer = { type: 'native_plan_owner', dedupeKey: ownerKey(view), threadId: view.threadId,
          branchId: view.branchId, inheritedRef: view.inheritedRef, currentRef: version.ref };
        owner.commit([insert({ type: 'native_plan_version', dedupeKey: version.ref, ...version }),
          currentOwner.row ? { type: 'updatePayload', id: currentOwner.row.id, payload: pointer } : insert(pointer), receiptRow]);
        owner.afterCommit({ threadId: view.threadId, branchId: view.branchId, ref: version.ref });
        return { receipt, plan: version };
      });
    },
    captureNativePlanFork(value: NativePlanForkInput) {
      const view = viewOf(value.source), targetBranchId = text(value.targetBranchId, 'fork target');
      const selection = value.selection === undefined ? undefined : selectionOf(value.selection);
      if (targetBranchId === view.branchId) fail('Native plan fork must name a distinct branch');
      const identity = { sourceThreadId: view.threadId, sourceBranchId: view.branchId,
        targetBranchId, headId: view.headId, inheritedRef: view.inheritedRef };
      const key = `native-plan-fork:${digest(targetBranchId)}`;
      return owner.enqueue(() => {
        const existing = one('native_plan_fork', key);
        if (existing) {
          const capture = existing.payload['capture'] as NativePlanForkCapture | undefined;
          if (!capture || Object.entries(identity).some(([name, value]) => capture[name as keyof NativePlanForkCapture] !== value)) {
            return fail('Native plan fork target was reused with different input');
          }
          // Verify that null stays null and an existing captured reference is intact.
          load(nullable(capture.capturedRef, 'fork reference'), view.threadId);
          return capture;
        }
        const capturedRef = selected(view, branch(view).latestRef, selectionOf(selection))?.ref ?? null;
        const capture: NativePlanForkCapture = { ...identity, capturedRef };
        owner.commit([insert({ type: 'native_plan_fork', dedupeKey: key, capture })]);
        return capture;
      });
    },
  };
}
