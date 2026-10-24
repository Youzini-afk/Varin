import { diffArrays } from 'diff';
import type { ChatToolCall, ChatToolResultMessage } from './types';
import type { ChatToolExecutionState } from './types';

export interface FileChangeLine {
  kind: 'add' | 'remove' | 'context' | 'hunk';
  text: string;
  /**
   * Source identity, stable while the arguments stream and after they finish:
   * old line `e{edit}o{i}`, new line `e{edit}n{j}`, patch line `p{i}`, written
   * line `w{i}`. A row keeps its DOM when its kind or text changes.
   */
  key?: string;
  /** The line being written. */
  pending?: boolean;
  /** Writing over an old line with the same prefix: characters written so far. */
  typed?: number;
  /** An old line after the write cursor, not decided yet. */
  ahead?: boolean;
}

export interface FileChangePreview {
  /** Empty only while a streamed call has not supplied a complete path yet. */
  path: string;
  operation: 'add' | 'update' | 'delete' | 'write';
  lines: FileChangeLine[];
  /** Whole-file writes have no before-image in the tool arguments. */
  counts?: { added: number; removed: number };
}

export const isFileChangeTool = (name: string): boolean => name === 'apply_patch' || name === 'file_edit' || name === 'file_write';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Turn summaries only need file identities; do not diff or split full writes. */
export function fileChangeTargets(call: ChatToolCall): Array<Pick<FileChangePreview, 'path' | 'operation'>> {
  const args = record(call.arguments);
  if (!args) return [];
  if ((call.name === 'file_write' || call.name === 'file_edit') && typeof args.path === 'string' && args.path) {
    return [{ path: args.path, operation: call.name === 'file_write' ? 'write' : 'update' }];
  }
  if (call.name !== 'apply_patch' || typeof args.patch !== 'string') return [];
  const files: Array<Pick<FileChangePreview, 'path' | 'operation'>> = [];
  const headers = /^\*\*\* (?:((?:Add|Update|Delete) File): ([^\r\n]+)|Move to: ([^\r\n]+)|End Patch\r?$)/gm;
  for (const match of args.patch.matchAll(headers)) {
    if (match[1]) files.push({ path: match[2]!, operation: match[1] === 'Add File' ? 'add' : match[1] === 'Delete File' ? 'delete' : 'update' });
    else if (match[3]) { const current = files.at(-1); if (current) current.path = match[3]; }
    else break;
  }
  return files;
}

