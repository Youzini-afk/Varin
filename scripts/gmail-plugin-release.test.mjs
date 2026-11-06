import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { validateGmailRelease } from './gmail-plugin-release.mjs';
const source = { manifest: { id: 'varin.gmail', version: '0.1.0' }, metadata: { name: '@varin/plugin-gmail', version: '0.1.0' } };
test('Gmail publishing requires the exact plugin version tag; manual builds never publish', () => {
  assert.deepEqual(validateGmailRelease({ ...source, eventName: 'push', refType: 'tag', refName: 'gmail-v0.1.0' }), { publish: true });
  assert.deepEqual(validateGmailRelease({ ...source, eventName: 'workflow_dispatch', refType: 'tag', refName: 'gmail-v0.1.0' }), { publish: false });
  for (const change of [{ refName: 'gmail-v0.2.0' }, { refType: 'branch' }, { eventName: 'pull_request' }, { metadata: { ...source.metadata, version: '0.2.0' } }]) {
    assert.throws(() => validateGmailRelease({ ...source, eventName: 'push', refType: 'tag', refName: 'gmail-v0.1.0', ...change }));
  }
});
test('only successful tag builds can reach the release writer; dispatch keeps read-only artifact build', () => {
  const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
  const workflow = require('yaml').parse(readFileSync(new URL('../.github/workflows/gmail-plugin-release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.on.push.tags, ['gmail-v*']);
  const writers = Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.contents === 'write');
  assert.equal(writers.length, 1);
  const [, publisher] = writers[0];
  assert.equal(publisher.needs, 'build');
  assert.equal(publisher.if, "github.event_name == 'push' && github.ref_type == 'tag' && startsWith(github.ref_name, 'gmail-v')");
  const uploaded = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const downloaded = publisher.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(downloaded.with.name, uploaded.with.name);
});
