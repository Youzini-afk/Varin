/** Read the existing user/project configuration assets without opening an AgentSession. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeHarnessSettings, type HarnessSettingsInput } from '@varin/protocol';

export interface ContextPolicySnapshot {
  configurationIdentity: string;
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  backgroundPreparation: boolean;
  preparationWaterline: number;
}
const object = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Context configuration must be an object');
  return value as Record<string, unknown>;
};
async function read(file: string): Promise<{ value: Record<string, unknown>; revision: string }> {
  try {
    const bytes = await readFile(file,'utf8');
    return {value:object(JSON.parse(bytes)),revision:createHash('sha256').update(bytes).digest('hex')};
  } catch(error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {value:{},revision:'absent'};
    throw error;
  }
}
const tokens = (value: unknown, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Compaction token settings must be non-negative integers');
  return Number(value);
};
export async function readContextPolicy(input: {agentDir: string; projectRoot?: string; projectTrusted: boolean; providerId?: string; modelId: string}): Promise<ContextPolicySnapshot> {
  const [global,project] = await Promise.all([
    read(path.join(input.agentDir,'settings.json')),
    input.projectTrusted && input.projectRoot ? read(path.join(input.projectRoot,'.pi','settings.json')) : Promise.resolve({value:{} as Record<string,unknown>,revision:'not-selected'}),
  ]);
  const user = object(global.value.compaction); const local = object(project.value.compaction);
  const modelKey = input.providerId ? `${input.providerId}/${input.modelId}` : undefined;
  const selected = (layer: Record<string,unknown>) => modelKey ? object(object(layer.modelOverrides)[modelKey]) : {};
  const ordinary = {...user,...local}; const override = {...selected(user),...selected(local)};
  // Validate the ordinary values even when a model override is present, matching the existing
  // configuration contract. Per-model overrides precede ordinary trusted project/user values.
  const reserve = tokens(ordinary.reserveTokens,16384); const keep = tokens(ordinary.keepRecentTokens,20000);
  const enabled = ordinary.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new Error('Compaction enabled setting must be boolean');
  const harness = mergeHarnessSettings(global.value.harness as HarnessSettingsInput ?? {},project.value.harness as HarnessSettingsInput ?? {});
  const policy = {enabled,reserveTokens:tokens(override.reserveTokens,reserve),keepRecentTokens:tokens(override.keepRecentTokens,keep),
    backgroundPreparation:harness.context.backgroundPreparation,preparationWaterline:harness.context.preparationWaterline};
  return {...policy,configurationIdentity:createHash('sha256').update(JSON.stringify([global.revision,project.revision,input.projectRoot ?? null,modelKey ?? null,policy])).digest('hex')};
}
