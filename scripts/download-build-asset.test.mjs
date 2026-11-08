import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBuildAsset } from './download-build-asset.mjs';

test('a failed release redirect uses the exact official asset without forwarding API credentials', async () => {
  const url = 'https://github.com/team/tool/releases/download/v1.0/file.zip';
  const calls = [];
  const responses = [new Response(null, { status: 504 }),
    Response.json({ assets: [{ id: 123, name: 'file.zip' }, { id: 124, name: 'other.zip' }] }),
    new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } }),
    new Response('original bytes')];
  const request = async (target, options) => { calls.push({ target, options }); return responses.shift(); };
  const result = await fetchBuildAsset(url, { request, token: 'test-token', releaseCache: new Map() });
  assert.equal(await result.text(), 'original bytes');
  assert.equal(calls[1].target, 'https://api.github.com/repos/team/tool/releases/tags/v1.0');
  assert.equal(calls[2].target, 'https://api.github.com/repos/team/tool/releases/assets/123');
  assert.equal(calls[2].options.headers.Accept, 'application/octet-stream');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[3].options, undefined);
});

test('successful downloads, non-GitHub failures and missing releases keep their original result', async () => {
  for (const [url, status] of [['https://github.com/team/tool/releases/download/v1/file', 200],
    ['https://github.com/team/tool/releases/download/v1/file', 404], ['https://example.test/file', 504]]) {
    let calls = 0;
    const result = await fetchBuildAsset(url, { request: async () => { calls++; return new Response(null, { status }); } });
    assert.equal(result.status, status);
    assert.equal(calls, 1);
  }
});
