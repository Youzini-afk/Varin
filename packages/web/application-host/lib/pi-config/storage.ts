import { sharedHostCredentialAuthority } from '@varin/runtime-broker';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const resolvePiAgentDir = (): string => {
  const configured = process.env.VARIN_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  return typeof configured === 'string' && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.homedir(), '.pi', 'agent');
};

export const getPiAuthFilePath = (): string => path.join(resolvePiAgentDir(), 'auth.json');

const readJsonObject = (filePath: string | null): JsonObject => {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Failed to read Pi configuration: ${filePath}`, { cause: error });
  }
};

const mergeObjects = (base: JsonObject, override: JsonObject): JsonObject => {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result && isObject(result[key]) && isObject(value)
      ? mergeObjects(result[key], value)
      : value;
  }
  return result;
};

export const readPiAuthFile = (): JsonObject => readJsonObject(getPiAuthFilePath());

export const savePiProviderAuth = async (providerId: unknown, entry: JsonObject = {}): Promise<unknown> => {
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('Provider ID is required');
  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (!key) throw new Error('API key is required');
  return sharedHostCredentialAuthority(resolvePiAgentDir()).modifyWithIntent(providerId.trim(), 'replace', async () => ({ type: 'api_key', key }));
};

export const removePiProviderAuth = async (providerId: unknown): Promise<boolean> => {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  if (!id) throw new Error('Provider ID is required');
  const owner = sharedHostCredentialAuthority(resolvePiAgentDir());
  if (!await owner.readRaw(id)) return false;
  await owner.delete(id);
  return true;
};

export const readPiConfigLayers = (workingDirectory: unknown) => {
  const agentDir = resolvePiAgentDir();
  const userSettingsPath = path.join(agentDir, 'settings.json');
  const userModelsPath = path.join(agentDir, 'models.json');
  const projectRoot = typeof workingDirectory === 'string' && workingDirectory.trim()
    ? path.resolve(workingDirectory.trim(), '.pi')
    : null;
  const projectSettingsPath = projectRoot ? path.join(projectRoot, 'settings.json') : null;
  const projectModelsPath = projectRoot ? path.join(projectRoot, 'models.json') : null;
  const userConfig = mergeObjects(readJsonObject(userSettingsPath), readJsonObject(userModelsPath));
  const projectConfig = mergeObjects(readJsonObject(projectSettingsPath), readJsonObject(projectModelsPath));
  return {
    userConfig,
    projectConfig,
    mergedConfig: mergeObjects(userConfig, projectConfig),
    paths: { projectModelsPath, projectSettingsPath, userModelsPath, userSettingsPath },
  };
};

export const readPiConfiguration = (workingDirectory: unknown): JsonObject => readPiConfigLayers(workingDirectory).mergedConfig;
