import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  mergeHarnessSettings, parseHarnessWebSearchSettings, parseHarnessWebSourcePreferences, parseHarnessEmbeddingSettings, parseHarnessRerankSettings, parseHarnessFastDecisionSettings,
  parseHarnessImageSettings, resolveHarnessDelegationModelSelectionSettings, resolveHarnessCodeRetrievalSettings, resolveHarnessDocumentReadingSettings,
  type HarnessSettingsInput, type JsonValue, parseModelRetrySettings, THINKING_LEVELS, type ThinkingLevel,
} from '@varin/protocol';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import { parseCompactionSettings } from './compaction-settings.js';
import { readResourceSettings } from '../agent-resources/configuration.js';
import { ConfigurationFile, ModelConfigurationError, object } from './configuration.js';

const permissionMode = (document: Record<string, unknown>): unknown => {
  const harness = object(document.harness) ? document.harness : {};
  return object(harness.permissions) ? harness.permissions.mode : undefined;
};
const assertSupportedPermissionChange = (previous: unknown, document: Record<string, unknown>): void => {
  const next = permissionMode(document);
  if (next !== previous && (next === 'smart' || next === 'accept-edits')) {
    throw new ModelConfigurationError('permission_mode_unavailable',
      `${next} approval is not implemented by the Host permission owner. Choose normal or bypass; existing saved values are read as normal.`);
  }
};

export function validateAgentSettings(document: Record<string, unknown>): Record<string, JsonValue> {
  if (document.titleUpdateInterval !== undefined && (typeof document.titleUpdateInterval !== 'number' || !Number.isSafeInteger(document.titleUpdateInterval) || document.titleUpdateInterval < 0)) {
    throw new ModelConfigurationError('invalid_settings', 'titleUpdateInterval must be a non-negative integer; zero keeps only initial naming');
  }
  if (document.utilityThinkingLevel !== undefined && !THINKING_LEVELS.includes(document.utilityThinkingLevel as ThinkingLevel)) {
    throw new ModelConfigurationError('invalid_settings', 'utilityThinkingLevel must be a supported thinking level');
  }
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
  resolveHarnessDelegationModelSelectionSettings(harness.delegationModelSelection);
  resolveHarnessDocumentReadingSettings(harness.documentReading);
  return document as Record<string, JsonValue>;
}

/** Convert only supported search assets on the original settings write path.
 * Reads keep raw revisions and malformed assets intact. */
const normalizeSearchSettingsForWrite = (document: Record<string, JsonValue>): void => {
  const harness = object(document.harness) ? document.harness : undefined;
  const web = harness && object(harness.web) ? harness.web : undefined;
  if (!web) return;
  if (web.search !== undefined) {
    const normalized = parseHarnessWebSearchSettings(web.search);
    if (normalized) web.search = JSON.parse(JSON.stringify(normalized)) as JsonValue;
  }
  if (web.sourcePreferences !== undefined) {
    const normalized = parseHarnessWebSourcePreferences(web.sourcePreferences);
    if (!normalized) throw new ModelConfigurationError('invalid_settings', 'Invalid web search source preferences');
    web.sourcePreferences = JSON.parse(JSON.stringify(normalized)) as JsonValue;
  }
};

