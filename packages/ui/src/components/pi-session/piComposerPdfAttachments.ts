import type {
  DocumentsAPI,
  WorkspaceAPI,
  WorkspaceUploadFile,
} from '@varin/application-client';
import type { SessionWorkspaceBinding } from '@varin/protocol';
import { parseHarnessThreadProjection } from './harnessThreadPresentation';

export interface PiComposerAttachmentTarget {
  cwd: string;
  runtimeKey: string;
  scopeId: string;
  sessionId: string | null;
  parentSessionId?: string | null;
  workspace?: SessionWorkspaceBinding;
}

export type PiComposerPdfUploadResult =
  | { status: 'stale'; references: []; failures: [] }
  | { status: 'unsupported'; references: []; failures: [] }
  | {
      status: 'complete';
      references: string[];
      failures: Array<{ error: unknown; name: string }>;
    };

export const isPiComposerPdfFile = (file: Pick<File, 'name' | 'type'>): boolean => (
  file.type.toLowerCase() === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
);

export const splitPiComposerAttachmentFiles = (files: Iterable<File>): {
  images: File[];
  pdfs: File[];
} => {
  const images: File[] = [];
  const pdfs: File[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) images.push(file);
    else if (isPiComposerPdfFile(file)) pdfs.push(file);
  }
  return { images, pdfs };
};

const normalizeAbsolutePath = (value: string): string => {
  const hasUncPrefix = value.startsWith('\\\\') || value.startsWith('//');
  let normalized = value.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/');
  if (hasUncPrefix) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/gu, '');
  return normalized;
};

export const getWorkspaceRelativeDirectory = (
  workspaceRoot: string,
  sessionCwd: string,
  separator: string,
): string | null => {
  const root = normalizeAbsolutePath(workspaceRoot);
  const cwd = normalizeAbsolutePath(sessionCwd);
  if (!root || !cwd) return null;

  const caseInsensitive = separator === '\\' || /^[A-Za-z]:\//u.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCwd = caseInsensitive ? cwd.toLowerCase() : cwd;
  if (comparableRoot === comparableCwd) return '';

  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const comparablePrefix = caseInsensitive ? rootPrefix.toLowerCase() : rootPrefix;
  if (!comparableCwd.startsWith(comparablePrefix)) return null;
  return cwd.slice(rootPrefix.length);
};

export const safePiComposerAttachmentScope = (scopeId: string): string => {
  const safe = scopeId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Attachment scope is invalid');
  return safe;
};

export const getPiComposerAttachmentBasename = (fileName: string): string => {
  const basename = fileName.replace(/\\/gu, '/').split('/').pop() ?? '';
  if (!basename || basename === '.' || basename === '..') {
    throw new Error('PDF file name is invalid');
  }
  return basename;
};

export const buildPiComposerPdfUploadDirectory = (
  workspaceRoot: string,
  sessionCwd: string,
  separator: string,
  scopeId: string,
  uploadId: string,
): string | null => {
  const relativeCwd = getWorkspaceRelativeDirectory(workspaceRoot, sessionCwd, separator);
  if (relativeCwd === null) return null;
  const scope = safePiComposerAttachmentScope(scopeId);
  const upload = safePiComposerAttachmentScope(uploadId);
  return [relativeCwd, '.varin', 'attachments', scope, upload].filter(Boolean).join('/');
};

const markdownLabel = (value: string): string => value
  .replace(/[\r\n]+/gu, ' ')
  .replace(/\\/gu, '\\\\')
  .replace(/\[/gu, '\\[')
  .replace(/\]/gu, '\\]');

