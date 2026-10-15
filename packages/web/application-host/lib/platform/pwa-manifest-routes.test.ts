import type { ThreadSummary } from '@varin/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  registerPwaManifestRoute,
  type PwaManifestHandler,
  type PwaManifestResponse,
} from './pwa-manifest-routes.js';

interface TestResponse extends PwaManifestResponse {
  body: string;
  contentType: string;
  headers: Map<string, string>;
}

const createResponse = (): TestResponse => ({
  headers: new Map<string, string>(),
  contentType: '',
  body: '',
  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  },
  type(value: string) {
    this.contentType = value;
    return this;
  },
  send(value: string) {
    this.body = value;
    return this;
  },
});

const thread = (id: string, title: string, updated: number): ThreadSummary => ({
  thread_id: id, main_branch_id: `${id}:main`, title, updated_at_ms: updated,
  revision: 1, created_at_ms: 1, pinned: false, archived: false, deleted_at_ms: null,
  activity_cursor: 1, read_cursor: 0, unread: true, bot_id: null, branches: [], observer_project_ids: [],
});

describe('PWA manifest route', () => {
  it('builds recent shortcuts from native Threads without an HTTP lifecycle dependency', async () => {
    const routes = new Map<string, PwaManifestHandler>();
    const listRecentThreads = vi.fn(async () => [
      thread('thread:old', 'Older task', 10),
      thread('thread:new', 'Latest task', 20),
    ]);
    registerPwaManifestRoute({
      get(route: string, handler: PwaManifestHandler) {
        routes.set(route, handler);
      },
    }, {
      listRecentThreads,
      readSettingsFromDisk: async () => ({}),
      normalizePwaAppName: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
      normalizePwaOrientation: (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback,
    });

    const res = createResponse();
    const handler = routes.get('/manifest.webmanifest');
    if (!handler) throw new Error('Expected PWA manifest handler');
    await handler({ query: {} }, res);

    expect(listRecentThreads).toHaveBeenCalledOnce();
    expect(JSON.parse(res.body).shortcuts).toEqual([
      {
        name: 'Appearance Settings',
        short_name: 'Settings',
        description: 'Open appearance settings',
        url: '/?settings=appearance',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Latest task',
        short_name: 'Latest task',
        description: 'Open recent conversation',
        url: '/?thread=thread%3Anew&branch=thread%3Anew%3Amain',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
      {
        name: 'Older task',
        short_name: 'Older task',
        description: 'Open recent conversation',
        url: '/?thread=thread%3Aold&branch=thread%3Aold%3Amain',
        icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
      },
    ]);
  });
});
