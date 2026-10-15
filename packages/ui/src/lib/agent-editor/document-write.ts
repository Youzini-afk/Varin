import { getDocumentRegistry } from '@/lib/documents/session';
import type { DocumentIdentity } from '@/lib/documents/types';
import { applyHunkDecisions, parseUnifiedHunks } from './patch';
import type { DocumentPatchWriteResult, HunkDecision } from './types';

const endPosition = (content: string): { line: number; character: number } => {
  const lines = content.split('\n');
  return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
};

export const applyPatchDecisionsToDocument = async (input: {
  identity: DocumentIdentity;
  patch: string;
  decisions: readonly HunkDecision[];
  direction: 'apply' | 'revert';
}): Promise<DocumentPatchWriteResult> => {
  const registry = getDocumentRegistry();
  const open = registry.get(input.identity) ?? await registry.open(input.identity);
  if (open.status === 'missing' || open.status === 'deleted') return { status: 'missing' };
  if (open.dirty || open.status === 'conflict' || open.saving) {
    return { status: 'conflict', currentRevision: open.baseRevision, dirty: open.dirty };
  }
  if (open.status !== 'ready') return { status: 'failure', errorMessage: open.status };
  const hunks = parseUnifiedHunks(input.patch);
  if (hunks.length === 0) {
    return { status: 'failure', errorMessage: 'empty-patch' };
  }
  const applied = applyHunkDecisions(
    open.buffer,
    hunks,
    input.decisions,
    input.direction,
  );
  if (applied.status === 'mismatch') {
    return { status: 'failure', errorMessage: `hunk-mismatch:${applied.hunkIndex}` };
  }
  const prepared = await registry.prepareWorkspaceEdit({
    workspaceId: input.identity.workspaceId,
    origin: 'agent-patch-review',
    changes: [{
        kind: 'text',
        identity: input.identity,
      version: open.localEditRevision,
      edits: [{
        range: { start: { line: 0, character: 0 }, end: endPosition(open.buffer) },
        newText: applied.content,
      }],
    }],
  });
  if (prepared.status === 'rejected') {
    const failure = prepared.failures[0];
    if (failure?.reason === 'missing') return { status: 'missing' };
    if (failure?.reason === 'conflict' || failure?.reason === 'saving' || failure?.reason === 'stale-version') {
      const current = registry.get(input.identity);
      return {
        status: 'conflict',
        currentRevision: current?.baseRevision ?? open.baseRevision,
        dirty: current?.dirty ?? false,
      };
    }
    return { status: 'failure', errorMessage: failure?.message ?? 'patch-prepare-rejected' };
  }
  const committed = await registry.applyWorkspaceEdit(prepared.groupId);
  if (committed.status !== 'applied') {
    const current = registry.get(input.identity);
    return {
      status: 'conflict',
      currentRevision: current?.baseRevision ?? open.baseRevision,
      dirty: current?.dirty ?? false,
    };
  }
  const record = committed.records[0];
  return record
    ? { status: 'applied', localEditRevision: record.localEditRevision }
    : { status: 'failure', errorMessage: 'patch-commit-missing-record' };
};
