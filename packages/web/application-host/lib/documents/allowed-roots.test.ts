import path from 'node:path';
import fs from 'node:fs';
import type { PathLike } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDocumentRootGuard } from './allowed-roots.js';
import { createDocumentAuthorityHarness } from './contract-fixtures.js';

describe('document root guard', () => {
  it('compares Windows roots by canonical path identity', async () => {
    const fsPromises = {
      realpath: vi.fn(async (value: PathLike) => path.win32.normalize(String(value))),
    };
    const guard = createDocumentRootGuard({
      fsPromises,
      pathModule: path.win32,
      platform: 'win32',
      workspace: { root: 'D:\\project\\infOS', lockdown: true },
    });

    await expect(guard('\\\\?\\D:\\project\\INFOS')).resolves.toBe(true);
    await expect(guard('D:\\project\\infOS\\packages\\app')).resolves.toBe(true);
    await expect(guard('D:\\project\\infOS-copy')).resolves.toBe(false);
  });

  it('permits arbitrary resource locations when the Host is not locked down', async () => {
    const guard = createDocumentRootGuard({
      fsPromises: { realpath: vi.fn(async (value: PathLike) => String(value)) },
      pathModule: path.posix,
      platform: 'linux',
      workspace: { root: '/workspace', lockdown: false },
    });

    await expect(guard('/home/user/Downloads/design.pdf')).resolves.toBe(true);
    await expect(guard('/another-project/source.ts')).resolves.toBe(true);
  });

  it('does not hide a failed deployment-root lookup as an access decision', async () => {
    const guard = createDocumentRootGuard({
      fsPromises: { realpath: vi.fn(async () => { throw new Error('volume unavailable'); }) },
      pathModule: path.posix,
      workspace: { root: '/workspace', lockdown: true },
    });
    await expect(guard('/workspace/file.txt')).rejects.toThrow('volume unavailable');
  });

  it('reads and writes an external resource without registering it as a project', async () => {
    const guard = createDocumentRootGuard({ fsPromises: fs.promises, pathModule: path, workspace: { root: '/unused', lockdown: false } });
    const h = await createDocumentAuthorityHarness({ authority: { isAllowedRoot: guard, isTrusted: guard } });
    try {
      const externalPath = path.join(h.root, 'external.txt');
      const mapping = await h.authority.ensureResourceRoot(externalPath, 'file');
      const resource = { workspaceId: mapping.workspaceId, resourceId: '' };
      const state = await h.authority.resolveWorkspace({ workspaceId: resource.workspaceId });
      const result = await h.authority.write({
        resource, content: 'external content', encoding: 'utf-8', bom: false, expectedRevision: null,
        token: { workspaceId: resource.workspaceId, epoch: state.epoch, owner: { kind: 'test', id: 'external-write' } },
      });
      expect(result.status).toBe('written');
      expect(await fs.promises.readFile(path.join(h.root, 'external.txt'), 'utf8')).toBe('external content');
      expect(await h.authority.read(resource)).toMatchObject({ status: 'ready', content: 'external content' });
    } finally { await h.cleanup(); }
  });
});
