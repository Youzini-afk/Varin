/** Byte-exact incremental matching over original durable log pages. Only the
 * numeric prefix/cursor is retained by Catalog; this compiled pattern is transient. */
import { setImmediate as yieldTurn } from 'node:timers/promises';

export interface LogLiteralMatcher { bytes: Buffer; failure: Uint32Array }
const QUANTUM = 64 * 1024;
export async function compileLogLiteral(literal: string, signal?: AbortSignal): Promise<LogLiteralMatcher> {
  const bytes = Buffer.from(literal, 'utf8');
  if (!bytes.length) throw new Error('A log literal must not be empty');
  const failure = new Uint32Array(bytes.length);
  for (let i = 1, prefix = 0; i < bytes.length; i++) {
    while (prefix > 0 && bytes[i] !== bytes[prefix]) prefix = failure[prefix - 1]!;
    if (bytes[i] === bytes[prefix]) prefix++;
    failure[i] = prefix;
    if (i % QUANTUM === 0) { await yieldTurn(); signal?.throwIfAborted(); }
  }
  signal?.throwIfAborted();
  return { bytes, failure };
}
export async function* matchLogPage(matcher: LogLiteralMatcher, page: Buffer, offset: number, matchedPrefix: number, signal?: AbortSignal) {
  const { bytes, failure } = matcher;
  if (!Number.isSafeInteger(matchedPrefix) || matchedPrefix < 0 || matchedPrefix >= bytes.length) throw new Error('Original log matcher cursor is invalid');
  let prefix = matchedPrefix;
  for (let i = 0; i < page.length; i++) {
    while (prefix > 0 && page[i] !== bytes[prefix]) prefix = failure[prefix - 1]!;
    if (page[i] === bytes[prefix]) prefix++;
    const endOffset = offset + i + 1;
    if (prefix === bytes.length) {
      prefix = failure[prefix - 1]!; // Preserve suffixes for overlapping matches.
      signal?.throwIfAborted();
      yield { offset: endOffset, matchedPrefix: prefix, match: { startOffset: endOffset - bytes.length, endOffset } };
    }
    if ((i + 1) % QUANTUM === 0) { await yieldTurn(); signal?.throwIfAborted(); }
  }
  signal?.throwIfAborted();
  yield { offset: offset + page.length, matchedPrefix: prefix, match: null };
}
