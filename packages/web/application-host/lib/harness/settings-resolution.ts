/** Configured values for the next consumer boundary, not a claim that an
 * already admitted Run or in-flight model request has been rewritten. */
import type { AgentSettingsSnapshot, SettingsFieldSpec } from '@varin/application-client';
import { mergeHarnessSettings, resolvePermissionMode, type SettingsEffectiveValue } from '@varin/protocol';

export const settingsPath = (value: unknown, path: string): unknown => {
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function resolveAgentSettingsField(snapshot: AgentSettingsSnapshot, field: SettingsFieldSpec): SettingsEffectiveValue {
  const global = settingsPath(snapshot.global, field.path);
  const projectDocument = snapshot.projectTrusted && field.scope !== 'user' ? snapshot.project : {};
  const project = settingsPath(projectDocument, field.path);
  let value: unknown;
  if (field.path.startsWith('harness.')) {
    const merged = mergeHarnessSettings(record(snapshot.global.harness), record(projectDocument.harness));
    value = settingsPath(merged, field.path.slice('harness.'.length));
  } else if (field.path === 'compaction.modelOverrides') {
    const userOverrides = record(global);
    const projectOverrides = record(project);
    value = Object.fromEntries([...new Set([...Object.keys(userOverrides), ...Object.keys(projectOverrides)])]
      .map(key => [key, { ...record(userOverrides[key]), ...record(projectOverrides[key]) }]));
    if (!Object.keys(value as object).length && global === undefined && project === undefined) value = field.default;
  } else value = project !== undefined ? project : global !== undefined ? global : field.default;
  if (value === undefined) value = field.default;
  const mode = field.path === 'harness.permissions.mode' ? resolvePermissionMode(value as never) : undefined;
  return {
    value: mode ? mode.effective : value,
    ...(mode?.unavailable ? { configured: value, note: `${mode.unavailable} is not implemented; the Host currently applies normal permission semantics` } : {}),
    source: field.path === 'harness.permissions.mode' && value === settingsPath(mergeHarnessSettings(record(snapshot.global.harness), {}), 'permissions.mode')
      ? global !== undefined ? 'user' : 'default'
      : project !== undefined ? global !== undefined && typeof value === 'object' && value !== null ? 'merged' : 'project'
      : global !== undefined ? 'user' : value !== undefined ? 'default' : 'none',
    basis: 'configured',
  };
}
