import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the same logical ASAR entry and real IPC handshake as the embedded Host. No extension,
// provider request, user profile or Agent Run is activated by this check.
const root = path.resolve(process.argv[2]);
const { ChildBrokeredHostTransport } = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
const broker = new ChildBrokeredHostTransport({
  brokerScript: path.join(root, 'broker/broker-child.mjs'),
  onCrash() {},
  async requestFromChild() { throw new Error('Unexpected broker capability request'); },
});
try {
  await broker.request('deactivate');
  assert.deepEqual(await broker.terminate(), { processExited: true, cleanup: 'confirmed' });
  console.log('[electron] verified the packaged extension broker IPC entry');
} catch (error) {
  broker.forceTerminate();
  throw error;
}
