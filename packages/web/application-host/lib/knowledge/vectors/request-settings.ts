import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import type { EmbeddingRequestConfiguration } from '@varin/application-client';

export const DEFAULT_EMBEDDING_REQUEST_CONFIGURATION: EmbeddingRequestConfiguration = {
  concurrentRequests: 1,
  requestIntervalMs: 0,
};

function parseConfiguration(value: unknown): EmbeddingRequestConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid embedding request configuration');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => key !== 'concurrentRequests' && key !== 'requestIntervalMs');
  if (unknown.length) throw new Error(`Unsupported embedding request settings: ${unknown.join(', ')}`);
  const concurrentRequests = input.concurrentRequests ?? 1;
  const requestIntervalMs = input.requestIntervalMs ?? 0;
  if (!Number.isSafeInteger(concurrentRequests) || Number(concurrentRequests) < 1) throw new Error('Concurrent requests must be a positive integer');
  // Node timers use a signed 32-bit millisecond duration.
  if (!Number.isSafeInteger(requestIntervalMs) || Number(requestIntervalMs) < 0 || Number(requestIntervalMs) > 2_147_483_647) throw new Error('Request interval must be a non-negative timer duration');
  return { concurrentRequests: Number(concurrentRequests), requestIntervalMs: Number(requestIntervalMs) };
}

const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** Host-wide scheduling preferences for memory and knowledge embedding requests. */
export function createEmbeddingRequestSettings(dataDirectory: string) {
  const file = path.join(dataDirectory, 'embedding-request-settings.json');
  let active = { ...DEFAULT_EMBEDDING_REQUEST_CONFIGURATION };
  let tail = Promise.resolve();
  const read = async () => {
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { config: { ...DEFAULT_EMBEDDING_REQUEST_CONFIGURATION }, revision: revisionOf('') };
    }
    try { return { config: parseConfiguration(JSON.parse(text)), revision: revisionOf(text) }; }
    catch (error) { return { config: { ...DEFAULT_EMBEDDING_REQUEST_CONFIGURATION }, revision: revisionOf(text), error: error instanceof Error ? error.message : String(error) }; }
  };
  const load = async () => {
    const saved = await read();
    active = { ...saved.config };
    return saved;
  };
  const save = (value: unknown, revision: string) => {
    const run = tail.then(async () => {
      const config = parseConfiguration(value);
      if ((await read()).revision !== revision) throw new Error('Embedding request settings changed elsewhere; refresh before saving');
      const text = `${JSON.stringify(config, null, 2)}\n`;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await mkdir(dataDirectory, { recursive: true });
        await writeFile(temporary, text, { flag: 'wx' });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
      return { config, revision: revisionOf(text) };
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const snapshot = async () => {
    const saved = await read();
    return { ...saved, activeConfig: { ...active }, restartRequired: JSON.stringify(saved.config) !== JSON.stringify(active) };
  };
  return { read, load, save, snapshot, active: () => ({ ...active }) };
}

export function registerEmbeddingRequestRoutes(app: Express, owner: ReturnType<typeof createEmbeddingRequestSettings>, requireAuth: RequestHandler) {
  const endpoint = '/api/harness/embedding-requests';
  app.get(endpoint, requireAuth, async (_request, response, next) => {
    try { response.setHeader('Cache-Control', 'no-store'); response.json(await owner.snapshot()); }
    catch (error) { next(error); }
  });
  app.put(endpoint, requireAuth, express.json({ limit: '50mb' }), async (request, response) => {
    try {
      if (typeof request.body?.revision !== 'string') { response.status(400).json({ error: 'An embedding request settings revision is required' }); return; }
      const saved = await owner.save(request.body.config, request.body.revision);
      const activeConfig = owner.active();
      response.json({ ...saved, activeConfig, restartRequired: JSON.stringify(saved.config) !== JSON.stringify(activeConfig) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(message.includes('changed elsewhere') ? 409 : 400).json({ error: message });
    }
  });
}
