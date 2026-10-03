import { describe, expect, test } from 'vitest';

import { createWorkspaceHttpAPI } from './workspaceApiHttp';

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;

const setGlobal = (key: keyof typeof globalThis, value: unknown) => {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
};

const restoreGlobal = (key: keyof typeof globalThis, value: unknown) => {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  setGlobal(key, value);
};

type FetchCall = {
  input: string | URL | Request;
  init?: RequestInit;
};

type DownloadEnvironment = {
  fetchCalls: FetchCall[];
  appended: unknown[];
  removed: unknown[];
  link: HTMLAnchorElement;
  clickCount: number;
};

const restoreEnvironment = () => {
  restoreGlobal('fetch', originalFetch);
  restoreGlobal('document', originalDocument);
};

const withDownloadEnvironment = async (
  responseFactory: () => Response | Promise<Response>,
  run: (environment: DownloadEnvironment) => Promise<void>,
) => {
  const environment: DownloadEnvironment = {
    fetchCalls: [],
    appended: [],
    removed: [],
    link: {
      href: '',
      download: '',
      click: () => {
        environment.clickCount += 1;
      },
    } as unknown as HTMLAnchorElement,
    clickCount: 0,
  };

  setGlobal('fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    environment.fetchCalls.push({ input, init });
    return responseFactory();
  }) as typeof fetch);
  setGlobal('document', {
    createElement: (tagName: string) => {
      expect(tagName).toBe('a');
      return environment.link;
    },
    body: {
      appendChild: (node: Node) => {
        environment.appended.push(node);
        return node;
      },
      removeChild: (node: Node) => {
        environment.removed.push(node);
        return node;
      },
    },
  } as unknown as Document);
  try {
    await run(environment);
  } finally {
    restoreEnvironment();
  }
};

describe('workspaceApiHttp download', () => {
  test('checks downloads before starting a native browser download', async () => {
    await withDownloadEnvironment(
      () => new Response(JSON.stringify({ type: 'archive', fileName: 'OpenLocus.zip' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      async (environment) => {
        await createWorkspaceHttpAPI().download('projects/OpenLocus');

        expect(environment.fetchCalls.length).toBe(1);
        expect(environment.fetchCalls[0]?.input).toBe('/api/workspace/download/check?path=projects%2FOpenLocus');
        expect(environment.link.href).toBe('/api/workspace/download?path=projects%2FOpenLocus');
        expect(environment.link.download).toBe('OpenLocus.zip');
        expect(environment.appended).toEqual([environment.link]);
        expect(environment.clickCount).toBe(1);
        expect(environment.removed).toEqual([environment.link]);
      },
    );
  });

  test('throws JSON errors instead of saving them as downloaded files', async () => {
    await withDownloadEnvironment(
      () => new Response(JSON.stringify({ error: 'Directory is too large to download' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json' },
      }),
      async (environment) => {
        let thrown: unknown = null;
        try {
          await createWorkspaceHttpAPI().download('OpenLocus');
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe('Directory is too large to download');
        expect(environment.appended).toEqual([]);
        expect(environment.clickCount).toBe(0);
      },
    );
  });
});
