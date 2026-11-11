import { createResourceFilesHttpAPI, type FilesAPI, type ResourceFileLocation, type ResourceFileResult } from '@varin/application-client';
const normalized = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
export function projectRelativePath(location: ResourceFileLocation, path: string): string {
  const root = normalized(location.root), value = normalized(path);
  if (root === value) return '';
  if (!value.startsWith(`${root}/`)) throw new Error('File is outside the selected source workspace');
  return value.slice(root.length + 1);
}
export const projectAbsolutePath = (location: ResourceFileLocation, resourceId: string): string => `${location.root.replace(/\/$/, '')}/${resourceId}`;

/** Adapts the existing tree's operations to its original Files/Documents owner. */
export function projectFileOperations(location: ResourceFileLocation): Pick<FilesAPI, 'listDirectory' | 'createDirectory' | 'rename' | 'delete' | 'downloadFile'> {
  const api = createResourceFilesHttpAPI();
  return {
    async listDirectory(path) {
      const entries: Awaited<ReturnType<FilesAPI['listDirectory']>>['entries'] = [];
      let cursor: string | undefined;
      do {
        const response = await api.request({ ...location, command: { kind: 'list', path: projectRelativePath(location, path), ...(cursor ? { cursor } : {}) } });
        if (response.kind !== 'list') throw new Error('Source directory listing is unavailable');
        entries.push(...response.page.entries.map(entry => ({ name: entry.name, path: projectAbsolutePath(location, entry.path), isDirectory: entry.kind === 'directory' })));
        cursor = response.page.nextCursor ?? undefined;
      } while (cursor);
      return { directory: path, entries };
    },
    async createDirectory(path) { await api.request({ ...location, command: { kind: 'mkdir', path: projectRelativePath(location, path) } }); return { success: true, path }; },
    async rename(path, destination) { await api.request({ ...location, command: { kind: 'rename', path: projectRelativePath(location, path), destination: projectRelativePath(location, destination), key: crypto.randomUUID() } }); return { success: true, path: destination }; },
    async delete(path) { await api.request({ ...location, command: { kind: 'remove', path: projectRelativePath(location, path), key: crypto.randomUUID() } }); return { success: true }; },
    async downloadFile(path, options) {
      const chunks: Uint8Array<ArrayBuffer>[] = []; let first: Extract<ResourceFileResult, { kind: 'bytes' }> | undefined, offset = 0;
      for (;;) {
        const response = await api.request({ ...location, command: { kind: 'bytes', path: projectRelativePath(location, path), offset } }, options?.signal);
        if (response.kind !== 'bytes') throw new Error('Source file content is unavailable');
        first ??= response;
        if (first.version !== response.version || first.byteLength !== response.byteLength) throw new Error('Source file changed while downloading');
        chunks.push(Uint8Array.from(atob(response.bytesBase64), char => char.charCodeAt(0)));
        if (response.eof) break;
        if (response.nextOffset <= offset) throw new Error('Source returned an incomplete file');
        offset = response.nextOffset;
      }
      const url = URL.createObjectURL(new Blob(chunks)); const link = document.createElement('a');
      link.href = url; link.download = path.split('/').pop() ?? 'download'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}

/** Preserve original compute failure/cancellation instead of presenting empty success. */
export function assertFileEnumeration(status: string): void {
  if (status === 'failed') throw new Error('Source filename search failed');
  if (status === 'cancelled') throw new DOMException('Source search cancelled', 'AbortError');
}
