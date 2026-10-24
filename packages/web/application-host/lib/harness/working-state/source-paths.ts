import type { WorkingResult } from './types.js';

export interface SourcePathMap { from: string; to: string }
export function mapSourcePath(file: string, mapping: SourcePathMap): string | null {
  if (mapping.from && file !== mapping.from && !file.startsWith(`${mapping.from}/`)) return null;
  const relative = mapping.from ? file.slice(mapping.from.length).replace(/^\//, '') : file;
  return [mapping.to, relative].filter(Boolean).join('/');
}
export function mapSourceResult(result: WorkingResult, mapping?: SourcePathMap): WorkingResult {
  if (!mapping || !mapping.from && !mapping.to) return result;
  const states = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(values).flatMap(([file, state]) => {
    const mapped = mapSourcePath(file, mapping); return mapped ? [[mapped, state]] : [];
  }));
  return { ...result, baseStates: states(result.baseStates), pathStates: states(result.pathStates),
    changedPaths: result.changedPaths.flatMap(file => { const mapped = mapSourcePath(file, mapping); return mapped ? [mapped] : []; }) };
}
