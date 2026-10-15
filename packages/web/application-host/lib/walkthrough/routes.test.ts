import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerWalkthroughRoutes } from './routes.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ModelTextService } from '../model-text/service.js';

// These run over real HTTP on purpose. The bug this file exists for was
// invisible to unit tests: the service and the store were both correct, and the
// response was dropped by a disconnect check that misread a healthy request.

const SOURCE = { kind: 'working-tree', scope: 'all' };

describe('walkthrough routes', () => {
  let server: Server;
  let base: string;
  let releaseJob: (() => void) | undefined;
  let job: Promise<unknown> | null;
  let generationRequestWaiters: Array<() => void>;

  let lastArgs: Record<string, unknown> | undefined;

  const unusedModelText = async (): Promise<never> => { throw new Error('Route fixture must not invoke model inference'); };
  const modelText = { describe: unusedModelText, inspect: unusedModelText, cancel: unusedModelText,
    generate: unusedModelText, close: async () => {} } satisfies ModelTextService;
  const service = {
    modelText,
    async getWalkthrough(args: Record<string, unknown>) {
      lastArgs = args;
      return { walkthrough: null, hunks: [], hunkCount: 0, generating: Boolean(job) };
    },
    async generateWalkthrough(args: Record<string, unknown>) {
      lastArgs = args;
      if (!job) {
        job = new Promise<unknown>((resolve) => {
          releaseJob = () => resolve({ walkthrough: { title: 'DONE' }, hunks: [], hunkCount: 1 });
        }).finally(() => { job = null; });
      }
      generationRequestWaiters.shift()?.();
      return job;
    },
    async cancelWalkthroughGeneration() {
      return { cancelled: Boolean(job) };
    },
    getGenerationStage() {
      return job ? 'asking' : null;
    },
    async getRepositoryRootFor() {
      return { repoRoot: '/repo', sourceKey: 'working-tree:all' };
    },
    async getPullRequestDiff() {
      throw new Error('not used');
    },
  };

  const generate = (signal?: AbortSignal) => fetch(`${base}/api/walkthrough/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    ...(signal ? { signal } : {}),
  });
  const waitForGenerationRequest = (): Promise<void> => new Promise((resolve) => {
    generationRequestWaiters.push(resolve);
  });

  beforeEach(async () => {
    job = null;
    releaseJob = undefined;
    generationRequestWaiters = [];
    lastArgs = undefined;
    const app = express();
    app.use(express.json());
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => service });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    releaseJob?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('answers a generation request that nobody interrupted', async () => {
    const requested = waitForGenerationRequest();
    const pending = generate();
    await requested;
    releaseJob?.();

    const body = await (await pending).json() as Record<string, unknown>;

    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  it('delivers the result to a client that reconnected after a refresh', async () => {
    const controller = new AbortController();
    const initiallyRequested = waitForGenerationRequest();
    generate(controller.signal).catch(() => {});
    await initiallyRequested;
    controller.abort();

    // The reloaded page sees work in progress and re-attaches to it.
    const read = await (await fetch(
      `${base}/api/walkthrough?directory=/repo&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    )).json() as Record<string, unknown>;
    expect(read.generating).toBe(true);

    const reattachRequested = waitForGenerationRequest();
    const reattached = generate();
    await reattachRequested;
    releaseJob?.();

    const body = await (await reattached).json() as Record<string, unknown>;
    expect(body.walkthrough).toEqual({ title: 'DONE' });
  });

  it('rejects a request without a directory before touching the service', async () => {
    const response = await fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: SOURCE }),
    });

    expect(response.status).toBe(400);
    expect(job).toBeNull();
  });

  // The language belongs to the request, not to a setting, so both the read
  // and the generation have to carry it: readiness is computed from a prompt
  // that contains the language instruction.
  it('carries the requested language into the service', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );
    expect(lastArgs?.language).toBe('uk');

    const requested = waitForGenerationRequest();
    const pending = fetch(`${base}/api/walkthrough/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE, language: 'ja' }),
    });
    await requested;
    releaseJob?.();
    await pending;

    expect(lastArgs?.language).toBe('ja');
  });

  it('ignores a language that is not a string', async () => {
    await fetch(
      `${base}/api/walkthrough?directory=/repo&language[]=uk&source=${encodeURIComponent(JSON.stringify(SOURCE))}`,
    );

    expect(lastArgs?.language).toBeUndefined();
  });

  it('cancels through its own endpoint rather than a dropped connection', async () => {
    const requested = waitForGenerationRequest();
    generate().catch(() => {});
    await requested;

    const response = await fetch(`${base}/api/walkthrough/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', source: SOURCE }),
    });

    expect(await response.json()).toEqual({ cancelled: true });
    releaseJob?.();
  });
});
