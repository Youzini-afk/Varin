import { describe, expect, test, vi } from 'vitest';
import type { DocumentsAPI, WorkspaceAPI } from '@varin/application-client';
import type { SessionWorkspaceBinding } from '@varin/protocol';
import {
  buildPiComposerPdfDraftReference,
  buildPiComposerPdfUploadDirectory,
  getPiComposerAttachmentBasename,
  getWorkspaceRelativeDirectory,
  isPiComposerPdfUploadUnsupportedForSession,
  isSamePiComposerAttachmentTarget,
  safePiComposerAttachmentScope,
  splitPiComposerAttachmentFiles,
  uploadPiComposerPdfFiles,
  type PiComposerAttachmentTarget,
} from './piComposerPdfAttachments';

const root = {
  root: '/workspaces',
  separator: '/',
} as Awaited<ReturnType<WorkspaceAPI['getRoot']>>;

const workspaceBinding: SessionWorkspaceBinding = {
  authorityId: 'workspace-authority',
  id: 'project-id',
  kind: 'workspace',
};

const target: PiComposerAttachmentTarget = {
  cwd: '/workspaces/project',
  runtimeKey: 'host-a',
  scopeId: 'session-123',
  sessionId: 'session-123',
  parentSessionId: 'parent-session',
  workspace: workspaceBinding,
};

const makeFile = (name: string, type = 'application/pdf'): File => new File(['pdf bytes'], name, { type });

const createWorkspace = (options: {
  onUpload?(path: string, files: Parameters<WorkspaceAPI['upload']>[1]): ReturnType<WorkspaceAPI['upload']>;
} = {}): Pick<WorkspaceAPI, 'getRoot' | 'upload'> => ({
  getRoot: async () => root,
  upload: options.onUpload ?? (async (path, files) => ({
    success: true,
    entries: files.map((file) => ({
      name: file instanceof File ? file.name : file.name,
      path: `/workspaces/${path}/${file instanceof File ? file.name : file.name}`,
      relativePath: `${path}/${file instanceof File ? file.name : file.name}`,
      type: 'file' as const,
      size: 8,
      modifiedAt: '2026-09-24T00:00:00.000Z',
      mtimeMs: 0,
    })),
  })),
});

const createDocuments = (
  resolveWorkspace: DocumentsAPI['resolveWorkspace'] = async () => ({
    epoch: 1,
    hostId: 'host-a',
    workspaceId: 'workspace-authority',
  }),
): Pick<DocumentsAPI, 'resolveWorkspace'> => ({ resolveWorkspace });

