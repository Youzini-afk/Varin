import type { ContentReference, FilesAPI, ThreadIdentity, ThreadsAPI } from '@varin/application-client';
import { getRuntimeKey } from '@varin/application-client';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import type { ChatFileTarget } from './chatFileTargets';

/** Freeze bytes through the original file owner, then retain with existing attachments. */
export async function captureFileQuote(target: ChatFileTarget, identity: ThreadIdentity, files: FilesAPI, attachments: ThreadsAPI['attachments']): Promise<ContentReference> {
  const assertCurrent = () => { if (target.runtimeKey !== getRuntimeKey()) throw new DOMException('Host changed', 'AbortError'); };
  assertCurrent();
  if (!files.readFileBinary || !files.statFile) throw new Error('File capture is unavailable on this Host.');
  const selected = target.resolve ? await target.resolve() : { path: target.path, directory: getDirectoryForFilePath(target.directory, target.path) };
  assertCurrent();
  const options = { directory: selected.directory };
  const before = await files.statFile(selected.path, options);
  if (!before.isFile) throw new Error('The selected source is not a file.');
  const bytes = await files.readFileBinary(selected.path, options);
  const after = await files.statFile(selected.path, options);
  assertCurrent();
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.path !== after.path || !after.isFile)
    throw new Error('The file changed while preparing the quote. Select it again.');
  const response = await fetch(bytes.dataUrl);
  const data = await response.blob();
  if (data.size !== before.size) throw new Error('The file changed while preparing the quote. Select it again.');
  const filename = selected.path.split(/[\\/]/u).at(-1) || selected.path;
  const capturedAt = new Date().toISOString();
  const ref = `file-selection:${crypto.randomUUID()}`;
  assertCurrent();
  const uploaded = await attachments.upload(identity, { key: ref, filename, mimeType: data.type || 'application/octet-stream', data });
  assertCurrent();
  return { ref, title: filename, attachment: { ref: uploaded.ref }, source: { kind: 'file', thread: { ...identity }, path: selected.path, capturedAt } };
}
