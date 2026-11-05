import type { KernelScopedClient } from '../kernel/kernel-client.js';
import type { KernelRecordResult, MaterialRetention } from '../kernel/protocol.generated.js';

const recordTypes = new Set(['ui.work', 'ui.view', 'ui.snapshot', 'ui.selection']);
export const uiRecordTypes = [...recordTypes];
/** Mentions only retain bytes; this never admits access to a work or another family. */
function references(value: unknown): string[] {
  if (typeof value === 'string') return [...value.matchAll(/\b(?:ui:[a-zA-Z0-9_-]+(?:@[1-9]\d*)?|ui-(?:view|snapshot|selection):[a-zA-Z0-9_-]+)/g)].map(match => match[0]);
  if (Array.isArray(value)) return value.flatMap(references);
  return value && typeof value === 'object' ? Object.values(value).flatMap(references) : [];
}
const recordId = (ref: string) => ref.startsWith('ui:') ? ref.split('@')[0]! : ref;
function owners(record: KernelRecordResult, value: Record<string, unknown>): string[] {
  const scope = (input: unknown) => input && typeof input === 'object' && 'threadId' in input && typeof input.threadId === 'string' ? input.threadId : undefined;
  if (record.recordType === 'ui.work' && Array.isArray(value.versions)) return [...new Set(value.versions.flatMap(version => {
    if (!version || typeof version !== 'object') return [];
    const item = version as Record<string, unknown>, owner = scope(item.branchScope) ?? scope(item.messageFragment);
    return owner ? [owner] : [];
  }))];
  const owner = scope(value.branchScope) ?? (value.kind === 'branch-state' ? scope(value.target) : undefined);
  return owner ? [owner] : [];
}

/** Runs under the original store's exclusive activity barrier. Catalog has already
 * retired deleted metadata; live drafts and independent views remain roots too.
 * Read all offset pages before deleting, then trace record edges to a fixed point. */
export async function releaseUiRecords(client: KernelScopedClient, workspaceId: string, plan: MaterialRetention, signal?: AbortSignal) {
  if (!Array.isArray(plan.uiReferences)) throw new Error('Native UI retention roots are unavailable');
  const rows: KernelRecordResult[] = []; let cursor: number | undefined;
  do {
    const page = await client.listRecords({ workspaceId, ...(cursor === undefined ? {} : { cursor }) }, signal);
    rows.push(...page.records.filter(record => recordTypes.has(record.recordType)));
    const next = page.nextCursor ?? undefined;
    if (next !== undefined && next === cursor) throw new Error('UI lifecycle reader did not advance');
    cursor = next;
  } while (cursor !== undefined);
  const root = workspaceId.slice('__varin_ui__:'.length);
  const family = plan.threads.filter(thread => thread.rootThreadId === root);
  const deleted = new Set(plan.threads.filter(thread => thread.release).map(thread => thread.threadId));
  const familyReleased = family.length > 0 && family.every(thread => thread.release);
  const retained = new Set(plan.uiReferences.map(recordId));
  const edges = new Map<string, string[]>();
  for (const record of rows) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(record.payloadJson); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid UI record'); }
    catch { throw new Error('Stored UI content is malformed; the family was not collected'); }
    // Family access is the existing authority boundary. While any member is live,
    // even a not-yet-submitted draft may name a source in this workspace.
    const original = owners(record, value);
    const disposable = record.recordType === 'ui.selection' && value.released === true
      || record.recordType === 'ui.snapshot' && value.selectionOwned === true;
    if (!disposable && (!familyReleased || original.some(thread => !deleted.has(thread)))) retained.add(record.recordId);
    // A snapshot contains viewRef as capture provenance, not ownership of a mutable
    // view. Its source/state are already frozen; retaining the view would retain its
    // latest (possibly unrelated) revision forever.
    const { viewRef: _viewRef, ...content } = value;
    edges.set(record.recordId, references(content).map(recordId));
  }
  const queue = [...retained];
  for (let index = 0; index < queue.length; index++) for (const ref of edges.get(queue[index]!) ?? []) {
    if (!retained.has(ref)) { retained.add(ref); queue.push(ref); }
  }
  let released = 0;
  for (const record of rows) {
    if (retained.has(record.recordId)) {
      if (record.recordType === 'ui.selection') {
        const value = JSON.parse(record.payloadJson) as { released?: boolean; retirementChecked?: boolean };
        if (value.released && !value.retirementChecked) {
          const operationId = `ui-retention:${record.recordId}:${record.recordRevision}`;
          await client.putRecord({ workspaceId, recordId: record.recordId, recordType: record.recordType, state: record.state,
            payloadJson: JSON.stringify({ ...value, retirementChecked: true }), references: record.references, ownerIds: [],
            operationId, expectedRecordRevision: record.recordRevision }, signal);
          await client.releaseOperation(operationId, signal);
        }
      }
      continue;
    }
    signal?.throwIfAborted();
    await client.releaseRecord(`ui-retire:${workspaceId}:${record.recordId}`, workspaceId, record.recordId, signal);
    released++;
  }
  return { released };
}

/** A per-family reader/writer lifetime. A collection waits for actual completion,
 * not HTTP cancellation, and later operations wait for the same owner to resume. */
export function createUiActivity() {
  const states = new Map<string, { active: number; waiting: Array<() => void>; barrier?: Promise<void>; resume?: () => void }>();
  const state = (root: string) => {
    let value = states.get(root);
    if (!value) { value = { active: 0, waiting: [] }; states.set(root, value); }
    return value;
  };
  return {
    async run<T>(root: string, action: () => Promise<T>): Promise<T> {
      const current = state(root);
      while (current.barrier) await current.barrier;
      current.active++;
      try { return await action(); }
      finally { current.active--; if (!current.active) for (const done of current.waiting.splice(0)) done(); }
    },
    async exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
      const current = state(root);
      while (current.barrier) await current.barrier;
      current.barrier = new Promise<void>(resolve => { current.resume = resolve; });
      try {
        if (current.active) await new Promise<void>(resolve => current.waiting.push(resolve));
        return await action();
      } finally { const resume = current.resume; delete current.barrier; delete current.resume; resume?.(); }
    },
  };
}