describe('Pi Composer PDF attachments', () => {
  test('keeps image files on the existing path while separating only PDFs for upload', () => {
    const image = new File(['png'], 'image.png', { type: 'image/png' });
    const pdf = makeFile('paper.pdf');
    const unsupported = new File(['data'], 'table.csv', { type: 'text/csv' });

    expect(splitPiComposerAttachmentFiles([image, pdf, unsupported])).toEqual({
      images: [image],
      pdfs: [pdf],
    });
  });

  test('builds a per-file path below the actual session cwd under the authorized workspace root', () => {
    expect(buildPiComposerPdfUploadDirectory(
      '/workspaces',
      '/workspaces/project/subfolder',
      '/',
      'session-123',
      'upload-456',
    )).toBe('project/subfolder/.varin/attachments/session-123/upload-456');
    expect(buildPiComposerPdfUploadDirectory(
      'C:\\Workspaces',
      'C:\\Workspaces\\Project',
      '\\',
      'session-123',
      'upload-456',
    )).toBe('Project/.varin/attachments/session-123/upload-456');
    expect(buildPiComposerPdfUploadDirectory(
      '/workspaces',
      '/outside/project',
      '/',
      'session-123',
      'upload-456',
    )).toBeNull();
  });

  test('uses the server-returned path and displays the original PDF basename', async () => {
    const file = makeFile('reports/Quarter [1].pdf');
    const upload = vi.fn(async (directory: string, files: Parameters<WorkspaceAPI['upload']>[1]) => {
      const uploadedName = files[0]?.name ?? '';
      return {
        success: true,
        entries: [{
          name: uploadedName,
          path: 'C:\\Workspace\\project\\.varin\\attachments\\session-123\\upload-456\\Quarter [1].pdf',
          relativePath: `${directory}/${uploadedName}`,
          type: 'file' as const,
          size: 8,
          modifiedAt: '2026-09-24T00:00:00.000Z',
          mtimeMs: 0,
        }],
      };
    });
    const result = await uploadPiComposerPdfFiles([file], {
      documents: createDocuments(),
      isCurrentTarget: () => true,
      randomUUID: () => 'upload-456',
      target: { ...target, cwd: '/workspaces/project' },
      workspaceApi: createWorkspace({ onUpload: upload }),
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toBe('project/.varin/attachments/session-123/upload-456');
    expect(upload.mock.calls[0]?.[1][0]).toMatchObject({ name: 'Quarter [1].pdf' });
    expect(result).toEqual({
      status: 'complete',
      references: [buildPiComposerPdfDraftReference(
        'Quarter [1].pdf',
        'C:\\Workspace\\project\\.varin\\attachments\\session-123\\upload-456\\Quarter [1].pdf',
      )],
      failures: [],
    });
    expect(result.status === 'complete' ? result.references[0] : '').toContain('C:\\Workspace\\project\\.varin\\attachments\\session-123\\upload-456\\Quarter [1].pdf');
    expect(result.status === 'complete' ? result.references[0] : '').toContain('Quarter \\[1\\].pdf');
  });

  test('rejects an upload if the session workspace binding no longer matches cwd', async () => {
    const upload = vi.fn();
    const result = await uploadPiComposerPdfFiles([makeFile('paper.pdf')], {
      documents: createDocuments(async () => ({
        epoch: 1,
        hostId: 'host-a',
        workspaceId: 'other-workspace',
      })),
      isCurrentTarget: () => true,
      randomUUID: () => 'upload-456',
      target,
      workspaceApi: createWorkspace({ onUpload: upload }),
    });

    expect(result).toEqual({ status: 'unsupported', references: [], failures: [] });
    expect(upload).not.toHaveBeenCalled();
  });

  test('does not return a draft reference after the session or runtime switches during upload', async () => {
    let current = true;
    const upload = vi.fn(async (path: string, files: Parameters<WorkspaceAPI['upload']>[1]) => {
      current = false;
      return {
        success: true,
        entries: [{
          name: files[0] instanceof File ? files[0].name : files[0].name,
          path: `/workspaces/${path}/paper.pdf`,
          relativePath: `${path}/paper.pdf`,
          type: 'file' as const,
          size: 8,
          modifiedAt: '2026-09-24T00:00:00.000Z',
          mtimeMs: 0,
        }],
      };
    });

    const result = await uploadPiComposerPdfFiles([makeFile('paper.pdf')], {
      documents: createDocuments(),
      isCurrentTarget: () => current,
      randomUUID: () => 'upload-456',
      target,
      workspaceApi: createWorkspace({ onUpload: upload }),
    });

    expect(result).toEqual({ status: 'stale', references: [], failures: [] });
    expect(upload).toHaveBeenCalledOnce();
  });

  test('does not start workspace reads for an already-stale target', async () => {
    const getRoot = vi.fn(async () => root);
    const resolveWorkspace = vi.fn(async () => ({
      epoch: 1,
      hostId: 'host-a',
      workspaceId: 'workspace-authority',
    }));
    const upload = vi.fn();

    const result = await uploadPiComposerPdfFiles([makeFile('paper.pdf')], {
      documents: createDocuments(resolveWorkspace),
      isCurrentTarget: () => false,
      randomUUID: () => 'upload-456',
      target,
      workspaceApi: { getRoot, upload },
    });

    expect(result).toEqual({ status: 'stale', references: [], failures: [] });
    expect(getRoot).not.toHaveBeenCalled();
    expect(resolveWorkspace).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  test('rejects PDF upload for a virtual WorkingState child session', async () => {
    const fetchThreads = vi.fn(async () => new Response(JSON.stringify({
      workspaceId: 'workspace-authority',
      parent: { kind: 'session', id: 'parent-session' },
      includeArchived: false,
      peers: [],
      threads: [{
        thread: {
          id: 'thread-1',
          workspaceId: 'workspace-authority',
          eventSeq: 1,
          kind: 'implementation',
          manifest: { tools: [], scope: [] },
          parent: { kind: 'session', id: 'parent-session' },
          worktree: { viewMode: 'virtual' },
        },
        activeRun: { id: 'run-1', sessionId: 'session-123' },
      }],
    }), { status: 200 }));
    const getRoot = vi.fn(async () => root);
    const upload = vi.fn();
    const result = await uploadPiComposerPdfFiles([makeFile('paper.pdf')], {
      documents: createDocuments(),
      isCurrentTarget: () => true,
      randomUUID: () => 'upload-456',
      target,
      workspaceApi: { getRoot, upload },
      isSessionUnsupported: async () => isPiComposerPdfUploadUnsupportedForSession({
        fetchThreads,
        parentSessionId: target.parentSessionId,
        sessionId: target.sessionId,
      }),
    });

    expect(result).toEqual({ status: 'unsupported', references: [], failures: [] });
    expect(fetchThreads).toHaveBeenCalledOnce();
    expect(getRoot).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  test('allows disk-backed child sessions and ordinary sessions without a parent', async () => {
    const makeFetch = (viewMode: string) => vi.fn(async () => new Response(JSON.stringify({
      workspaceId: 'workspace-authority',
      parent: { kind: 'session', id: 'parent-session' },
      includeArchived: false,
      peers: [],
      threads: [{
        thread: {
          id: 'thread-1',
          workspaceId: 'workspace-authority',
          eventSeq: 1,
          kind: 'implementation',
          manifest: { tools: [], scope: [] },
          parent: { kind: 'session', id: 'parent-session' },
          worktree: { viewMode },
        },
        activeRun: { id: 'run-1', sessionId: 'session-123' },
      }],
    }), { status: 200 }));

    expect(await isPiComposerPdfUploadUnsupportedForSession({
      fetchThreads: makeFetch('materialized'),
      parentSessionId: 'parent-session',
      sessionId: 'session-123',
    })).toBe(false);
    expect(await isPiComposerPdfUploadUnsupportedForSession({
      fetchThreads: makeFetch('virtual'),
      parentSessionId: null,
      sessionId: 'session-123',
    })).toBe(false);
  });

  test('normalizes path segments and rejects invalid path owners', () => {
    expect(getWorkspaceRelativeDirectory('/workspaces/', '/workspaces/project/', '/')).toBe('project');
    expect(safePiComposerAttachmentScope('thread/../id')).toBe('thread____id');
    expect(getPiComposerAttachmentBasename('C:\\Users\\Ada\\paper.pdf')).toBe('paper.pdf');
    expect(() => getPiComposerAttachmentBasename('..')).toThrow('PDF file name is invalid');
    expect(safePiComposerAttachmentScope('..')).toBe('__');
    expect(() => safePiComposerAttachmentScope('')).toThrow('Attachment scope is invalid');
  });

  test('treats a runtime or scope change as a different attachment target', () => {
    expect(isSamePiComposerAttachmentTarget(target, { ...target })).toBe(true);
    expect(isSamePiComposerAttachmentTarget(target, { ...target, runtimeKey: 'host-b' })).toBe(false);
    expect(isSamePiComposerAttachmentTarget(target, { ...target, sessionId: 'other-session' })).toBe(false);
    expect(isSamePiComposerAttachmentTarget(target, { ...target, cwd: '/workspaces/other' })).toBe(false);
  });
});
