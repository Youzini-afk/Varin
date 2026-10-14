import { describe, expect, test } from 'vitest';
import { threadSummary } from '@/test/threadFixtures';
import { buildThreadRecentShortcuts } from './usePwaManifestSync';
describe('native recent shortcuts', () => {
  test('keeps exact Thread and main branch, placing the current Thread first', () => {
    expect(buildThreadRecentShortcuts([threadSummary('older'), threadSummary('current', { title: ' Current   conversation ' })], 'current')).toEqual([
      { threadId: 'current', branchId: 'current:main', title: 'Current conversation' },
      { threadId: 'older', branchId: 'older:main', title: 'older' },
    ]);
  });
  test('excludes archived, deleted and Bot threads and deduplicates native ids', () => {
    expect(buildThreadRecentShortcuts([threadSummary('archived', { archived: true }), threadSummary('deleted', { deleted_at_ms: 2 }), threadSummary('bot', { bot_id: 'bot' }), threadSummary('active'), threadSummary('active')], null)).toEqual([{ threadId: 'active', branchId: 'active:main', title: 'active' }]);
  });
});
