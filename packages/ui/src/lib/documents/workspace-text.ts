import type { DocumentsAPI, VarinDocumentReadResult } from '@varin/application-client';
import { DocumentsError } from '@varin/application-client';
import { documentIdentityForPath } from './path';
import { requireWorkspaceEpoch } from './mutation-token';
import type { DocumentIdentity } from './types';

const WORKSPACE_TEXT_OWNER = { kind: 'workspace-text', id: 'varin-ui' } as const;

export const resolveTextDocumentIdentity = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
): Promise<DocumentIdentity> => {
  const workspace = await documents.resolveWorkspace({ path: workspaceRoot });
  const identity = documentIdentityForPath(workspace.workspaceId, workspaceRoot, filePath);
  if (!identity) {
    throw new DocumentsError('Path is outside the workspace', { reason: 'path-escape' });
  }
  return identity;
};

const textFromRead = (result: VarinDocumentReadResult): string | null => {
  if (result.status === 'missing') return null;
  if (result.status === 'ready') return result.content;
  throw new DocumentsError(
    result.status === 'binary' ? 'Binary files cannot be read as text' : 'Unsupported document encoding',
    { reason: 'failed' },
  );
};

export const readWorkspaceTextFile = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
): Promise<string | null> => {
  const resource = await resolveTextDocumentIdentity(documents, workspaceRoot, filePath);
  return textFromRead(await documents.read(resource));
};

export const writeWorkspaceTextFile = async (
  documents: DocumentsAPI,
  workspaceRoot: string,
  filePath: string,
  content: string,
): Promise<boolean> => {
  const resource = await resolveTextDocumentIdentity(documents, workspaceRoot, filePath);
  const current = await documents.read(resource);
  if (current.status === 'binary' || current.status === 'unsupported-encoding') return false;
  const encoding = current.status === 'ready' ? current.encoding : current.format?.encoding ?? 'utf-8';
  const bom = current.status === 'ready' ? current.bom : current.format?.bom ?? false;
  const expectedRevision = current.status === 'missing' ? null : current.revision;
  const written = await documents.write({
    token: {
      workspaceId: resource.workspaceId,
      epoch: requireWorkspaceEpoch(current.epoch),
      owner: WORKSPACE_TEXT_OWNER,
    },
    resource,
    content,
    encoding,
    bom,
    ...(current.status === 'ready' && current.format ? { sourceFormat: current.format } : {}),
    expectedRevision,
    operationId: crypto.randomUUID(),
  });
  if (written.status === 'written') return true;
  return false;
};
