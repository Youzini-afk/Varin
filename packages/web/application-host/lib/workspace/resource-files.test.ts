import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { DocumentAuthority } from '../documents/authority.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { createResourceFilesOwner } from './resource-files.js';

it('opens an independent workspace at its admitted physical view, not its original configuration directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-resource-view-'));
  const original = path.join(root, 'original'), mounted = path.join(root, 'mounted');
  await fs.mkdir(original); await fs.mkdir(mounted);
  await fs.writeFile(path.join(original, 'original.txt'), 'original');
  await fs.writeFile(path.join(mounted, 'isolated.txt'), 'isolated');
  const documents = {
    resolveWorkspace: async () => ({ workspaceId: 'independent', hostId: 'owner' }),
    admitWorkspaceRegistration: async () => ({ hostId: 'owner', canonicalPath: original }),
    inspectWorkspace: async () => ({ workspaceId: 'independent', hostId: 'owner', root: mounted }),
  } as unknown as DocumentAuthority;
  const files = createResourceFilesOwner(documents, {} as KernelFileResourceBackend);
  try {
    const opened = await files.request({ command: { kind: 'open', path: mounted } });
    expect(opened).toMatchObject({ kind: 'opened', root: mounted, workspaceId: 'independent' });
    const listed = await files.request({ root: mounted, workspaceId: 'independent', command: { kind: 'list', path: '' } });
    expect(listed.kind === 'list' && listed.page.entries.map(entry => entry.name)).toEqual(['isolated.txt']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
