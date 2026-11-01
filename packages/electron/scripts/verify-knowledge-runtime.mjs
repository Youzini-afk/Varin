import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

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
  await store.close(); store = null;
  const require = createRequire(path.join(root, 'package.json'));
  const legacy = path.join(dataDir, 'knowledge', 'native-smoke', 'legacy.tdb');
  execFileSync(process.execPath, ['-e', `
    const { TriviumDB } = require(process.argv[1]);
    const db = new TriviumDB(process.argv[2], { dim: 8, syncMode: 'full', autoBuildQuiver: false, loadTextIndex: false });
    db.insert(Array(8).fill(0), { type: 'upgrade-smoke', content: 'Original WAL data' });
    process.exit(0);
  `, require.resolve('triviumdb-upgrade-0.8'), legacy], {
    windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  store = await openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'legacy', embedding: null });
  const upgradedId = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Upgraded release verification', trigger: 'release verification' });
  assert.equal(upgradedId, 2);
  assert.equal((await store.recall('release verification', 5))[0]?.node.id, upgradedId);
  await store.close(); store = null;
  const { TriviumDB } = require('triviumdb');
  const reader = new TriviumDB(legacy, { dim: 8, accessMode: 'readOnly' });
  try { assert.equal(reader.getPayload(1).content, 'Original WAL data'); }
  finally { reader.close(); }
} finally { await store?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
console.log('[electron] verified the private packaged knowledge process');
