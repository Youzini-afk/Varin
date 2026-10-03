import { describe, expect, test } from 'vitest';
import {
  parseKnowledgeCatalogChain,
  parseKnowledgeCatalogItem,
  parseKnowledgeCatalogList,
} from './knowledgeCatalogRequest';

describe('knowledge catalog request parsing', () => {
  test('accepts a catalog item with source, recall, and retirement', () => {
    expect(parseKnowledgeCatalogItem({
      id: 3,
      scope: 'workspace',
      status: 'accepted',
      content: 'Use bun',
      trigger: 'packages',
      createdAt: 10,
      invalidAt: 20,
      recallCount: 2,
      recalledAt: 15,
      source: { sessionId: 's1', kind: 'user-message' },
    })).toEqual({
      id: 3,
      scope: 'workspace',
      status: 'accepted',
      content: 'Use bun',
      trigger: 'packages',
      createdAt: 10,
      invalidAt: 20,
      recallCount: 2,
      recalledAt: 15,
      source: { sessionId: 's1', kind: 'user-message' },
    });
  });

  test('rejects malformed list and chain payloads', () => {
    expect(() => parseKnowledgeCatalogList({ items: [{ id: 1 }] })).toThrow(/Malformed knowledge catalog item/);
    expect(parseKnowledgeCatalogList({ items: [] })).toEqual([]);
    expect(parseKnowledgeCatalogChain({
      current: {
        id: 2, scope: 'user', status: 'accepted', content: 'new', trigger: '', createdAt: 2, recallCount: 0,
      },
      predecessors: [{
        id: 1, scope: 'user', status: 'accepted', content: 'old', trigger: '', createdAt: 1, recallCount: 0, invalidAt: 2,
      }],
      successors: [],
      chain: [
        { id: 1, scope: 'user', status: 'accepted', content: 'old', trigger: '', createdAt: 1, recallCount: 0, invalidAt: 2 },
        { id: 2, scope: 'user', status: 'accepted', content: 'new', trigger: '', createdAt: 2, recallCount: 0 },
      ],
    }).chain.map((item) => item.id)).toEqual([1, 2]);
  });
});
