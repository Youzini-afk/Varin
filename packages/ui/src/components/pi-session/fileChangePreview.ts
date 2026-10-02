import { diffLines } from 'diff';
import type { PiToolCall, PiToolResultMessage } from '@varin/protocol';
import type { PiToolExecutionState } from '@/stores/usePiSessionStore';

export interface FileChangeLine {
  kind: 'add' | 'remove' | 'context' | 'hunk';
  text: string;
}

export interface FileChangePreview {
  path: string;
  operation: 'add' | 'update' | 'delete' | 'write';
  lines: FileChangeLine[];
  /** Whole-file writes have no before-image in the tool arguments. */
  counts?: { added: number; removed: number };
}

export const isFileChangeTool = (name: string): boolean => name === 'apply_patch' || name === 'edit' || name === 'write';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// A terminating newline ends the previous line; it is not another added line.
const linesOf = (text: string): string[] => {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const withCounts = (file: FileChangePreview): FileChangePreview => ({
  ...file,
  ...(file.operation === 'write' || (file.operation === 'delete' && !file.lines.length) ? {} : {
    counts: {
      added: file.lines.filter(line => line.kind === 'add').length,
      removed: file.lines.filter(line => line.kind === 'remove').length,
    },
  }),
});

/** Tolerates the unfinished final line of Pi's incrementally decoded arguments.
 * This is a display projection, never a patch validator or an application path.
 * Codex context anchors are not file line numbers, so none are synthesized.
 */
export function projectFileChanges(call: PiToolCall, generating = false): FileChangePreview[] {
  const args = record(call.arguments);
  if (!args) return [];
  if (call.name === 'apply_patch' && typeof args.patch === 'string') {
    const files: FileChangePreview[] = [];
    let current: FileChangePreview | undefined;
    const lines = args.patch.replace(/\r\n/g, '\n').split('\n');
    for (const [index, line] of lines.entries()) {
      // A half-generated header must not open a file under a truncated path.
      const completeLine = index < lines.length - 1 || !generating;
      const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
      if (header) {
        current = undefined;
        if (completeLine) {
          current = { path: header[2]!, operation: header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update', lines: [] };
          files.push(current);
        }
        continue;
      }
      if (line === '*** End Patch') break;
      if (!current) continue;
      if (line.startsWith('*** Move to: ') && completeLine) {
        current.path = line.slice('*** Move to: '.length);
      } else if (line.startsWith('@@')) {
        current.lines.push({ kind: 'hunk', text: line });
      } else if (/^[+ -]/.test(line)) {
        current.lines.push({ kind: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context', text: line.slice(1) });
      }
    }
    return files.map(withCounts);
  }
  if (typeof args.path !== 'string' || !args.path) return [];
  if (call.name === 'write' && typeof args.content === 'string') {
    return [{ path: args.path, operation: 'write', lines: linesOf(args.content).map(text => ({ kind: 'add', text })) }];
  }
  if (call.name === 'edit' && Array.isArray(args.edits)) {
    const lines: FileChangeLine[] = [];
    for (const value of args.edits) {
      const edit = record(value);
      if (!edit || typeof edit.oldText !== 'string') continue;
      if (lines.length) lines.push({ kind: 'hunk', text: '…' });
      // Until newText arrives, this is the proposed removal. Empty newText is
      // an intentional deletion and must not be confused with a missing field.
      for (const part of diffLines(edit.oldText, typeof edit.newText === 'string' ? edit.newText : '')) {
        for (const text of linesOf(part.value)) {
          lines.push({ kind: part.added ? 'add' : part.removed ? 'remove' : 'context', text });
        }
      }
    }
    return [withCounts({ path: args.path, operation: 'update', lines })];
  }
  return [];
}

export type FileChangePhase = 'generating' | 'applying' | 'applied' | 'draft' | 'branch' | 'failed' | 'partial' | 'preview';

/** Native execution success alone does not mean a document mutation succeeded.
 * The Host may return a conflict, compensated write, or an unsaved draft.
 */
export function fileChangePhase(
  execution: PiToolExecutionState | undefined,
  result: PiToolResultMessage | undefined,
  generating: boolean,
  path?: string,
): FileChangePhase {
  const output = record(execution?.result);
  const details = record(result?.details) ?? record(output?.details);
  if (result?.isError || execution?.isError || execution?.status === 'error') return 'failed';
  const mutation = record(details?.mutation);
  if (mutation) {
    const paths = Array.isArray(mutation.results) ? mutation.results.map(record) : [];
    const affected = paths.find(row => row?.path === path);
    if (affected) return affected.status === 'applied' ? affected.target === 'surface' ? 'draft' : 'applied' : 'failed';
    if (mutation.status === 'committed') return 'branch';
    if (mutation.status === 'partial') return 'partial';
    return mutation.status === 'applied' ? 'applied' : 'failed';
  }
  if (details?.applied === false) return 'failed';
  if (details?.applied === true || result || execution?.status === 'success') return 'applied';
  if (execution?.status === 'running') return 'applying';
  return generating ? 'generating' : 'preview';
}
