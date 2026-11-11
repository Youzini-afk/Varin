import type { MemorySourceExcerpt } from '@varin/protocol';
import type { Knowledge } from '../knowledge/store-contract.js';

/** Shared by initial selection and reads. The recipe keeps original rows for CAS;
 * the model sees accounts, applicability, chronology and navigable relationships. */
export const memoryMaintenanceMaterial = (row: Knowledge) => ({
  id: row.id, content: row.content, trigger: row.trigger, status: row.status,
  ...(row.nature === undefined ? {} : { nature: row.nature }),
  createdAt: row.createdAt,
  ...(row.invalidAt === undefined ? {} : { invalidAt: row.invalidAt }),
  ...(row.forgottenAt === undefined ? {} : { forgottenAt: row.forgottenAt }),
  ...(row.historyCleared ? { historyCleared: true } : {}),
  ...(row.overview === undefined ? {} : { overview: row.overview }),
  ...(row.supplements === undefined ? {} : { supplements: row.supplements }),
  ...(row.maintenanceReason === undefined ? {} : { maintenanceReason: row.maintenanceReason }),
  ...(row.source ? { source: {
    kind: row.source.kind,
    ...(row.source.spans?.length ? { originalPassages: row.source.spans.length } : {}),
    ...(row.source.memories?.length ? { memories: row.source.memories.map(ref => ref.id) } : {}),
    ...(row.source.predecessors?.length ? { predecessors: row.source.predecessors.map(ref => ref.id) } : {}),
  } } : {}),
});

export const memoryMaintenanceSource = (source: MemorySourceExcerpt, index: number) => ({
  passage: index + 1, status: source.status,
  ...(source.text === undefined ? {} : { text: source.text }),
});

export function memoryReadPrompt(base: object, body: string, offset: number, length: number): string {
  // Complete structured results stay structured. Partial windows contain literal
  // source text, not a JSON string holding a second escaped serialization.
  const end = offset + length;
  const continuation = { offset, nextOffset: end < body.length ? end : null, total: body.length };
  if (offset === 0 && end === body.length) return JSON.stringify({ ...base, ...continuation, readResult: JSON.parse(body) });
  return `${JSON.stringify({ ...base, ...continuation })}\nRead result fragment (UTF-16 offsets ${offset}..${end}):\n${body.slice(offset, end)}`;
}

export const textBoundary = (text: string, offset: number): boolean => offset <= 0 || offset >= text.length
  || !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
