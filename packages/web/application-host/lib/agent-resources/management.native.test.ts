import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { AgentSettingsService } from '../models/settings.js';
import { createAuthorityTestRuntime } from '../kernel/authority.test-helper.js';
import { createResourceManagement } from './management.js';

it('creates and edits native skills through the actual Rust file owner and CAS', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resource-editor-native-')));
  const data = path.join(root, 'data'); await fs.mkdir(data);
  const documents = createDocumentAuthority({ hostId: '11111111-1111-4111-8111-111111111111', dataDir: data });
  const native = await createAuthorityTestRuntime({ documents, hostId: documents.hostId, dataDir: data });
  try {
    const owner = createResourceManagement({ dataDirectory: data, documents, settings: new AgentSettingsService(data, () => false), resolveProjectRoot: () => null, userAgentsDirectory: path.join(root, 'agents') });
    const content = '---\nname: native\ndescription: Actual native resource\n---\nBody.\n';
    const created = await owner.create({}, { scope: 'user', name: 'native', content, key: 'native-create' });
    expect(await fs.readFile(created.descriptor.filePath, 'utf8')).toBe(content);
    const read = await owner.read({}, created.descriptor.id);
    expect(read.revision).toBe(created.revision);
    const updated = await owner.update({}, { id: created.descriptor.id, expectedRevision: created.revision, content: content + 'Updated.\n', key: 'native-save' });
    await expect(owner.update({}, { id: created.descriptor.id, expectedRevision: created.revision, content: 'stale', key: 'native-stale' })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(created.descriptor.filePath, 'utf8')).toBe(content + 'Updated.\n');
    expect(await owner.remove({}, { id: created.descriptor.id, expectedRevision: updated.revision, key: 'native-delete' })).toEqual({ removed: true });
    await expect(fs.stat(created.descriptor.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await native.dispose(); await documents.dispose(); await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
