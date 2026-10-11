import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  HarnessSettingsValidationError, HarnessInferenceSettingsValidationError, PermissionPolicyValidationError,
  mergeHarnessSettings, parseHarnessEmbeddingSettings, parseHarnessRerankSettings, parseHarnessFastDecisionSettings,
  resolveHarnessCodeRetrievalSettings, resolveHarnessDocumentReadingSettings, resolveHarnessContextSettings,
  type HarnessSettingsInput, type HarnessContextSettings, type JsonValue, type PiSettingsSnapshot, type PiConfigScope,
} from '@varin/protocol';
import { HostError } from './errors.js';
import { JsonObjectFileEditor, applyTopLevelJsonChanges, type JsonObjectDocument, type JsonObjectDocumentReadResult } from './json-object-file-editor.js';

/** Configuration-only read shared by trusted Host consumers, without an AgentSession. */
export function readHostHarnessSettings(agentDir: string, configCwd: string, projectTrusted: boolean) {
  const settings = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  if (settings.drainErrors().length) throw new Error('Harness configuration is unavailable');
  const global = settings.getGlobalSettings() as { harness?: HarnessSettingsInput };
  const project = settings.getProjectSettings() as { harness?: HarnessSettingsInput };
  return mergeHarnessSettings(global.harness ?? {}, projectTrusted ? project.harness ?? {} : {});
}

/** Original SettingsManager/file-lock authority, usable without constructing an AgentSession. */
export async function settingsSnapshot(settings: SettingsManager, agentDir: string, cwd: string): Promise<PiSettingsSnapshot> {
  const [global, project] = await Promise.all([
    new JsonObjectFileEditor(join(agentDir, 'settings.json')).read(),
    new JsonObjectFileEditor(join(cwd, '.pi', 'settings.json')).read(),
  ]);
  return { global: global.document, globalRevision: global.revision, project: project.document,
    projectRevision: project.revision, projectTrusted: settings.isProjectTrusted() };
}

/** Commits only the requested top-level patch under the same revision CAS as Pi settings.
 * Reloading a live Pi session remains its owner's safe-boundary responsibility. */
