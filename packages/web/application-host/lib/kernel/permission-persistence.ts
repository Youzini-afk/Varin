import { evaluateGate, mergeHarnessSettings, validatePermissionRule, type HarnessSettingsInput, type JsonValue, type PermissionRule } from '@varin/protocol';
import type { AgentSettingsService } from '../models/settings.js';
import { HostToolAdmissionError } from './tool-admission.js';
import type { PermissionPersistence, PermissionTarget } from './permission-service.js';

/** Persists explicit user choices through the existing configuration owner.
 * Source grants and workspace restrictions remain with their original owners. */
export function createPermissionPersistence(settings: AgentSettingsService, sourceDirectory: (runId: string) => Promise<string | undefined>): PermissionPersistence {
  const candidate = (target: PermissionTarget): PermissionRule => validatePermissionRule({ tool: target.name, decision: 'allow' });
  const stage = (global: Record<string, JsonValue>, rule: PermissionRule) => {
    const harness = (global.harness ?? {}) as HarnessSettingsInput;
    const rules = harness.permissions?.rules ?? [];
    const duplicate = (value: PermissionRule) => value.tool === rule.tool && value.decision === 'allow' && !value.match;
    return { ...harness, permissions: { ...harness.permissions, rules: [rule, ...rules.filter(value => !duplicate(value))] } };
  };
  const allowed = (global: Record<string, JsonValue>, project: Record<string, JsonValue>, target: PermissionTarget, rule: PermissionRule) => {
    const harness = mergeHarnessSettings(stage(global, rule), (project.harness ?? {}) as HarnessSettingsInput);
    return evaluateGate(target.name, target.arguments, { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] }).decision === 'allow';
  };
  return {
    async prepare(runId, target) {
      const snapshot = await settings.snapshot(await sourceDirectory(runId)), rule = candidate(target);
      return { tool: rule.tool, scope: 'tool', available: allowed(snapshot.global, snapshot.project, target, rule) };
    },
    async save(runId, target, signal) {
      const rule = candidate(target), cwd = await sourceDirectory(runId);
      for (;;) {
        signal.throwIfAborted();
        const snapshot = await settings.snapshot(cwd);
        if (!allowed(snapshot.global, snapshot.project, target, rule)) throw new HostToolAdmissionError('permission_policy_constrained');
        try {
          signal.throwIfAborted();
          await settings.updateHarness(snapshot.globalRevision, () => stage(snapshot.global, rule) as unknown as Record<string, JsonValue>);
          // The settings owner preserves concurrent edits with CAS. On a conflict,
          // reread and recompute the same explicit intent, never replace stale rules.
          return rule;
        } catch (error) {
          if ((error as { code?: unknown })?.code !== 'config_conflict') throw error;
        }
      }
    },
  };
}
