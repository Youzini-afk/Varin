import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type Express, type RequestHandler } from "express";
import type { createWorkspaceSemanticRuntime } from "./workspace-runtime.js";
import { semanticRootDir } from "./identity.js";
import type { LocalCpuMode } from './local-cpu-policy.js';
import type { createIndexDirectoryManager, IndexDirectoryAction } from '../index-directories.js';

export interface SemanticIndexConfiguration {
  /** Base directory; the Host-specific index remains under knowledge/<host>/semantic. */
  storageDirectory: string | null;
  concurrentRequests: number;
  requestIntervalMs: number;
  localCpuMode?: LocalCpuMode;
  localCpuThreads?: number | null;
  /** Directory-scoped overrides; all other activated roots retain Git filtering. */
  includeIgnoredDirectories?: string[];
}

export const DEFAULT_SEMANTIC_INDEX_CONFIGURATION: SemanticIndexConfiguration = {
  storageDirectory: null,
  concurrentRequests: 1,
  requestIntervalMs: 0,
  localCpuMode: 'auto',
  localCpuThreads: null,
  includeIgnoredDirectories: [],
};

const parseConfiguration = (value: unknown): SemanticIndexConfiguration => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid semantic index configuration");
  const input = value as Record<string, unknown>;
  const storageDirectory = input.storageDirectory ?? null;
  const concurrentRequests = input.concurrentRequests ?? 1;
  const requestIntervalMs = input.requestIntervalMs ?? 0;
  const localCpuMode = input.localCpuMode ?? 'auto';
  const localCpuThreads = input.localCpuThreads ?? null;
  const includeIgnoredDirectories = input.includeIgnoredDirectories ?? [];
  if (storageDirectory !== null && (typeof storageDirectory !== "string" || !path.isAbsolute(storageDirectory))) {
    throw new Error("Index storage directory must be an absolute path");
  }
  if (!Number.isSafeInteger(concurrentRequests) || Number(concurrentRequests) < 1) {
    throw new Error("Concurrent requests must be a positive integer");
  }
  if (!Number.isSafeInteger(requestIntervalMs) || Number(requestIntervalMs) < 0 || Number(requestIntervalMs) > 2_147_483_647) {
    throw new Error("Request interval must be a non-negative timer duration");
  }
  if (!Array.isArray(includeIgnoredDirectories) || includeIgnoredDirectories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))) {
    throw new Error('Directories including ignored files must be absolute paths');
  }
  if (typeof localCpuMode !== 'string' || !['auto', 'efficient', 'performance'].includes(localCpuMode)) {
    throw new Error('Invalid local CPU mode');
  }
  if (localCpuThreads !== null && (!Number.isSafeInteger(localCpuThreads) || Number(localCpuThreads) < 1)) {
    throw new Error('Local CPU thread budget must be a positive integer or automatic');
  }
  return { storageDirectory: storageDirectory ? path.resolve(storageDirectory as string) : null,
    concurrentRequests: Number(concurrentRequests), requestIntervalMs: Number(requestIntervalMs),
    localCpuMode: localCpuMode as LocalCpuMode, localCpuThreads: localCpuThreads as number | null,
    includeIgnoredDirectories: [...new Set((includeIgnoredDirectories as string[]).map(directory => path.resolve(directory)))],
  };
};

