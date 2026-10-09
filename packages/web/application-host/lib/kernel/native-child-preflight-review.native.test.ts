import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const version = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const definitions = {
  partial: 'CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id),child_thread_id TEXT NOT NULL REFERENCES threads(id),body TEXT NOT NULL); CREATE UNIQUE INDEX fake_child_unique ON child_tasks(child_thread_id) WHERE 0;',
  child_nocase: 'CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id),child_thread_id TEXT NOT NULL REFERENCES threads(id),body TEXT NOT NULL); CREATE UNIQUE INDEX fake_child_unique ON child_tasks(child_thread_id COLLATE NOCASE);',
  id_nocase: 'CREATE TABLE child_tasks(id TEXT PRIMARY KEY COLLATE NOCASE REFERENCES operations(id),child_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),body TEXT NOT NULL);',
  foreign_cascade: 'CREATE TABLE child_tasks(id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,child_thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),body TEXT NOT NULL);',
};
for (const [defect, definition] of Object.entries(definitions)) {
  it(`rejects collaboration ${defect} constraint semantics before changing the existing catalog`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-child-preflight-review-'));
    const clients: ReturnType<typeof createKernelClient>[] = [];
    const open = () => {
      const kernel = createKernelClient({ hostId: 'child-preflight-review', storageRoot: root, buildVersion: version,
        kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false });
      clients.push(kernel);
      return { kernel, runtime: new NativeRuntimeClient(kernel) };
    };
    try {
      const initial = open(); await initial.runtime.status(); await initial.kernel.close();
      const catalog = path.join(root, 'agent-runtime', 'conversation.sqlite');
      execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit(); c.execute("PRAGMA wal_checkpoint(TRUNCATE)"); c.close()', catalog,
        `PRAGMA foreign_keys=OFF; DROP TABLE child_tasks; ${definition}`]);
      const before = await fs.readFile(catalog);
      const reopened = open();
      await expect(reopened.runtime.status()).rejects.toThrow();
      await reopened.kernel.close();
      expect(await fs.readFile(catalog)).toEqual(before);
    } finally {
      for (const kernel of clients) await kernel.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
