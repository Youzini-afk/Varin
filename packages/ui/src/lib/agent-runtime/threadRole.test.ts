import { expect, it } from 'vitest';
import { isLeadThread, type CatalogThreadRole } from './threadRole';

it('uses the same lead identity for ordinary tasks and direct work from any Bot session', () => {
  const rows: CatalogThreadRole[] = [
    { thread_id: 'root', parent_thread_id: null, bot_id: null },
    { thread_id: 'worker', parent_thread_id: 'root', bot_id: null },
    { thread_id: 'session-2', parent_thread_id: null, bot_id: 'bot' },
    { thread_id: 'lead', parent_thread_id: 'session-2', bot_id: 'bot' },
    { thread_id: 'nested', parent_thread_id: 'lead', bot_id: 'bot' },
    { thread_id: 'unknown', parent_thread_id: 'missing', bot_id: 'bot' },
  ];
  const directory = new Map(rows.map(thread => [thread.thread_id, thread]));
  expect(rows.filter(thread => isLeadThread(thread, directory)).map(thread => thread.thread_id)).toEqual(['root', 'lead']);
});
