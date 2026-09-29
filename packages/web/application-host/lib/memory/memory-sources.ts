import { createHash } from "node:crypto";
import type { MemorySourceSpan, PiSessionEntry } from "@varin/protocol";

/** Shared by explicit remembering, background coverage, and original-source reads. */
export const sourceRevision = (text: string): string => createHash("sha256").update(text).digest("hex");

export const entrySourceText = (entry: PiSessionEntry): string => {
  if (entry.type !== "message" || !("content" in entry.message)) return "";
  const { content } = entry.message;
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
};

export const sameSource = (a: MemorySourceSpan, b: MemorySourceSpan): boolean =>
  a.kind === b.kind && a.id === b.id && a.sessionId === b.sessionId
  && a.scopeId === b.scopeId && a.threadId === b.threadId;

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
  const spans = value.filter((span): span is MemorySourceSpan => !!span && typeof span === "object"
    && ["pi-entry", "event", "run-report"].includes(span.kind)
    && typeof span.id === "string" && typeof span.revision === "string"
    && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start
    && (span.kind !== "pi-entry" || typeof span.sessionId === "string")
    && (span.kind !== "event" || typeof span.scopeId === "string")
    && (span.kind !== "run-report" || typeof span.threadId === "string"));
  if (spans.length !== value.length) throw new Error("Invalid memory source range");
  return spans;
};