const markdownDestination = (value: string): string => value
  .replace(/\\/gu, '/')
  .replace(/%/gu, '%25')
  .replace(/ /gu, '%20')
  .replace(/[?#<>]/gu, (character) => `%${character.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`);

export const buildPiComposerPdfDraftReference = (name: string, absolutePath: string): string => (
  `[${markdownLabel(name)}](<${markdownDestination(absolutePath)}>) — ${absolutePath}`
);

const isSameBinding = (
  left: SessionWorkspaceBinding | undefined,
  right: SessionWorkspaceBinding | undefined,
): boolean => (
  left?.kind === right?.kind
  && (left?.kind !== 'workspace' || right?.kind !== 'workspace'
    || (left.id === right.id && left.authorityId === right.authorityId))
);

export const isSamePiComposerAttachmentTarget = (
  left: PiComposerAttachmentTarget,
  right: PiComposerAttachmentTarget,
): boolean => (
  left.cwd === right.cwd
  && left.runtimeKey === right.runtimeKey
  && left.scopeId === right.scopeId
  && left.sessionId === right.sessionId
  && isSameBinding(left.workspace, right.workspace)
  && left.parentSessionId === right.parentSessionId
);

/**
 * Thread sessions can read from an immutable WorkingState view instead of the
 * files on disk. An attachment uploaded through WorkspaceAPI would then be
 * invisible to document.readSource, so resolve the current session's thread
 * view before writing the file.
 */
export const isPiComposerPdfUploadUnsupportedForSession = async (
  input: {
    parentSessionId?: string | null;
    sessionId: string | null;
    fetchThreads(path: string): Promise<Response>;
  },
): Promise<boolean> => {
  if (!input.sessionId || !input.parentSessionId) return false;
  let response: Response;
  try {
    response = await input.fetchThreads(
      `/api/harness/sessions/${encodeURIComponent(input.parentSessionId)}/threads`,
    );
    if (!response.ok) return true;
    const projection = parseHarnessThreadProjection(await response.json());
    const snapshots = [
      ...projection.threads,
      ...projection.rootThreads,
      ...projection.branches,
    ];
    const current = snapshots.find(({ activeRun }) => activeRun?.sessionId === input.sessionId);
    return current?.thread.worktree?.viewMode === 'virtual';
  } catch {
    // The parent session is known, but failure to resolve its run cannot prove
    // the upload will be visible to document.readSource.
    return true;
  }
};

export const uploadPiComposerPdfFiles = async (
  files: readonly File[],
  options: {
    documents: Pick<DocumentsAPI, 'resolveWorkspace'>;
    isCurrentTarget(): boolean;
    randomUUID(): string;
    target: PiComposerAttachmentTarget;
    workspaceApi: Pick<WorkspaceAPI, 'getRoot' | 'upload'>;
    isSessionUnsupported?(): Promise<boolean>;
  },
): Promise<PiComposerPdfUploadResult> => {
  const pdfFiles = files.filter(isPiComposerPdfFile);
  if (pdfFiles.length === 0) return { status: 'complete', references: [], failures: [] };
  if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };
  if (options.isSessionUnsupported && await options.isSessionUnsupported()) {
    return options.isCurrentTarget()
      ? { status: 'unsupported', references: [], failures: [] }
      : { status: 'stale', references: [], failures: [] };
  }
  if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };

  let root: Awaited<ReturnType<WorkspaceAPI['getRoot']>>;
  try {
    root = await options.workspaceApi.getRoot();
  } catch (error) {
    return {
      status: 'complete',
      references: [],
      failures: pdfFiles.map((file) => ({ error, name: file.name })),
    };
  }
  if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };

  let identity: Awaited<ReturnType<DocumentsAPI['resolveWorkspace']>>;
  try {
    identity = await options.documents.resolveWorkspace({ path: options.target.cwd });
  } catch {
    return { status: 'unsupported', references: [], failures: [] };
  }
  if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };
  const expectedWorkspaceId = options.target.workspace?.kind === 'workspace'
    ? options.target.workspace.authorityId
    : undefined;
  if (expectedWorkspaceId && identity.workspaceId !== expectedWorkspaceId) {
    return { status: 'unsupported', references: [], failures: [] };
  }

  const references: string[] = [];
  const failures: Array<{ error: unknown; name: string }> = [];
  for (const file of pdfFiles) {
    if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };
    let directory: string | null;
    let name: string;
    try {
      name = getPiComposerAttachmentBasename(file.name);
      directory = buildPiComposerPdfUploadDirectory(
        root.root,
        options.target.cwd,
        root.separator,
        options.target.scopeId,
        options.randomUUID(),
      );
    } catch (error) {
      failures.push({ error, name: file.name });
      continue;
    }
    if (directory === null) return { status: 'unsupported', references: [], failures: [] };

    const uploadFile: WorkspaceUploadFile = name === file.name
      ? file
      : new File([file], name, { type: file.type, lastModified: file.lastModified });
    try {
      const result = await options.workspaceApi.upload(directory, [uploadFile]);
      if (!options.isCurrentTarget()) return { status: 'stale', references: [], failures: [] };
      const entry = result.entries.find((candidate) => candidate.type === 'file'
        && candidate.relativePath.startsWith(`${directory}/`));
      if (!result.success || !entry?.path) throw new Error('Workspace upload did not return the saved PDF path');
      references.push(buildPiComposerPdfDraftReference(name, entry.path));
    } catch (error) {
      failures.push({ error, name: file.name });
    }
  }

  return { status: 'complete', references, failures };
};
