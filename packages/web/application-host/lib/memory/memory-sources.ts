import { createHash } from "node:crypto";
import type { MemorySourceSpan } from "@varin/protocol";

/** Shared by explicit remembering, background coverage, and original-source reads. */
export const sourceRevision = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Reading witnesses deliberately do not participate in source ownership or coverage. */
export const sourceIdentity = (span: MemorySourceSpan): readonly string[] => {
  switch (span.kind) {
    case 'history-item': return [span.kind, span.threadId, span.id];
  }
};
export const sameSource = (a: MemorySourceSpan, b: MemorySourceSpan): boolean =>
  JSON.stringify(sourceIdentity(a)) === JSON.stringify(sourceIdentity(b));

export const overlappingSource = (a: MemorySourceSpan, b: MemorySourceSpan): boolean =>
  sameSource(a, b) && a.revision === b.revision && a.start < b.end && b.start < a.end;

export const mergeSourceSpans = (spans: readonly MemorySourceSpan[]): MemorySourceSpan[] => {
  const result: MemorySourceSpan[] = [];
  for (const span of spans) {
    let merged = { ...span };
    for (let i = result.length - 1; i >= 0; i--) {
      const old = result[i]!;
      if (sameSource(old, merged) && old.revision === merged.revision
        && old.start <= merged.end && merged.start <= old.end) {
        merged = { ...merged, start: Math.min(old.start, merged.start), end: Math.max(old.end, merged.end) };
        result.splice(i, 1);
      }
    }
    result.push(merged);
  }
  return result;
};

export const uncoveredSourceSpans = (span: MemorySourceSpan, covered: readonly MemorySourceSpan[]): MemorySourceSpan[] => {
  let remaining = [span];
  for (const previous of covered) {
    remaining = remaining.flatMap((part) => !overlappingSource(part, previous) ? [part] : [
      ...(previous.start > part.start ? [{ ...part, end: previous.start }] : []),
      ...(previous.end < part.end ? [{ ...part, start: previous.end }] : []),
    ]);
  }
  return remaining;
};

export const parseSourceSpans = (value: unknown): MemorySourceSpan[] => {
  if (!Array.isArray(value)) throw new Error("Invalid memory source ranges");
  const text = (value: unknown) => typeof value === 'string' && value.length > 0;
  return value.map((raw): MemorySourceSpan => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid memory source range');
    const span = raw as Record<string, unknown>;
    const common = text(span.id) && text(span.revision) && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
      && Number(span.start) >= 0 && Number(span.end) > Number(span.start);
    const required = span.kind === 'history-item' ? ['threadId', 'branchId', 'headId'] : null;
    if (!common || !required || required.some(key => !text(span[key]))
      || Object.keys(span).some(key => !['kind', 'id', 'revision', 'start', 'end', ...required].includes(key))) {
      throw new Error('Invalid memory source identity or range');
    }
    return span as unknown as MemorySourceSpan;
  });
};
