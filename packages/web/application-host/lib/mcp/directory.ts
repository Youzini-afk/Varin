/** Rebuildable discovery data. A directory entry never carries execution authority. */
import { createSettingsFileStore } from '@varin/settings-store';
import type { Tool, Resource, ResourceTemplate } from './client.js';
import { object } from '../models/configuration.js';

export interface McpDirectorySnapshot {
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: { name: string; description?: string; arguments?: unknown[] }[];
  updatedAt: string;
}
export class McpDirectory {
  readonly #store;
  readonly #entries = new Map<string, McpDirectorySnapshot>();
  readonly #pending = new Map<string, McpDirectorySnapshot>();
  #loading: Promise<void> | undefined;
  #writing: Promise<void> | undefined;
  constructor(path: string, readonly report: (error: unknown) => void) { this.#store = createSettingsFileStore({ filePath: path }); }
  async get(key: string) {
    this.#loading ??= this.#store.read().then(document => {
      if (!object(document.entries)) return;
      for (const [key, value] of Object.entries(document.entries)) {
        if (object(value) && Array.isArray(value.tools) && Array.isArray(value.resources) && Array.isArray(value.resourceTemplates)
          && value.tools.every(tool => object(tool) && typeof tool.name === 'string' && object(tool.inputSchema))
          && Array.isArray(value.prompts) && typeof value.updatedAt === 'string' && !this.#entries.has(key)) this.#entries.set(key, value as unknown as McpDirectorySnapshot);
      }
    }).catch(this.report);
    await this.#loading;
    const entry = this.#entries.get(key); return entry ? structuredClone(entry) : undefined;
  }
  put(key: string, value: McpDirectorySnapshot) {
    const snapshot = structuredClone(value); this.#entries.set(key, snapshot); this.#pending.set(key, snapshot);
    this.#writing ??= Promise.resolve().then(async () => {
      await this.#loading;
      while (this.#pending.size) {
        const batch = [...this.#pending]; this.#pending.clear();
        await this.#store.transact(document => {
          const entries = object(document.entries) ? { ...document.entries } : {};
          for (const [key, value] of batch) Object.defineProperty(entries, key, { value, configurable: true, enumerable: true, writable: true });
          return { document: { version: 1, entries }, result: undefined };
        });
      }
    }).catch(this.report).finally(() => { this.#writing = undefined; if (this.#pending.size) { const entry = this.#pending.entries().next().value!; this.put(...entry); } });
  }
  async close() { while (this.#writing) await this.#writing; }
}
