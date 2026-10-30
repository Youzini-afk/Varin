import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Import through the same virtual module path as Electron main. The store owner
// itself forks its physical worker, exercising that worker's real dependency closure.
const root = path.resolve(process.argv[2]);
const { openWorkspaceKnowledge } = await import(pathToFileURL(path.join(root, 'server/lib/knowledge/store.js')).href);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-packaged-knowledge-'));
let store;
try {
  store = await openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'ws', embedding: null });
  const id = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Native release verification', trigger: 'release verification' });
  assert.equal((await store.recall('release verification', 5))[0]?.node.id, id);
} finally { await store?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
console.log('[electron] verified the private packaged knowledge process');