/** Agent configuration belongs to the Host and is available without a conversation worker. */
export class AgentSettingsService {
  readonly global: ConfigurationFile<Record<string, JsonValue>>;
  readonly #projects = new Map<string, ConfigurationFile<Record<string, JsonValue>>>();
  readonly #listeners = new Set<(scope: 'global' | 'project', cwd: string | undefined, revision: string) => void>();
  readonly #watches = new Map<string, () => void>();
  constructor(readonly dataDirectory: string, readonly projectTrusted: (cwd: string) => boolean) {
    this.global = new ConfigurationFile(join(dataDirectory, 'agent-settings.json'), validateAgentSettings);
  }
  #project(cwd: string, registeredProjectId?: string) {
    // Remote project defaults are user-authored coordinator configuration. They
    // do not trust or read a same-named path on this Host or execute remote config.
    if (registeredProjectId !== undefined) {
      const key = `registered:${registeredProjectId}`;
      let file = this.#projects.get(key);
      if (!file) {
        const identity = createHash('sha256').update(registeredProjectId).digest('hex');
        file = new ConfigurationFile(join(this.dataDirectory, 'project-settings', `${identity}.json`), validateAgentSettings);
        this.#projects.set(key, file);
      }
      if (this.#listeners.size && !this.#watches.has(key)) this.#watch(file, 'project', key);
      return file;
    }
    let file = this.#projects.get(cwd);
    if (!file) { file = new ConfigurationFile(join(cwd, '.varin', 'settings.json'), validateAgentSettings); this.#projects.set(cwd, file); }
    if (this.#listeners.size && !this.#watches.has(cwd)) this.#watch(file, 'project', cwd);
    return file;
  }
  async snapshot(cwd?: string, registeredProjectId?: string): Promise<AgentSettingsSnapshot> {
    const trusted = registeredProjectId !== undefined || cwd !== undefined && this.projectTrusted(cwd);
    const [global, project] = await Promise.all([this.global.read(), trusted ? this.#project(cwd ?? '', registeredProjectId).read() : { document: {}, revision: 'unselected' }]);
    if (trusted && registeredProjectId === undefined && !this.projectTrusted(cwd!)) throw new ModelConfigurationError('project_trust_revoked', 'Project trust changed while reading settings', 403);
    return { global: global.document, globalRevision: global.revision, project: project.document, projectRevision: project.revision, projectTrusted: trusted };
  }
  async harness(cwd?: string) {
    const snapshot = await this.snapshot(cwd);
    return mergeHarnessSettings((snapshot.global.harness ?? {}) as HarnessSettingsInput, (snapshot.project.harness ?? {}) as HarnessSettingsInput);
  }
  async update(input: { cwd?: string; registeredProjectId?: string; scope: 'global' | 'project'; expectedRevision: string; set: Record<string, JsonValue>; remove: readonly string[] }) {
    if (!['global', 'project'].includes(input.scope) || !object(input.set) || !Array.isArray(input.remove)
      || input.remove.some(key => typeof key !== 'string') || typeof input.expectedRevision !== 'string') throw new ModelConfigurationError('invalid_settings', 'Invalid settings update');
    if (input.scope === 'project' && input.registeredProjectId === undefined && (!input.cwd || !this.projectTrusted(input.cwd))) throw new ModelConfigurationError('project_not_trusted', 'Project configuration requires a trusted workspace', 403);
    // Resolve contextual layers before the commit; a later observation failure
    // must never hide a successful write or replace its receipt with another edit.
    let observed: AgentSettingsSnapshot;
    try { observed = await this.snapshot(input.cwd, input.registeredProjectId); }
    catch (error) {
      if (input.scope !== 'global' || !input.cwd) throw error;
      // A malformed/unavailable project cannot prevent an independent global edit.
      // Keep that missing observation explicit rather than inventing project defaults.
      observed = { ...await this.snapshot(), effectiveUnavailable: 'Project settings could not be read; effective configuration is unavailable.' };
    }
    const file = input.scope === 'global' ? this.global : this.#project(input.cwd ?? '', input.registeredProjectId);
    const committed = await file.update(input.expectedRevision, document => {
      const previousMode = permissionMode(document);
      if (input.scope === 'project' && input.registeredProjectId === undefined && !this.projectTrusted(input.cwd!)) throw new ModelConfigurationError('project_trust_revoked', 'Project trust changed while saving settings', 403);
      for (const key of input.remove) delete document[key];
      Object.assign(document, input.set);
      assertSupportedPermissionChange(previousMode, document);
      normalizeSearchSettingsForWrite(document);
      return document;
    });
    return input.scope === 'global'
      ? { ...observed, global: committed.document, globalRevision: committed.revision }
      : { ...observed, project: committed.document, projectRevision: committed.revision };
  }
  read() { return this.global.read(); }
  async updateHarness(expectedRevision: string, update: (harness: Record<string, JsonValue>) => Record<string, JsonValue>) {
    return this.global.update(expectedRevision, document => {
      const previousMode = permissionMode(document);
      document.harness = update(structuredClone((document.harness ?? {}) as Record<string, JsonValue>));
      assertSupportedPermissionChange(previousMode, document);
      normalizeSearchSettingsForWrite(document);
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
