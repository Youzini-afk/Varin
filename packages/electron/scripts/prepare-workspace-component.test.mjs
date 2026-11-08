import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadWorkspaceAsset } from './prepare-workspace-component.mjs';

test('WinFsp retries a temporary download failure and returns the original asset bytes', async () => {
  const bytes = Buffer.from([0, 17, 255, 4]);
  const waits = [];
  let requests = 0;
  const result = await downloadWorkspaceAsset('https://example.test/component.msi', {
    request: async () => ++requests === 1 ? new Response(null, { status: 504 }) : new Response(bytes),
    wait: async ms => waits.push(ms),
  });
  assert.deepEqual(result, bytes);
  assert.deepEqual(waits, [1000]);
  requests = 0;
  await assert.rejects(downloadWorkspaceAsset('https://example.test/missing', {
    request: async () => { requests++; return new Response(null, { status: 404 }); },
    wait: async () => assert.fail('Permanent errors must not be retried'),
  }), /404/);
  assert.equal(requests, 1);
});