export async function commitSettingsUpdate(settings: SettingsManager, agentDir: string, cwd: string,
  scope: PiConfigScope, set: JsonValue, remove: readonly string[], expectedRevision: string): Promise<{
    committed: JsonObjectDocumentReadResult; committedContext: HarnessContextSettings | undefined; globalContextSettingChanged: boolean;
  }> {
  if (scope === "project" && !settings.isProjectTrusted()) {
    throw new HostError(
      "project_not_trusted",
      "Project is not trusted; refusing to write project settings",
    );
  }
  await settings.flush();
  const pendingErrors = settings.drainErrors();
  if (pendingErrors.length > 0) {
    throw new HostError(
      "settings_write_failed",
      pendingErrors.map((entry) => entry.error.message).join("; "),
    );
  }
  const settingsPath = scope === "global"
    ? join(agentDir, "settings.json")
    : join(cwd, ".pi", "settings.json");
  const editor = new JsonObjectFileEditor(settingsPath);
  let globalContextSettingChanged = false;
  let committedContext: HarnessContextSettings | undefined;
  if (typeof set !== "object" || set === null || Array.isArray(set)) {
    throw new HostError("invalid_config", "Configuration set must be an object");
  }
  const current = await editor.read();
  const candidate = applyTopLevelJsonChanges(
    current.document,
    set,
    remove,
  );
  try {
    const [globalDocument, projectDocument] = scope === "global"
      ? [candidate, settings.isProjectTrusted()
          ? (await new JsonObjectFileEditor(join(cwd, ".pi", "settings.json")).read()).document
          : {}]
      : [(await new JsonObjectFileEditor(join(agentDir, "settings.json")).read()).document, candidate];
    const globalHarnessValue = globalDocument.harness;
    const projectHarnessValue = projectDocument.harness;
    if (globalHarnessValue !== undefined && (
      typeof globalHarnessValue !== "object" || globalHarnessValue === null || Array.isArray(globalHarnessValue)
    )) {
      throw new HarnessSettingsValidationError("harness must be an object");
    }
    if (projectHarnessValue !== undefined && (
      typeof projectHarnessValue !== "object" || projectHarnessValue === null || Array.isArray(projectHarnessValue)
    )) {
      throw new HarnessSettingsValidationError("project harness must be an object");
    }
    const globalHarness = (globalHarnessValue ?? {}) as HarnessSettingsInput;
    const projectHarness = (projectHarnessValue ?? {}) as HarnessSettingsInput;
    // This is the same merge/validator used to assemble a new Run. It catches
    // malformed permission rules, context values, and scope overlays
    // before the revisioned editor commits the candidate.
    mergeHarnessSettings(globalHarness, projectHarness);
    parseHarnessEmbeddingSettings(globalHarness.embedding);
    parseHarnessRerankSettings(globalHarness.rerank);
    parseHarnessFastDecisionSettings(globalHarness.fastDecision);
    resolveHarnessCodeRetrievalSettings(globalHarness.codeRetrieval);
    resolveHarnessDocumentReadingSettings(globalHarness.documentReading);
    if (scope === "global") {
      const candidateContext = resolveHarnessContextSettings(
        globalHarness.context,
        globalHarness.memory,
      );
      committedContext = candidateContext;
      const currentHarness = current.document.harness as Record<string, unknown> | undefined;
      let currentContext: ReturnType<typeof resolveHarnessContextSettings> | undefined;
      try {
        currentContext = resolveHarnessContextSettings(currentHarness?.context, currentHarness?.memory);
      } catch {
        // A valid candidate may repair malformed persisted context settings.
      }
      globalContextSettingChanged = currentContext === undefined
        || currentContext.backgroundPreparation !== candidateContext.backgroundPreparation
        || currentContext.preparationWaterline !== candidateContext.preparationWaterline
        || JSON.stringify(currentContext.compactionRecovery) !== JSON.stringify(candidateContext.compactionRecovery);
    }
  } catch (error) {
    if (
      error instanceof HarnessSettingsValidationError
      || error instanceof HarnessInferenceSettingsValidationError
      || error instanceof PermissionPolicyValidationError
    ) {
      throw new HostError("invalid_settings", error.message);
    }
    throw error;
  }
  const committed = await editor.updateRevisioned(
    set,
    remove,
    expectedRevision,
  );
  return { committed, committedContext, globalContextSettingChanged };
}

export interface GlobalSettingsSnapshot { document: JsonObjectDocument; revision: string }

/** One narrow queue owns reload/error consumption and profile CAS for this Host manager. */
export class GlobalSettingsAuthority {
  private readonly manager: SettingsManager;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly agentDir: string) {
    this.manager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  }
  private transact<T>(action: () => Promise<T>): Promise<T> {
    const work = this.tail.then(action);
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }
  read(): Promise<GlobalSettingsSnapshot> {
    return this.transact(async () => {
      await this.manager.reload();
      const failures = this.manager.drainErrors();
      if (failures.length) throw new HostError(failures.every(entry => entry.error instanceof SyntaxError)
        ? 'inference-settings-invalid' : 'inference-settings-unavailable', 'Global agent settings could not be read.');
      const snapshot = await new JsonObjectFileEditor(join(this.agentDir, 'settings.json')).read();
      return { document: snapshot.document, revision: snapshot.revision };
    });
  }
  updateHarness(expectedRevision: string, update: (harness: JsonObjectDocument) => JsonObjectDocument): Promise<GlobalSettingsSnapshot> {
    return this.transact(async () => {
      await this.manager.flush();
      const failures = this.manager.drainErrors();
      if (failures.length) throw new HostError('settings_write_failed', 'Global agent settings could not be saved.');
      const current = await new JsonObjectFileEditor(join(this.agentDir, 'settings.json')).read();
      if (current.revision !== expectedRevision) throw new HostError('config_conflict', 'Agent settings changed. Reload them before saving.');
      const raw = current.document.harness;
      if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
        throw new HarnessSettingsValidationError('harness must be an object');
      }
      const harness = update(structuredClone(raw ?? {}) as JsonObjectDocument);
      const result = await commitSettingsUpdate(this.manager, this.agentDir, this.agentDir, 'global', { harness }, [], expectedRevision);
      return { document: result.committed.document, revision: result.committed.revision };
    });
  }
}
