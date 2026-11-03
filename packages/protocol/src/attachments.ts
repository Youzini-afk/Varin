import type { AttachmentSelection } from './agent-runtime.generated.js';

/** Selectors carry no authority; the original Host owner resolves each one. */
export function parseAttachmentSelections(value: unknown): AttachmentSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Attachments must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid attachment ${index + 1}`);
    const entries = Object.entries(item);
    if (entries.length !== 1 || !['ref', 'path'].includes(entries[0]![0]) || typeof entries[0]![1] !== 'string' || !entries[0]![1].trim())
      throw new Error(`Attachment ${index + 1} must select exactly one ref or path`);
    return entries[0]![0] === 'ref' ? { ref: entries[0]![1] } : { path: entries[0]![1] };
  });
}

/** MIME is presentation metadata, never an upload allowlist or executable instruction. */
export function attachmentMimeType(filename: string, supplied = ''): string {
  if (/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(supplied)) return supplied.toLowerCase();
  const extension = filename.split('.').at(-1)?.toLowerCase() ?? '';
  return ({ pdf: 'application/pdf', csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as Record<string, string>)[extension] ?? 'application/octet-stream';
}
