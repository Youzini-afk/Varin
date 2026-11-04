import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWebSourceCitation, parseWebSourceCitation, materialAttachmentRef } from '../src/web-sources.js';

test('source citations preserve immutable identity and exact one-based ranges', () => {
  const citation = { snapshotId: 'snap-known', contentHash: `sha256-${'a'.repeat(64)}`, startLine: 3, endLine: 12 };
  assert.deepEqual(parseWebSourceCitation(formatWebSourceCitation(citation)), citation);
  assert.equal(materialAttachmentRef(citation.snapshotId), 'attachment:material_736e61702d6b6e6f776e');
  for (const href of ['https://example.com/snap-known', 'varin-material://snap-known#other', 'varin-material://snap-known/other',
    'varin-material://snap-known?startLine=0', 'varin-material://snap-known?startLine=3&endLine=2', 'varin-material://snap-known?endLine=2',
    'varin-material://snap-known?startLine=1&startLine=2', 'varin-material://snap-known?contentHash=wrong', 'varin-material://snap-known?page=2']) {
    assert.equal(parseWebSourceCitation(href), null, href);
  }
});
