import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
const recordOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value);

const accessErrorMessage = (label: string, targetPath: string, error: unknown): string => {
  const code = recordOf(error).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return `${label} does not exist: ${targetPath}`;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return `${label} is not accessible: ${targetPath}`;
  }
  return `${label} could not be checked: ${errorMessage(error)}`;
};

export const normalizeRequiredPath = (rawPath: unknown, label = 'Path'): string => {
  const targetPath = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!targetPath) {
    throw new Error(`${label} is required`);
  }
  return path.resolve(targetPath);
};

export const validateLocalPath = async (rawPath: unknown, label = 'Path') => {
  const targetPath = normalizeRequiredPath(rawPath, label);
  let stats;
  try {
    stats = await fsp.stat(targetPath);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  const accessMode = stats.isDirectory()
    ? fs.constants.R_OK | fs.constants.X_OK
    : fs.constants.R_OK;
  try {
    await fsp.access(targetPath, accessMode);
  } catch (error) {
    throw new Error(accessErrorMessage(label, targetPath, error));
  }

  return { path: targetPath, stats };
};

export const unsupportedAppSpecificOpenError = (targetKind: string, platform: NodeJS.Platform = process.platform): string => {
  const platformName = platform === 'linux'
    ? 'Linux'
    : platform === 'win32'
      ? 'Windows'
      : platform;
  return `Opening ${targetKind} in a specific app is not supported on ${platformName} yet. Use the default open action instead.`;
};
