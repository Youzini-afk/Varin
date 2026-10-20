import type { MessageFeedEntry } from '@varin/protocol';
import type { CollaborationMember } from './collaborationFeed';

export function memberBranch(member: CollaborationMember | undefined, preferred?: string): string | undefined {
  const branches = member?.detail?.branches ?? [];
  return (
    (preferred && branches.some((branch) => branch.branchId === preferred) ? preferred : undefined) ??
    branches.find((branch) => branch.activeRunId)?.branchId ??
    branches.at(-1)?.branchId
  );
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const paths = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : [];
/** Only native code notices are exchange cards; ordinary JSON remains message text. */
export function exchangeSummary(message: MessageFeedEntry) {
  if (!message.codeExchangeOperationId) return undefined;
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(message.text));
  } catch {
    return undefined;
  }
  if (!value) return undefined;
  return {
    files: [...new Set([...paths(value.changedFiles), ...paths(value.appliedPaths), ...paths(value.conflictPaths)])],
    state: typeof value.status === 'string' ? value.status : '',
    source: record(value.source),
    target: record(value.target),
  };
}
