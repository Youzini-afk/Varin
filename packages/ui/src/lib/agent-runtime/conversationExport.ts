import type { ThreadExportSelection, ThreadWorkflowsAPI } from '@varin/application-client';

/** OPFS keeps long downloads disk-backed, including mobile browsers. No arrayBuffer/blob aggregate.
 * The file is only exposed as a local object URL after the original stream completes successfully. */
export async function prepareConversationDownload(api: ThreadWorkflowsAPI, selection: ThreadExportSelection, signal?: AbortSignal): Promise<{ url: string; filename: string; dispose(): Promise<void> }> {
  if (!navigator.storage?.getDirectory) throw new Error('This browser cannot stream a local export. Open this conversation in an up-to-date browser.');
  const directory = await navigator.storage.getDirectory();
  const filename = `conversation-${crypto.randomUUID()}.${selection.format === 'json' ? 'json' : 'md'}`;
  const file = await directory.getFileHandle(filename, { create: true });
  try {
    const writable = await file.createWritable();
    await api.export(selection, writable as WritableStream<Uint8Array>, signal);
    signal?.throwIfAborted();
    const url = URL.createObjectURL(await file.getFile());
    let disposed = false;
    return { url, filename: `conversation.${selection.format === 'json' ? 'json' : 'md'}`, async dispose() { if (disposed) return; disposed = true; URL.revokeObjectURL(url); await directory.removeEntry(filename); } };
  } catch (error) { await directory.removeEntry(filename).catch(() => {}); throw error; }
}
