import { evaluatePermissionSubjects, mergeHarnessSettings, validatePermissionRule, type HarnessSettingsInput, type JsonValue, type PermissionRule, type PermissionSubject } from '@varin/protocol';
import type { AgentSettingsService } from '../models/settings.js';
import { HostToolAdmissionError } from './tool-admission.js';
import type { PermissionPersistence, PermissionTarget } from './permission-service.js';

/** Persists explicit user choices through the existing configuration owner.
 * Source grants and workspace restrictions remain with their original owners. */
export function createPermissionPersistence(settings: AgentSettingsService, sourceDirectory: (runId: string) => Promise<string | undefined>): PermissionPersistence {
  const subjects = (target: PermissionTarget): PermissionSubject[] => target.subjects ?? [{ tool: target.name, arguments: target.arguments }];
  const candidates = (target: PermissionTarget): PermissionRule[] => [...new Map(subjects(target).map(subject => {
    const rule = validatePermissionRule({ tool: subject.tool, decision: 'allow',
      ...(subject.authority === undefined ? {} : { authority: subject.authority }),
      ...(subject.persistMatch === undefined ? {} : { match: subject.persistMatch }) });
    return [JSON.stringify(rule), rule];
  })).values()];
  const stage = (global: Record<string, JsonValue>, additions: PermissionRule[]) => {
    const harness = (global.harness ?? {}) as HarnessSettingsInput;
    const rules = harness.permissions?.rules ?? [];
    const duplicate = (value: PermissionRule) => additions.some(rule => value.tool === rule.tool && value.decision === 'allow'
      && value.authority === rule.authority && value.match?.param === rule.match?.param && value.match?.pattern === rule.match?.pattern);
    return { ...harness, permissions: { ...harness.permissions, rules: [...additions, ...rules.filter(value => !duplicate(value))] } };
  };
  const allowed = (global: Record<string, JsonValue>, project: Record<string, JsonValue>, target: PermissionTarget, rules: PermissionRule[]) => {
    const current = mergeHarnessSettings((global.harness ?? {}) as HarnessSettingsInput, (project.harness ?? {}) as HarnessSettingsInput);
    if (evaluatePermissionSubjects(subjects(target), { mode: current.permissions?.mode ?? 'normal', rules: current.permissions?.rules ?? [] }).decision === 'deny') return false;
    const harness = mergeHarnessSettings(stage(global, rules), (project.harness ?? {}) as HarnessSettingsInput);
    return evaluatePermissionSubjects(subjects(target), { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] }).decision === 'allow';
  };
  return {
    async prepare(runId, target) {
      const snapshot = await settings.snapshot(await sourceDirectory(runId)), rules = candidates(target);
      return { tool: target.name, scope: target.subjects ? 'targets' : 'tool', available: allowed(snapshot.global, snapshot.project, target, rules),
        ...(target.subjects ? { targets: target.subjects.map(subject => ({ tool: subject.tool,
          ...(subject.authority === undefined ? {} : { authority: subject.authority }),
          ...(subject.label === undefined ? {} : { label: subject.label }),
          ...(subject.persistMatch === undefined ? {} : { match: subject.persistMatch }) })) } : {}) };
    },
    async save(runId, target, signal) {
      const rules = candidates(target), cwd = await sourceDirectory(runId);
      for (;;) {
        signal.throwIfAborted();
        const snapshot = await settings.snapshot(cwd);
        if (!allowed(snapshot.global, snapshot.project, target, rules)) throw new HostToolAdmissionError('permission_policy_constrained');
        try {
          signal.throwIfAborted();
          const committed = await settings.updateHarness(snapshot.globalRevision, () => stage(snapshot.global, rules) as unknown as Record<string, JsonValue>);
          // The settings owner preserves concurrent edits with CAS. On a conflict,
          // reread and recompute the same explicit intent, never replace stale rules.
          return { rules: rules.length === 1 ? rules[0]! : rules,
            settingsRevision: { before: snapshot.globalRevision, after: committed.revision } };
        } catch (error) {
          if ((error as { code?: unknown })?.code !== 'config_conflict') throw error;
        }
      }
    },
  };
}
