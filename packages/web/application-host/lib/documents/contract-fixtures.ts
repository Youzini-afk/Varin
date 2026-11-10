import { bindDocumentTextCodec, type DocumentTextCodec } from './inspect.js';
import { utf8CoordinationCodec } from './codec.test-helper.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDocumentAuthority,
  type DocumentAuthority,
  type DocumentAuthorityOptions,
  type ResolveWorkspaceResult,
} from './authority.js';

interface DocumentResource {
  workspaceId: string;
  resourceId: string;
}

interface DocumentTokenOwner {
  kind: string;
  id: string;
}

interface DocumentToken {
  workspaceId: string;
  epoch: number;
  owner: DocumentTokenOwner;
}

export interface DocumentAuthorityHarnessOverrides {
  textCodec?: DocumentTextCodec;
  trusted?: boolean | undefined;
  allowedRoot?: string | undefined;
  hostId?: string | undefined;
  overflowLimit?: number | undefined;
  authority?: Partial<Omit<DocumentAuthorityOptions, 'dataDir' | 'hostId'>> | undefined;
}

export interface DocumentAuthorityHarness {
  authority: DocumentAuthority;
  identity: ResolveWorkspaceResult;
  root: string;
  workspaceRoot: string;
  dataDir: string;
  setTrusted: (value: boolean) => void;
  resource: (resourceId: string) => DocumentResource;
  token: (epoch?: number, owner?: DocumentTokenOwner) => DocumentToken;
  cleanup: () => Promise<void>;
}

export const createDocumentAuthorityHarness = async (
  overrides: DocumentAuthorityHarnessOverrides = {},
): Promise<DocumentAuthorityHarness> => {
  // Runner temp directories can be junctions; use the same canonical paths as Documents.
  const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-documents-')));
  const workspaceRoot = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  await fs.promises.mkdir(workspaceRoot, { recursive: true });
  let trusted: boolean = overrides.trusted ?? true;
  const allowedRootInput = overrides.allowedRoot ?? workspaceRoot;
  const allowedRoot = await fs.promises.realpath(allowedRootInput);
  const releaseCodec = bindDocumentTextCodec(overrides.textCodec ?? utf8CoordinationCodec);
  const authority = createDocumentAuthority({
    hostId: overrides.hostId ?? '11111111-1111-4111-8111-111111111111',
    dataDir,
    isTrusted: async () => trusted,
    isAllowedRoot: async (candidate: string) => {
      const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      const allowed = process.platform === 'win32' ? allowedRoot.toLowerCase() : allowedRoot;
      return normalized === allowed || normalized.startsWith(`${allowed}${path.sep}`);
    },
    overflowLimit: overrides.overflowLimit ?? 256,
    ...(overrides.authority ?? {}),
  });
  const identity = await authority.resolveWorkspace({ path: workspaceRoot });
  return {
    authority,
    identity,
    root,
    workspaceRoot,
    dataDir,
    setTrusted: (value: boolean) => {
      trusted = value;
    },
    resource: (resourceId: string) => ({ workspaceId: identity.workspaceId, resourceId }),
    token: (
      epoch: number = identity.epoch,
      owner: DocumentTokenOwner = { kind: 'test', id: 'document-contract' },
    ) => ({
      workspaceId: identity.workspaceId,
      epoch,
      owner,
    }),
    async cleanup() {
      await authority.dispose();
      releaseCodec();
      // Windows keeps a directory handle open until every child process that touched it has fully
      // exited, so removal races with process teardown and fails with EBUSY. `force` only ignores
      // a missing path, so ask for the retry backoff that covers a busy one.
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
};
