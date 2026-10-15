import type { ThreadIdentity, ThreadMaterialAttachment } from '@varin/application-client';
import type { WebSnapshotRef } from '@varin/protocol';

export type ThreadInputMaterials = (identity: ThreadIdentity, materials: readonly ThreadMaterialAttachment[], signal?: AbortSignal) => Promise<WebSnapshotRef[]>;

/** This public input carries selectors only. File bytes and provenance come from the material owner. */
export function parseThreadMaterials(value: unknown): ThreadMaterialAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Materials must be an array');
  return value.map(material => {
    if (!material || typeof material !== 'object' || Array.isArray(material)
      || Object.keys(material).some(key => key !== 'snapshotId')
      || typeof material.snapshotId !== 'string' || !material.snapshotId.trim()) throw new Error('Malformed material attachment');
    return { snapshotId: material.snapshotId };
  });
}

/** Native user input remains text/media. Only verified fixed references are added to its text;
 * document_read resolves the original PDF later, without pretending PDF bytes are an image. */
export function materialInputText(text: string, materials: readonly WebSnapshotRef[]): string {
  if (!materials.length) return text;
  const references = materials.map(ref => ({ snapshotId: ref.snapshotId,
    sourceSnapshotId: ref.document?.sourceSnapshotId ?? ref.snapshotId,
    ...(ref.title ? { filename: ref.title } : {}), sourceUrl: ref.sourceUrl,
    sourceHash: ref.document!.source!.contentHash, byteLength: ref.document!.source!.byteLength,
    mimeType: ref.document!.source!.contentType }));
  return `${text}${text.length ? '\n\n' : ''}Attached PDF materials (retained original bytes; use document_read with snapshotId):\n${JSON.stringify(references)}`;
}