// A terminating newline ends the previous line; it is not another added line.
const linesOf = (text: string): string[] => {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

type LineOp = { kind: 'add'; ni: number } | { kind: 'remove'; oi: number } | { kind: 'context'; oi: number; ni: number };

/** Line diff with source indices; within a change, removals precede additions. */
const lineOps = (before: string[], after: string[]): LineOp[] => {
  const ops: LineOp[] = [];
  let oi = 0;
  let ni = 0;
  for (const part of diffArrays(before, after)) {
    for (let index = 0; index < part.value.length; index += 1) {
      if (part.added) ops.push({ kind: 'add', ni: ni++ });
      else if (part.removed) ops.push({ kind: 'remove', oi: oi++ });
      else ops.push({ kind: 'context', oi: oi++, ni: ni++ });
    }
  }
  return ops;
};

/**
 * One edit's rows. While `newText` streams, the part before the last matching
 * line is decided; old lines after it stay proposed removals, faded as
 * `ahead`. A line being written over an old line with the same prefix is
 * shown on that old line (`typed`) instead of flashing as an addition first.
 */
const editLines = (edit: number, oldText: string, newText: string | undefined, oldDone: boolean, newDone: boolean): FileChangeLine[] => {
  const oldKey = (index: number) => `e${edit}o${index}`;
  const newKey = (index: number) => `e${edit}n${index}`;
  // `linesOf` keeps an unfinished last line; it is the one being written.
  const oldLines = linesOf(oldText);
  if (newText === undefined) {
    return oldLines.map((text, index) => ({ key: oldKey(index), kind: 'remove', text,
      ...(!oldDone && index === oldLines.length - 1 && !oldText.endsWith('\n') ? { pending: true } : {}) }));
  }
  const written = newText.replace(/\r\n/g, '\n').split('\n');
  const partial = newDone ? undefined : written.pop();
  const newLines = newDone ? linesOf(newText) : written;
  const ops = lineOps(oldLines, newLines);
  const row = (op: LineOp): FileChangeLine => op.kind === 'add'
    ? { key: newKey(op.ni), kind: 'add', text: newLines[op.ni]! }
    : { key: oldKey(op.oi), kind: op.kind, text: oldLines[op.oi]! };
  if (newDone) return ops.map(row);
  let lastContext = -1;
  ops.forEach((op, index) => { if (op.kind === 'context') lastContext = index; });
  const tail = ops.slice(lastContext + 1);
  const rows = [...ops.slice(0, lastContext + 1).map(row), ...tail.filter(op => op.kind === 'add').map(row)];
  const removes = tail.filter((op): op is Extract<LineOp, { kind: 'remove' }> => op.kind === 'remove');
  // Indentation alone matches any indented line; wait for the first character.
  const over = partial?.trim() ? removes.find(op => oldLines[op.oi]!.startsWith(partial)) : undefined;
  if (over && partial) rows.push({ key: oldKey(over.oi), kind: 'context', text: oldLines[over.oi]!, pending: true, typed: partial.length });
  else if (partial) rows.push({ key: newKey(newLines.length), kind: 'add', text: partial, pending: true });
  for (const op of removes) if (op !== over) rows.push({ ...row(op), ahead: true });
  return rows;
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

/** Tolerates the unfinished final line of incrementally decoded arguments.
 * This is a display projection, never a patch validator or an application path.
 * Codex context anchors are not file line numbers, so none are synthesized.
 */
export function projectFileChanges(call: ChatToolCall, generating = false): FileChangePreview[] {
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
      const identity = { key: `p${index}`, ...(completeLine ? {} : { pending: true }) };
      if (line.startsWith('*** Move to: ') && completeLine) {
        current.path = line.slice('*** Move to: '.length);
      } else if (line.startsWith('@@')) {
        current.lines.push({ kind: 'hunk', text: line, ...identity });
      } else if (/^[+ -]/.test(line)) {
        current.lines.push({ kind: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context', text: line.slice(1), ...identity });
      }
    }
    return files.map(withCounts);
  }
  const path = typeof args.path === 'string' ? args.path : '';
  // JSON property order is not guaranteed. Content can arrive before the path;
  // display it immediately without inventing a navigable file identity.
  if (!path && !generating) return [];
  if (call.name === 'file_write' && (generating || typeof args.content === 'string')) {
    const content = typeof args.content === 'string' ? args.content : '';
    const lines = linesOf(content);
    const writing = generating && Boolean(content) && !content.endsWith('\n');
    return [{ path, operation: 'write', lines: lines.map((text, index) => ({ key: `w${index}`, kind: 'add', text,
      ...(writing && index === lines.length - 1 ? { pending: true } : {}) })) }];
  }
  if (call.name === 'file_edit' && (generating || Array.isArray(args.edits))) {
    const lines: FileChangeLine[] = [];
    const edits = Array.isArray(args.edits) ? args.edits : [];
    for (const [index, value] of edits.entries()) {
      const edit = record(value);
      if (!edit || (typeof edit.oldText !== 'string' && (!generating || typeof edit.newText !== 'string'))) continue;
      if (lines.length) lines.push({ key: `e${index}h`, kind: 'hunk', text: '…' });
      // Until newText arrives, this is the proposed removal. Empty newText is
      // an intentional deletion and must not be confused with a missing field.
      // While generating, an edit is complete once a later one has begun.
      const later = index < edits.length - 1;
      const newText = typeof edit.newText === 'string' ? edit.newText : generating && !later ? undefined : '';
      lines.push(...editLines(index, typeof edit.oldText === 'string' ? edit.oldText : '', newText,
        !generating || later || newText !== undefined, !generating || later));
    }
    return [withCounts({ path, operation: 'update', lines })];
  }
  return [];
}

/**
 * The streamed text of a file-changing call, in the order it is written: the
 * patch, the written content, or each edit's old text then new text.
 */
const streamedFields = (call: ChatToolCall): string[] => {
  const args = record(call.arguments);
  if (!args) return [];
  if (call.name === 'apply_patch') return typeof args.patch === 'string' ? [args.patch] : [];
  if (call.name === 'file_write') return typeof args.content === 'string' ? [args.content] : [];
  if (call.name !== 'file_edit' || !Array.isArray(args.edits)) return [];
  return args.edits.flatMap(value => {
    const edit = record(value);
    return edit ? [typeof edit.oldText === 'string' ? edit.oldText : '', ...(typeof edit.newText === 'string' ? [edit.newText] : [])] : [];
  });
};

/** Characters a file-changing call has streamed so far. */
export const fileChangeStreamLength = (call: ChatToolCall): number => streamedFields(call).reduce((sum, field) => sum + field.length, 0);

/**
 * The call as it reads after `budget` streamed characters, for pacing the
 * preview at reading speed. Fields are cut in writing order, so a new text
 * never appears before its old text is complete. Other arguments (the path)
 * pass through as received.
 */
export function paceFileChangeCall(call: ChatToolCall, budget: number): ChatToolCall {
  const args = record(call.arguments);
  if (!args || budget >= fileChangeStreamLength(call)) return call;
  let left = Math.max(0, Math.floor(budget));
  const take = (text: string): string => { const part = text.slice(0, left); left -= part.length; return part; };
  if (call.name === 'apply_patch' && typeof args.patch === 'string') return { ...call, arguments: { ...args, patch: take(args.patch) } };
  if (call.name === 'file_write' && typeof args.content === 'string') return { ...call, arguments: { ...args, content: take(args.content) } };
  if (call.name !== 'file_edit' || !Array.isArray(args.edits)) return call;
  const edits: unknown[] = [];
  for (const value of args.edits) {
    const edit = record(value);
    if (!edit) continue;
    if (left <= 0 && edits.length) break;
    const oldText = typeof edit.oldText === 'string' ? edit.oldText : '';
    const pacedOld = take(oldText);
    const { newText, ...rest } = edit;
    if (pacedOld.length < oldText.length || typeof newText !== 'string') {
      edits.push({ ...rest, oldText: pacedOld });
      if (pacedOld.length < oldText.length) break;
      continue;
    }
    edits.push({ ...rest, oldText: pacedOld, newText: take(newText) });
  }
  return { ...call, arguments: { ...args, edits } as ChatToolCall['arguments'] };
}

export type FileChangePhase = 'generating' | 'applying' | 'applied' | 'draft' | 'branch' | 'failed' | 'partial' | 'preview';

/** Native execution success alone does not mean a document mutation succeeded.
 * The Host may return a conflict, compensated write, or an unsaved draft.
 */
export function fileChangePhase(
  execution: ChatToolExecutionState | undefined,
  result: ChatToolResultMessage | undefined,
  generating: boolean,
  path?: string,
): FileChangePhase {
  const output = record(execution?.result);
  const details = record(result?.details) ?? output;
  if (result?.isError || execution?.isError || execution?.status === 'error') return 'failed';
  if (result?.status === 'cancelled' || result?.status === 'unknown' || execution?.status === 'cancelled' || execution?.status === 'unknown') return 'preview';
  const mutation = record(details?.mutation);
  if (mutation) {
    const paths = Array.isArray(mutation.results) ? mutation.results.map(record) : [];
    const affected = paths.find(row => row?.path === path);
    if (affected) return affected.status === 'applied' ? affected.target === 'surface' ? 'draft' : 'applied' : 'failed';
    if (mutation.status === 'committed') return 'branch';
    if (mutation.status === 'partial') return 'partial';
    return mutation.status === 'applied' ? 'applied' : 'failed';
  }
  if (details?.status === 'applied') return 'applied';
  if (details?.applied === false) return 'failed';
  if (details?.applied === true) return 'applied';
  if (execution?.status === 'running') return 'applying';
  return generating ? 'generating' : 'preview';
}
