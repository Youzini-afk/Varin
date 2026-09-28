import { isPathWithinRoot } from '../workspace/path-safety.js';
import type { PathLike } from 'node:fs';

export interface DocumentRootGuardOptions {
  fsPromises: { realpath(path: PathLike): Promise<string> };
  pathModule: typeof import('node:path');
  /** Deployment boundary only. Project lists and navigation never grant access. */
  workspace: { root: string; lockdown: boolean };
  platform?: NodeJS.Platform;
}

export type DocumentRootGuard = (canonicalPath: string) => Promise<boolean>;

export const createDocumentRootGuard = ({
  fsPromises,
  pathModule,
  workspace,
  platform = process.platform,
}: DocumentRootGuardOptions): DocumentRootGuard => async (canonicalPath) => {
  if (!workspace.lockdown) return true;
  const real = await fsPromises.realpath(workspace.root);
  return isPathWithinRoot(canonicalPath, real, pathModule, { platform });
};