const revisionOf = (text: string): string => createHash("sha256").update(text).digest("hex");
const sameDirectory = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const directoryBytes = async (root: string): Promise<number> => {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filename);
      else if (entry.isFile()) {
        try { total += (await stat(filename)).size; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
  return total;
};

export function createSemanticIndexManagement(dataDir: string, hostId: string) {
  const filePath = path.join(dataDir, "semantic-index-settings.json");
  const isManagedIndexDirectory = (directory: string): boolean => (
    path.isAbsolute(directory) && path.basename(directory) === "semantic"
    && path.basename(path.dirname(directory)) === hostId
    && path.basename(path.dirname(path.dirname(directory))) === "knowledge"
  );
  let active = DEFAULT_SEMANTIC_INDEX_CONFIGURATION;
  let saveTail = Promise.resolve();
  const read = async (): Promise<{ config: SemanticIndexConfiguration; revision: string; retainedDirectories: string[]; error?: string }> => {
    let text: string;
    try { text = await readFile(filePath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {
        config: { ...DEFAULT_SEMANTIC_INDEX_CONFIGURATION }, revision: revisionOf(""), retainedDirectories: [],
      };
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const retainedDirectories = Array.isArray(parsed.retainedDirectories)
        ? parsed.retainedDirectories.filter((item): item is string => typeof item === "string" && isManagedIndexDirectory(item))
        : [];
      return { config: parseConfiguration(parsed), revision: revisionOf(text), retainedDirectories };
    } catch (error) {
      return { config: { ...DEFAULT_SEMANTIC_INDEX_CONFIGURATION }, revision: revisionOf(text),
        retainedDirectories: [], error: error instanceof Error ? error.message : String(error) };
    }
  };
  const load = async (): Promise<{ config: SemanticIndexConfiguration; error?: string }> => {
    const saved = await read();
    active = saved.config;
    return { config: active, ...(saved.error ? { error: saved.error } : {}) };
  };
  const save = (value: unknown, expectedRevision: string): Promise<{ config: SemanticIndexConfiguration; revision: string }> => {
    const run = saveTail.then(async () => {
      const config = parseConfiguration(value);
      const current = await read();
      if (current.revision !== expectedRevision) throw new Error("Index settings changed elsewhere; refresh before saving");
      if (config.storageDirectory) {
        await mkdir(config.storageDirectory, { recursive: true });
        const probe = path.join(config.storageDirectory, `.varin-index-probe-${randomUUID()}`);
        try { await writeFile(probe, "", { flag: "wx" }); }
        finally { await rm(probe, { force: true }).catch(() => undefined); }
      }
      const currentDirectory = activeDirectory();
      const targetDirectory = configuredDirectory(config);
      const retainedDirectories = [...new Set([
        ...current.retainedDirectories,
        ...(sameDirectory(currentDirectory, targetDirectory) ? [] : [currentDirectory]),
      ])].filter((directory) => !sameDirectory(directory, targetDirectory));
      const text = `${JSON.stringify({ ...config, retainedDirectories }, null, 2)}\n`;
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(temp, text, { flag: "wx" });
        await rename(temp, filePath);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }
      return { config, revision: revisionOf(text) };
    });
    saveTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const removeRetained = (directory: string, expectedRevision: string): Promise<void> => {
    const run = saveTail.then(async () => {
      const current = await read();
      if (current.revision !== expectedRevision) throw new Error("Index settings changed elsewhere; refresh before cleaning");
      if (!isManagedIndexDirectory(directory) || sameDirectory(directory, activeDirectory()) || !current.retainedDirectories.includes(directory)) {
        throw new Error("Directory is not an inactive retained index cache");
      }
      const [targetReal, activeReal] = await Promise.all([
        realpath(directory).catch(() => null), realpath(activeDirectory()).catch(() => null),
      ]);
      if (targetReal && activeReal && sameDirectory(targetReal, activeReal)) {
        throw new Error("An active index cannot be removed through another directory path");
      }
      await rm(directory, { recursive: true, force: true });
      const text = `${JSON.stringify({ ...current.config,
        retainedDirectories: current.retainedDirectories.filter((candidate) => candidate !== directory) }, null, 2)}\n`;
      const temp = `${filePath}.${randomUUID()}.tmp`;
      try { await writeFile(temp, text, { flag: "wx" }); await rename(temp, filePath); }
      finally { await rm(temp, { force: true }).catch(() => undefined); }
    });
    saveTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const activeDirectory = () => semanticRootDir(active.storageDirectory ?? dataDir, hostId);
  const configuredDirectory = (config: SemanticIndexConfiguration) => semanticRootDir(config.storageDirectory ?? dataDir, hostId);
  const withCacheMaintenance = <T>(work: () => Promise<T>): Promise<T> => {
    const run = saveTail.then(work);
    saveTail = run.then(() => undefined, () => undefined);
    return run;
  };
  return { read, load, save, removeRetained, withCacheMaintenance, activeDirectory, configuredDirectory, active: () => active, directoryBytes };
}

export function registerSemanticIndexRoutes(
  app: Express,
  options: {
    management: ReturnType<typeof createSemanticIndexManagement>;
    runtime: ReturnType<typeof createWorkspaceSemanticRuntime>;
    directories?: ReturnType<typeof createIndexDirectoryManager>;
    requireAuth?: RequestHandler;
  },
): void {
  const requireAuth: RequestHandler = options.requireAuth ?? ((_request, _response, next) => next());
  const parseSettingsJson = express.json({ limit: '50mb' });
  app.get("/api/harness/semantic-index", requireAuth, async (_request, response, next) => {
    try {
      const saved = await options.management.read();
      const activeDirectory = options.management.activeDirectory();
      const roots = options.runtime.indexStatuses();
      response.setHeader("Cache-Control", "no-store");
      response.json({ config: saved.config, activeConfig: options.management.active(), revision: saved.revision, activeDirectory,
        directories: await options.directories?.list() ?? { revision: '', entries: [] },
        ...(saved.error ? { configError: saved.error } : {}),
        configuredDirectory: options.management.configuredDirectory(saved.config),
        restartRequired: JSON.stringify(saved.config) !== JSON.stringify(options.management.active()),
        bytes: await options.management.directoryBytes(activeDirectory), roots,
        retained: await Promise.all(saved.retainedDirectories.map(async (directory) => ({
          directory, bytes: await options.management.directoryBytes(directory), active: sameDirectory(directory, activeDirectory),
        }))) });
    } catch (error) { next(error); }
  });
  app.post('/api/harness/semantic-index/directories', requireAuth, parseSettingsJson, async (request, response) => {
    try {
      if (!options.directories) { response.status(503).json({ error: 'Index directory management is unavailable' }); return; }
      const { action, directory, revision } = request.body ?? {};
      if (!['add', 'pause', 'resume', 'check', 'remove'].includes(action) || typeof directory !== 'string'
        || !path.isAbsolute(directory) || typeof revision !== 'string') {
        response.status(400).json({ error: 'An index directory, action and revision are required' }); return;
      }
      await options.directories.act(action as IndexDirectoryAction, directory, revision);
      response.status(202).json(options.directories.snapshot());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(message.includes('changed elsewhere') ? 409 : 400).json({ error: message });
    }
  });
  app.put("/api/harness/semantic-index", requireAuth, parseSettingsJson, async (request, response) => {
    try {
      const revision = request.body?.revision;
      if (typeof revision !== "string") {
        response.status(400).json({ error: "An index settings revision is required" });
        return;
      }
      const saved = await options.management.save(request.body?.config, revision);
      response.json({ config: saved.config, activeConfig: options.management.active(), revision: saved.revision,
        activeDirectory: options.management.activeDirectory(),
        configuredDirectory: options.management.configuredDirectory(saved.config),
        restartRequired: JSON.stringify(saved.config) !== JSON.stringify(options.management.active()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(message.includes("changed elsewhere") ? 409 : 400).json({ error: message });
    }
  });
  app.delete("/api/harness/semantic-index/cache", requireAuth, parseSettingsJson, async (request, response) => {
    try {
      if (typeof request.body?.directory !== "string" || typeof request.body?.revision !== "string") {
        response.status(400).json({ error: "A retained directory and settings revision are required" });
        return;
      }
      await options.management.removeRetained(request.body.directory, request.body.revision);
      response.json({ removed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.status(message.includes("changed elsewhere") ? 409 : 400).json({ error: message });
    }
  });
}
