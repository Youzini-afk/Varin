import type { Request } from 'express';
import type path from 'node:path';
import type os from 'node:os';
import type { DocumentAuthority } from '../documents/authority.js';
import type { HostFileResourceBackend } from '../recovery/durable-file-operation.js';

export type PathModule = typeof path;
export type OsModule = Pick<typeof os, 'homedir'>;
export type FsPromises = typeof import('node:fs/promises');

export interface ResolvedProjectDirectory {
  directory?: string | null;
  error?: string | null;
}

export type ResolveProjectDirectory = (request: Request) => Promise<ResolvedProjectDirectory>;

export type WorkspacePathResult =
  | { base: string; ok: true; resolved: string; workspaceRoot: boolean; granted?: boolean }
  | { error: string; ok: false };

export interface CommandResult {
  command: string;
  error?: string;
  exitCode?: number;
  stderr: string;
  stdout: string;
  success: boolean;
}

export interface ExecJob {
  commands: unknown[];
  finishedAt: number | null;
  jobId: string;
  resolvedCwd: string;
  results: CommandResult[];
  shell: string;
  shellFlag: string;
  startedAt: number;
  status: 'queued' | 'running' | 'done';
  success: boolean | null;
  updatedAt: number;
}

export interface FsRouteDependencies {
  buildAugmentedPath(): string;
  crypto: { randomUUID(): string };
  documents?: DocumentAuthority;
  fileResources?: HostFileResourceBackend;
  fsPromises: unknown;
  normalizeDirectoryPath<Value>(path: Value): Value | string;
  os: OsModule;
  path: PathModule;
  varinUserConfigRoot: string;
  platform?: NodeJS.Platform;
  resolveGitBinaryForSpawn(): string;
  resolveProjectDirectory: ResolveProjectDirectory;
  spawn: unknown;
}

export interface FileSearchItem {
  extension?: string;
  name: string;
  path: string;
  relativePath: string;
  /** Native content/state identity observed by the same directory enumeration. */
  revision?: string;
  /** Native disk metadata; an incremental hint, not a content revision. */
  metadata?: { byteLength: string; modifiedTimeNs: string };
}

export type FileSearchEnumerationStatus = "complete" | "incomplete" | "failed" | "cancelled";
export interface FileSearchEnumerationInfo {
  strategy: 'git-visible' | 'directory';
  gitRoot?: string;
  selectedRootIgnored?: boolean;
}

/**
 * Search results carry an optional non-enumerable completeness fact. Existing
 * callers can continue treating the value as a plain array, while destructive
 * catalog reconciliation can refuse an incomplete inventory.
 */
export type FileSearchItems = FileSearchItem[] & {
  enumerationStatus?: FileSearchEnumerationStatus;
  enumerationInfo?: FileSearchEnumerationInfo;
};
