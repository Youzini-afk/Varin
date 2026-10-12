/** Verify the actual child identity at the private language boundary, using the shared real owners. */
import assert from 'node:assert/strict';
import { handleLanguageFrame, startLanguageFixture } from './language-source-host.test-helper.js';
import type { LanguageQuery, LaunchSource } from './protocol.generated.js';

let child: { runId: string; threadId: string; source: LaunchSource } | undefined;
const queries: LanguageQuery[] = [];
startLanguageFixture(async frame => {
  if (frame.kind === 'fixture-select') {
    if (String(frame.threadId) !== 'thread:language') {
      assert.notEqual(frame.threadId, 'thread:language');
      child = { runId: String(frame.runId), threadId: String(frame.threadId), source: frame.source as LaunchSource };
      assert(child.source.branch_id?.startsWith('child-source:'));
      assert.equal(child.source.revision, 0);
    } else child = undefined;
  }
  if (frame.kind === 'language-request') {
    const query = frame.query as LanguageQuery;
    assert(child, 'The language consumer must be an actual delegated child');
    assert.equal(query.runId, child.runId);
    assert.equal(query.threadId, child.threadId);
    assert.equal(query.grantId, `language-source:${child.runId}`);
    assert.deepEqual(query.source, child.source);
    if (query.source.mode === 'fixed_branch') assert.equal(query.physicalRoot, null);
    else assert(query.physicalRoot);
    queries.push(query);
  }
  if (frame.kind === 'fixture-child-audit') {
    assert.equal(queries.length, 5);
    assert.equal(new Set(queries.map(query => query.runId)).size, 1);
    process.stdout.write(`${JSON.stringify({ kind: 'fixture-child-audited', queries })}\n`);
    return;
  }
  await handleLanguageFrame(frame);
});
