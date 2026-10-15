import type { ChatToolResultMessage } from './types';

type FileRange = { byteLength: number; offset: number; nextOffset: number; eof: boolean };
export type ToolResultPreview =
  | { kind: 'diagnostic'; code: string; message: string }
  | { kind: 'missing' | 'directory' | 'unsupported'; path: string }
  | { kind: 'symlink'; path: string; target: string }
  | ({ kind: 'text'; path: string; text: string } & FileRange)
  | ({ kind: 'bytes'; path: string } & FileRange);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const byteOffset = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Read-only formatting of current resource-owner output, never an execution outcome. */
export function presentToolResult(result: Pick<ChatToolResultMessage, 'toolName' | 'details' | 'status' | 'isError'>): ToolResultPreview | undefined {
  const details = record(result.details);
  if (!details) return;
  // Native resource failures carry data, not text parts. Do not turn a failed or
  // indeterminate receipt into a successful file preview, even if it has text.
  if (result.isError || (result.status !== undefined && result.status !== 'success')) {
    if (typeof details.error === 'string' && typeof details.message === 'string') {
      return { kind: 'diagnostic', code: details.error, message: details.message };
    }
    return;
  }
  if (result.toolName !== 'file_read' || typeof details.path !== 'string') return;
  const path = details.path;
  if (details.missing === true) return { kind: 'missing', path };
  if (details.missing !== false) return;
  const state = record(details.state);
  if (state) {
    if (state.kind === 'directory' || state.kind === 'unsupported') return { kind: state.kind, path };
    if (state.kind === 'symlink' && typeof state.symlinkTarget === 'string') return { kind: 'symlink', path, target: state.symlinkTarget };
    return;
  }
  // Both FixedBranch's immutable blob reader and the live file owner return this
  // byte range. Preserve empty reads and partial reads without inventing lines.
  const content = record(details.content);
  if (!content) return;
  const { byteLength, offset, nextOffset, eof } = content;
  if (!byteOffset(byteLength) || !byteOffset(offset) || !byteOffset(nextOffset) || typeof eof !== 'boolean'
    || offset > nextOffset || nextOffset > byteLength || eof !== (nextOffset === byteLength)) return;
  const range = { byteLength, offset, nextOffset, eof };
  if (typeof content.text === 'string' && content.bytesBase64 === undefined) return { kind: 'text', path, text: content.text, ...range };
  if (typeof content.bytesBase64 === 'string' && content.text === undefined) return { kind: 'bytes', path, ...range };
}
