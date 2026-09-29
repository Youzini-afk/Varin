import { createHash } from "node:crypto";
import { formatZone2Knowledge, formatZone2KnowledgeCorrection, type Zone2Material } from "./zone2.js";

export const zone2MaterialRevision = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Compare with material present in retained Pi messages, never a second memory store. */
export function selectNewZone2Material(material: Zone2Material, known: Record<string, string> = {}) {
  const receipts: Array<{ key: string; revision: string; text: string }> = [];
  const blocks = material.blocks.filter((block) => {
    const key = `block:${block.label}`;
    const hash = zone2MaterialRevision(block);
    if (known[key] === hash) return false;
    receipts.push({ key, revision: hash, text: `[${block.label}] ${block.content}` });
    return true;
  });
  // An explicitly removed plan/note must supersede its old raw input too.
  const present = new Set(material.blocks.map((block) => `block:${block.label}`));
  const removedRevision = zone2MaterialRevision({ removed: true });
  for (const key of material.blocksComplete ? Object.keys(known) : []) {
    if (!key.startsWith("block:") || present.has(key) || known[key] === removedRevision) continue;
    const block = { label: key.slice(6), content: "(removed; the previous version is no longer current)" };
    blocks.push(block);
    receipts.push({ key, revision: removedRevision, text: `[${block.label}] ${block.content}` });
  }
  const knowledge = material.knowledge.filter((item) => {
    const key = `knowledge:${item.scope ?? "workspace"}:${item.id}`;
    const hash = zone2MaterialRevision(item);
    if (known[key] === hash) return false;
    receipts.push({ key, revision: hash, text: formatZone2Knowledge(item) });
    return true;
  });
  const invalidationRevision = zone2MaterialRevision({ invalid: true });
  for (const invalidation of material.knowledgeInvalidations ?? []) {
    const key = `knowledge:${invalidation.scope}:${invalidation.id}`;
    const text = `#${invalidation.id} (scope:${invalidation.scope}) is no longer available`;
    if (known[key] === invalidationRevision) continue;
    receipts.push({ key, revision: invalidationRevision, text });
  }
  // A correction is the successor row entering the request: it claims that
  // row's ordinary receipt key so later recall does not deliver it twice.
  const knowledgeCorrections = (material.knowledgeCorrections ?? []).filter((item) => {
    const key = `knowledge:${item.scope}:${item.id}`;
    const hash = zone2MaterialRevision({ correction: item });
    if (known[key] === hash) return false;
    receipts.push({ key, revision: hash, text: formatZone2KnowledgeCorrection(item) });
    return true;
  });
  return {
    material: { ...material, blocks, knowledge, contextUsage: null, knowledgeInvalidations: material.knowledgeInvalidations ?? [], knowledgeCorrections },
    // Budget-folded material is not acknowledged as if it had been shown whole.
    // The next request can still select it; history owns already delivered bytes.
    receiptsFor(content: string | null): Record<string, string> {
      return Object.fromEntries(receipts.filter((receipt) => content?.includes(receipt.text))
        .map(({ key, revision: hash }) => [key, hash]));
    },
  };
}
