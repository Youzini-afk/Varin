import type { JsonObject } from './types.js';
import { parseVarinPackageSourcePath } from './runtime-source.js';

export const VARIN_EXTENSION_PACKAGES_CAPABILITY = 'runtime.extension-packages';

export type VarinExtensionSourceResourceOwner = { kind: 'local' } | {
  kind: 'managed_host'; hostId: string; connectionId: string; endpointIdentity: string;
};

/** Attribution of the bytes captured by the original Source owner. Never a path grant. */
export interface VarinExtensionSourceViewProvenance {
  resourceOwner: VarinExtensionSourceResourceOwner;
  workspaceId: string;
  executionWorkspaceId: string;
  runId: string;
  operationId: string;
  mode: 'fixed_branch' | 'materialized' | 'live_root';
  packagePath: string;
  captureIntegrity: string;
  branchId?: string;
  revision?: number;
  environmentRunId?: string;
  rootId?: string;
}
export type VarinExtensionPackageRequest =
  | { action: 'stage'; packagePath: string; expectedRevision: number }
  | { action: 'apply'; extensionId: string; candidateIntegrity: string; expectedRevision: number };
export interface VarinExtensionPackageResult {
  outcome: 'installed_disabled' | 'candidate_staged' | 'application_requested' | 'selected';
  extensionId: string;
  artifactIntegrity: string;
  catalogRevision: number;
  applicationRequested: boolean;
  /** A submitted application request survives cancellation of its caller. */
  resumesOnRestart: boolean;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Extension package request must be an object');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Extension package identity must be nonempty');
  return value;
};
const revision = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Extension catalog revision must be nonnegative');
  return Number(value);
};
const integrity = (value: unknown): string => {
  const result = text(value);
  if (!/^sha256-[a-f0-9]{64}$/.test(result)) throw new Error('Extension artifact integrity must be a SHA-256 content address');
  return result;
};
export function parseVarinExtensionPackagePath(value: unknown): string {
  return value === '.' ? '.' : parseVarinPackageSourcePath(value);
}
export function parseVarinExtensionPackageRequest(value: unknown): VarinExtensionPackageRequest {
  const input = object(value);
  const keys = input.action === 'stage' ? ['action', 'packagePath', 'expectedRevision']
    : input.action === 'apply' ? ['action', 'extensionId', 'candidateIntegrity', 'expectedRevision'] : [];
  if (!keys.length || Object.keys(input).some(key => !keys.includes(key))) throw new Error('Invalid extension package action or fields');
  const expectedRevision = revision(input.expectedRevision);
  return input.action === 'stage'
    ? { action: 'stage', packagePath: parseVarinExtensionPackagePath(input.packagePath), expectedRevision }
    : { action: 'apply', extensionId: text(input.extensionId), candidateIntegrity: integrity(input.candidateIntegrity), expectedRevision };
}
export function parseVarinExtensionSourceViewProvenance(value: unknown): VarinExtensionSourceViewProvenance {
  const v = object(value);
  const owner = object(v.resourceOwner);
  let resourceOwner: VarinExtensionSourceResourceOwner;
  if (owner.kind === 'local') resourceOwner = { kind: 'local' };
  else if (owner.kind === 'managed_host') resourceOwner = { kind: 'managed_host', hostId: text(owner.hostId),
    connectionId: text(owner.connectionId), endpointIdentity: text(owner.endpointIdentity) };
  else throw new Error('Invalid package source resource owner');
  if (Object.keys(owner).some(key => !(key in resourceOwner))) throw new Error('Unsupported package source resource owner field');
  if (!['fixed_branch', 'materialized', 'live_root'].includes(String(v.mode))) throw new Error('Invalid package SourceView mode');
  const result: VarinExtensionSourceViewProvenance = {
    resourceOwner,
    workspaceId: text(v.workspaceId), executionWorkspaceId: text(v.executionWorkspaceId),
    runId: text(v.runId), operationId: text(v.operationId), mode: v.mode as VarinExtensionSourceViewProvenance['mode'],
    packagePath: parseVarinExtensionPackagePath(v.packagePath), captureIntegrity: integrity(v.captureIntegrity),
  };
  if (v.branchId !== undefined) result.branchId = text(v.branchId);
  if (v.revision !== undefined) result.revision = revision(v.revision);
  if (v.environmentRunId !== undefined) result.environmentRunId = text(v.environmentRunId);
  if (v.rootId !== undefined) result.rootId = text(v.rootId);
  if (result.mode !== 'live_root' && (!result.branchId || result.revision === undefined)) throw new Error('Fixed package source needs its original branch revision');
  if (result.mode !== 'fixed_branch' && !result.rootId) throw new Error('Physical package source needs its original root identity');
  if (result.mode === 'live_root' && (result.branchId !== undefined || result.revision !== undefined || result.environmentRunId !== undefined)) throw new Error('Live package source cannot claim a branch or materialized environment');
  if (result.mode === 'fixed_branch' && (result.rootId !== undefined || result.environmentRunId !== undefined)) throw new Error('Fixed package source cannot claim a physical root');
  if (Object.keys(v).some(key => !(key in result))) throw new Error('Unsupported package SourceView provenance field');
  return result;
}
export const VARIN_EXTENSION_PACKAGE_REQUEST_SCHEMA: JsonObject = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['action', 'packagePath', 'expectedRevision'], properties: {
      action: { const: 'stage' }, packagePath: { type: 'string', minLength: 1 }, expectedRevision: { type: 'integer', minimum: 0 },
    } },
    { type: 'object', additionalProperties: false, required: ['action', 'extensionId', 'candidateIntegrity', 'expectedRevision'], properties: {
      action: { const: 'apply' }, extensionId: { type: 'string', minLength: 1 },
      candidateIntegrity: { type: 'string', pattern: '^sha256-[a-f0-9]{64}$' }, expectedRevision: { type: 'integer', minimum: 0 },
    } },
  ],
};
