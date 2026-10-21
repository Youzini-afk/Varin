import { join } from 'node:path';
import {
  mergeHarnessSettings, parseHarnessEmbeddingSettings, parseHarnessRerankSettings, parseHarnessFastDecisionSettings,
  parseHarnessImageSettings, resolveHarnessCodeRetrievalSettings, resolveHarnessDocumentReadingSettings,
  type HarnessSettingsInput, type JsonValue, parseModelRetrySettings,
} from '@varin/protocol';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import { parseCompactionSettings } from './compaction-settings.js';
import { readResourceSettings } from '../agent-resources/configuration.js';
import { ConfigurationFile, ModelConfigurationError, object } from './configuration.js';

export function validateAgentSettings(document: Record<string, unknown>): Record<string, JsonValue> {
  for (const key of ['utilityModel'] as const) {
    const value = document[key];
    if (value !== undefined && (!object(value) || Object.keys(value).some(field => field !== 'providerId' && field !== 'modelId')
      || typeof value.providerId !== 'string' || !value.providerId.trim() || typeof value.modelId !== 'string' || !value.modelId.trim())) {
      throw new ModelConfigurationError('invalid_settings', `${key} requires a nonempty providerId and modelId`);
    }
  }
  parseCompactionSettings(document.compaction);
  try { parseModelRetrySettings(document.retry); } catch (error) { throw new ModelConfigurationError('invalid_settings', (error as Error).message); }
  try { readResourceSettings(document); } catch (error) { throw new ModelConfigurationError('invalid_settings', (error as Error).message); }
  if (document.harness !== undefined && !object(document.harness)) throw new ModelConfigurationError('invalid_settings', 'harness must be an object');
  const harness = (document.harness ?? {}) as HarnessSettingsInput;
  mergeHarnessSettings(harness, {});
  parseHarnessEmbeddingSettings(harness.embedding);
  parseHarnessRerankSettings(harness.rerank);
  parseHarnessFastDecisionSettings(harness.fastDecision);
  parseHarnessImageSettings(harness.images);
  resolveHarnessCodeRetrievalSettings(harness.codeRetrieval);
  resolveHarnessDocumentReadingSettings(harness.documentReading);
  return document as Record<string, JsonValue>;
}

/** Agent configuration belongs to the Host and is available without a conversation worker. */
export class AgentSettingsService {
  readonly global: ConfigurationFile<Record<string, JsonValue>>;
  readonly #projects = new Map<string, ConfigurationFile<Record<string, JsonValue>>>();
  readonly #listeners = new Set<(scope: 'global' | 'project', cwd: string | undefined, revision: string) => void>();
  readonly #watches = new Map<string, () => void>();
  constructor(dataDirectory: string, readonly projectTrusted: (cwd: string) => boolean) {
    this.global = new ConfigurationFile(join(dataDirectory, 'agent-settings.json'), validateAgentSettings);
  }
  #project(cwd: string) {
    let file = this.#projects.get(cwd);
    if (!file) { file = new ConfigurationFile(join(cwd, '.varin', 'settings.json'), validateAgentSettings); this.#projects.set(cwd, file); }
    if (this.#listeners.size && !this.#watches.has(cwd)) this.#watch(file, 'project', cwd);
    return file;
  }
  async snapshot(cwd?: string): Promise<AgentSettingsSnapshot> {
    const trusted = cwd !== undefined && this.projectTrusted(cwd);
    const [global, project] = await Promise.all([this.global.read(), trusted ? this.#project(cwd!).read() : { document: {}, revision: 'unselected' }]);
    if (trusted && !this.projectTrusted(cwd!)) throw new ModelConfigurationError('project_trust_revoked', 'Project trust changed while reading settings', 403);
    return { global: global.document, globalRevision: global.revision, project: project.document, projectRevision: project.revision, projectTrusted: trusted };
  }
  async harness(cwd?: string) {
    const snapshot = await this.snapshot(cwd);
    return mergeHarnessSettings((snapshot.global.harness ?? {}) as HarnessSettingsInput, (snapshot.project.harness ?? {}) as HarnessSettingsInput);
  }
  async update(input: { cwd?: string; scope: 'global' | 'project'; expectedRevision: string; set: Record<string, JsonValue>; remove: readonly string[] }) {
    if (!['global', 'project'].includes(input.scope) || !object(input.set) || !Array.isArray(input.remove)
      || input.remove.some(key => typeof key !== 'string') || typeof input.expectedRevision !== 'string') throw new ModelConfigurationError('invalid_settings', 'Invalid settings update');
    if (input.scope === 'project' && (!input.cwd || !this.projectTrusted(input.cwd))) throw new ModelConfigurationError('project_not_trusted', 'Project configuration requires a trusted workspace', 403);
    const file = input.scope === 'global' ? this.global : this.#project(input.cwd!);
    await file.update(input.expectedRevision, document => {
      if (input.scope === 'project' && !this.projectTrusted(input.cwd!)) throw new ModelConfigurationError('project_trust_revoked', 'Project trust changed while saving settings', 403);
      for (const key of input.remove) delete document[key];
      Object.assign(document, input.set);
      return document;
    });
    return this.snapshot(input.cwd);
  }
  read() { return this.global.read(); }
  async updateHarness(expectedRevision: string, update: (harness: Record<string, JsonValue>) => Record<string, JsonValue>) {
    return this.global.update(expectedRevision, document => {
      document.harness = update(structuredClone((document.harness ?? {}) as Record<string, JsonValue>));
      return document;
    });
  }
  subscribe(listener: (scope: 'global' | 'project', cwd: string | undefined, revision: string) => void) {
    this.#listeners.add(listener);
    if (!this.#watches.has('')) this.#watch(this.global, 'global');
    for (const [cwd, file] of this.#projects) if (!this.#watches.has(cwd)) this.#watch(file, 'project', cwd);
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) { for (const stop of this.#watches.values()) stop(); this.#watches.clear(); }
    };
  }
  #watch(file: ConfigurationFile<Record<string, JsonValue>>, scope: 'global' | 'project', cwd?: string) {
    this.#watches.set(cwd ?? '', file.subscribe(revision => {
      for (const listener of this.#listeners) { try { listener(scope, cwd, revision); } catch { console.error('[Settings] Change observer failed'); } }
    }));
  }
}
