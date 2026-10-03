import { describe, expect, test } from 'vitest';
import type { PiSessionEntry } from '@varin/protocol';
import { projectHarnessWebSources } from './harnessWebSources';

describe('Harness web source projection', () => {
  test('projects only validated persisted web tool sources', () => {
    const entries = [{
      id: 'result-1', parentId: null, timestamp: '2026-09-05T00:00:00.000Z', type: 'message',
      message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'websearch', content: [], isError: false, timestamp: 10,
        details: { sources: [
          { title: 'Docs', url: 'https://docs.example/page' },
          { title: 'Unsafe', url: 'javascript:alert(1)' },
          { title: 'Missing URL' },
        ] },
      },
    }, {
      id: 'result-2', parentId: null, timestamp: '2026-09-05T00:00:01.000Z', type: 'message',
      message: {
        role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [], isError: false, timestamp: 11,
        details: { sources: [{ url: 'https://ignored.example' }] },
      },
    }] as PiSessionEntry[];
    expect(projectHarnessWebSources('session-1', entries)).toEqual([{
      sessionId: 'session-1',
      url: 'https://docs.example/page',
      title: 'Docs',
      fetchedAt: 10,
      toolCallId: 'call-1',
      tool: 'websearch',
    }]);
  });

  test('projects document_read PDFs with the original file hash', () => {
    const entries = [{
      id: 'result-1', parentId: null, timestamp: '2026-09-05T00:00:00.000Z', type: 'message',
      message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'document_read', content: [], isError: false, timestamp: 10,
        details: { sources: [{
          title: 'Paper', url: 'https://example.test/paper.pdf', snapshotId: 'current-snapshot', contentHash: 'text-sha',
          document: { kind: 'pdf', pageCount: 12, source: { contentHash: 'sha256-original' } },
        }] },
      },
    }] as PiSessionEntry[];

    expect(projectHarnessWebSources('session-1', entries)).toEqual([{
      sessionId: 'session-1',
      url: 'https://example.test/paper.pdf',
      title: 'Paper',
      fetchedAt: 10,
      toolCallId: 'call-1',
      tool: 'document_read',
      snapshotId: 'current-snapshot',
      contentHash: 'text-sha',
      sourceHash: 'sha256-original',
      document: { kind: 'pdf', pageCount: 12 },
    }]);
  });
});
