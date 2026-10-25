import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { create as tarCreate } from 'tar';
import type { Express } from 'express';
import type { DocumentAuthority } from '../documents/authority.js';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';

let tempDir: string;
let workspaceRoot: string;

const gbkTestBytes = new Map<string, number[]>([
  ['中', [0xd6, 0xd0]],
  ['文', [0xce, 0xc4]],
  ['说', [0xcb, 0xb5]],
  ['明', [0xc3, 0xf7]],
]);

const encodeGbkTestFilename = (value: string): Buffer => {
  const bytes: number[] = [];
  for (const char of String(value || '')) {
    const code = char.charCodeAt(0);
    if (code <= 0x7f) {
      bytes.push(code);
      continue;
    }
    const mapped = gbkTestBytes.get(char);
    if (!mapped) {
      throw new Error(`Missing GBK test mapping for ${char}`);
    }
    bytes.push(...mapped);
  }
  return Buffer.from(bytes);
};

const gbkTestZipDecoder = {
  efs: false,
  encode: encodeGbkTestFilename,
  decode: (data: Uint8Array) => new TextDecoder('gbk').decode(data),
};

async function loadRoutesModule() {
  vi.resetModules();
  return import('./workspace-routes.js');
}

async function createApp(
  env: Record<string, string> = {},
  options: {
    documents?: DocumentAuthority | undefined;
    onGitStatus?: ((scope: string, status: unknown) => void | Promise<void>) | undefined;
  } = {},
): Promise<Express> {
  const { registerWorkspaceRoutes } = await loadRoutesModule();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerWorkspaceRoutes(app, {
    env: {
      VARIN_WORKSPACE_ROOT: workspaceRoot,
      VARIN_WORKSPACE_TRASH: 'true',
      VARIN_WORKSPACE_MAX_READ_MB: '1',
      ...env,
    },
    fsPromises: fs.promises,
    pathModule: path,
    osModule: os,
    readSettingsFromDisk: vi.fn(async () => ({ projects: [] })),
    persistSettings: vi.fn(async (changes) => ({ ...changes })),
    sanitizeProjects: () => [],
    documents: options.documents,
    onGitStatus: options.onGitStatus,
  });
  return app;
}

const binaryParser = (
  res: request.Response,
  callback: (error: Error | null, body: unknown) => void,
): void => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('workspace routes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-workspace-routes-'));
    workspaceRoot = path.join(tempDir, 'workspace');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and reports the workspace root when it does not exist', async () => {
    const app = await createApp();

    const response = await request(app)
      .get('/api/workspace/root')
      .expect(200);

    expect(fs.existsSync(workspaceRoot)).toBe(true);
    expect(response.body).toMatchObject({
      root: workspaceRoot,
      relativeRoot: '',
      limits: {
        maxReadBytes: 1024 * 1024,
        maxDownloadBytes: 12 * 1024 * 1024 * 1024,
        maxDownloadFiles: 0,
        maxArchiveBytes: 1024 * 1024 * 1024,
        maxExtractBytes: 3 * 1024 * 1024 * 1024,
        maxExtractFiles: 30000,
        archivePreviewLimit: 500,
      },
    });
  });

  it('publishes a successful workspace Git status snapshot', async () => {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
    fs.writeFileSync(path.join(workspaceRoot, 'note.txt'), 'changed\n');
    const onGitStatus = vi.fn();
    const app = await createApp({}, { onGitStatus });

    const response = await request(app)
      .get('/api/workspace/git/status')
      .query({ path: '.', mode: 'light' });
    await Promise.resolve();
    expect(response.status).toBe(200);
    expect(response.body.isGitRepository).toBe(true);
    expect(onGitStatus).toHaveBeenCalledWith(workspaceRoot, expect.objectContaining({ files: expect.any(Array) }));
  });

  it('creates folders, lists them as projects, and soft-deletes entries into trash', async () => {
    const app = await createApp();

    await request(app)
      .post('/api/workspace/folder')
      .send({ path: 'demo' })
      .expect(200);

    const list = await request(app)
      .get('/api/workspace/list')
      .expect(200);

    expect(list.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'demo',
        relativePath: 'demo',
        type: 'directory',
        isProject: true,
      }),
    ]));

    const deleted = await request(app)
      .delete('/api/workspace/entry')
      .send({ path: 'demo' })
      .expect(200);

    expect(deleted.body).toMatchObject({ success: true, trashed: true });
    expect(fs.existsSync(path.join(workspaceRoot, 'demo'))).toBe(false);
    expect(fs.existsSync(deleted.body.trashPath)).toBe(true);
    expect(deleted.body.trashPath.startsWith(path.join(workspaceRoot, '.trash'))).toBe(true);
  });

  it('records workspace API mutations and refuses new files during maintenance', async () => {
    const harness = await createDocumentAuthorityHarness();
    workspaceRoot = harness.workspaceRoot;
    try {
      const runMutationForScope = vi.spyOn(harness.authority, 'runMutationForScope');
      const app = await createApp({}, { documents: harness.authority });
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);

      await request(app)
        .post('/api/workspace/file')
        .send({ path: 'tracked.txt', content: 'tracked' })
        .expect(200);
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      expect(after.mutationRevision).toBeGreaterThan(before.mutationRevision);
      expect(runMutationForScope).toHaveBeenCalledWith(
        workspaceRoot,
        { kind: 'web-route', id: 'workspace.file' },
        expect.any(Function),
        expect.objectContaining({
          resourceOperations: [{ resourceId: '', scope: 'subtree' }],
        }),
      );

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      await request(app)
        .post('/api/workspace/file')
        .send({ path: 'late.txt', content: 'late' })
        .expect(409);
      expect(fs.existsSync(path.join(workspaceRoot, 'late.txt'))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it('lists an empty trash directory explicitly while keeping it hidden from root', async () => {
    const app = await createApp();

    const rootList = await request(app)
      .get('/api/workspace/list')
      .expect(200);
    expect(rootList.body.entries.map((entry: { name: string }) => entry.name)).not.toContain('.trash');

    const trashList = await request(app)
      .get('/api/workspace/list')
      .query({ path: '.trash' })
      .expect(200);

    expect(trashList.body).toMatchObject({
      relativePath: '.trash',
      entries: [],
    });
    expect(fs.existsSync(path.join(workspaceRoot, '.trash'))).toBe(true);
  });

  it('uploads zip archives through multipart without extracting them', async () => {
    const app = await createApp();
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('hello'));

    const upload = await request(app)
      .post('/api/workspace/upload')
      .field('path', 'demo')
      .attach('files', zip.toBuffer(), 'demo.zip')
      .expect(200);

    expect(upload.body.entries).toEqual([
      expect.objectContaining({
        name: 'demo.zip',
        relativePath: 'demo/demo.zip',
        type: 'file',
      }),
    ]);
    expect(fs.existsSync(path.join(workspaceRoot, 'demo', 'demo.zip'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'demo', 'README.md'))).toBe(false);
  });

  it('preserves UTF-8 multipart archive names and bytes', async () => {
    const app = await createApp();
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('hello'));
    const archiveBytes = zip.toBuffer();

    const upload = await request(app)
      .post('/api/workspace/upload')
      .field('path', 'demo')
      .attach('files', archiveBytes, '中文压缩包.zip')
      .expect(200);

    expect(upload.body.entries).toEqual([
      expect.objectContaining({
        name: '中文压缩包.zip',
        relativePath: 'demo/中文压缩包.zip',
        type: 'file',
      }),
    ]);
    expect(fs.readFileSync(path.join(workspaceRoot, 'demo', '中文压缩包.zip'))).toEqual(archiveBytes);
  });

  it('does not rewrite already-correct multipart names that look like mojibake', async () => {
    const app = await createApp();
    const content = Buffer.from('literal name');

    const upload = await request(app)
      .post('/api/workspace/upload')
      .field('path', 'demo')
      .attach('files', content, 'Ã©.txt')
      .expect(200);

    expect(upload.body.entries).toEqual([
      expect.objectContaining({
        name: 'Ã©.txt',
        relativePath: 'demo/Ã©.txt',
      }),
    ]);
    expect(fs.readFileSync(path.join(workspaceRoot, 'demo', 'Ã©.txt'))).toEqual(content);
  });

  it('downloads individual workspace files directly', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'note.txt'), 'hello download');

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: 'demo/note.txt' })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('note.txt');
    expect(response.body.toString('utf8')).toBe('hello download');
  });

  it('downloads workspace folders as zip archives with a top-level directory', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo', 'src'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'demo', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'README.md'), 'hello');
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'src', 'index.ts'), 'export {};');

    const check = await request(app)
      .get('/api/workspace/download/check')
      .query({ path: 'demo' })
      .expect(200);

    expect(check.body).toEqual({ type: 'archive', fileName: 'demo.zip' });

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: 'demo' })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('demo.zip');

    const zip = new AdmZip(response.body);
    expect(zip.getEntry('demo/')).toBeTruthy();
    expect(zip.getEntry('demo/empty/')).toBeTruthy();
    expect(zip.getEntry('demo/README.md')?.getData().toString('utf8')).toBe('hello');
    expect(zip.getEntry('demo/src/index.ts')?.getData().toString('utf8')).toBe('export {};');
  });

  it('downloads dotfiles directly instead of treating them as not found', async () => {
    const app = await createApp();
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.env'), 'TOKEN=secret');

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: '.env' })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('.env');
    expect(response.body.toString('utf8')).toBe('TOKEN=secret');
  });

  it('downloads dot-directories as zip archives instead of treating the temp zip as not found', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, '.config'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.config', 'settings.json'), '{}');

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: '.config' })
      .buffer(true)
      .parse(binaryParser)
      .expect(200);

    expect(response.headers['content-disposition']).toContain('.config.zip');

    const zip = new AdmZip(response.body);
    expect(zip.getEntry('.config/')).toBeTruthy();
    expect(zip.getEntry('.config/settings.json')?.getData().toString('utf8')).toBe('{}');
  });

  it('rejects folder downloads that exceed download limits', async () => {
    const app = await createApp({ VARIN_WORKSPACE_MAX_DOWNLOAD_MB: '0.0001' });
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'big.txt'), 'x'.repeat(1024));

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: 'demo' })
      .expect(413);

    expect(response.body.error).toMatch(/too large/i);
  });

  it('only applies folder download file-count limits when explicitly configured', async () => {
    const app = await createApp({ VARIN_WORKSPACE_MAX_DOWNLOAD_FILES: '2' });
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'a.txt'), 'a');
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'b.txt'), 'b');
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'c.txt'), 'c');

    const response = await request(app)
      .get('/api/workspace/download')
      .query({ path: 'demo' })
      .expect(413);

    expect(response.body.error).toMatch(/too many files/i);
  });

  it('previews and extracts zip archives into new folders with rename conflicts', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('hello'));
    zip.addFile('src/index.ts', Buffer.from('export {};'));
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'demo.zip'), zip.toBuffer());

    const preview = await request(app)
      .get('/api/workspace/archive/preview')
      .query({ path: 'demo/demo.zip' })
      .expect(200);

    expect(preview.body).toMatchObject({
      format: 'zip',
      totalFiles: 2,
      totalDirectories: 0,
      totalBytes: 15,
      truncated: false,
    });
    expect(preview.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['README.md', 'src/index.ts']);

    const firstExtract = await request(app)
      .post('/api/workspace/archive/extract')
      .send({
        path: 'demo/demo.zip',
        destination: 'demo/demo',
        mode: 'new-folder',
        conflict: 'rename',
      })
      .expect(200);

    expect(firstExtract.body).toMatchObject({
      success: true,
      destination: 'demo/demo',
      filesCreated: 2,
      conflictsRenamed: 0,
    });
    expect(fs.readFileSync(path.join(workspaceRoot, 'demo', 'demo', 'README.md'), 'utf8')).toBe('hello');

    const secondExtract = await request(app)
      .post('/api/workspace/archive/extract')
      .send({
        path: 'demo/demo.zip',
        destination: 'demo/demo',
        mode: 'new-folder',
        conflict: 'rename',
      })
      .expect(200);

    expect(secondExtract.body).toMatchObject({
      destination: 'demo/demo (1)',
      conflictsRenamed: 1,
    });
    expect(fs.existsSync(path.join(workspaceRoot, 'demo', 'demo (1)', 'src', 'index.ts'))).toBe(true);
  });

  it('previews and extracts legacy GBK zip entry names without changing file bytes', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    const zip = new AdmZip({ decoder: gbkTestZipDecoder });
    const fileBytes = Buffer.from([0x00, 0xff, 0xe4, 0xb8, 0xad]);
    zip.addFile('中文/说明.txt', fileBytes);
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'legacy-gbk.zip'), zip.toBuffer());

    const preview = await request(app)
      .get('/api/workspace/archive/preview')
      .query({ path: 'demo/legacy-gbk.zip' })
      .expect(200);

    expect(preview.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['中文/说明.txt']);

    await request(app)
      .post('/api/workspace/archive/extract')
      .send({
        path: 'demo/legacy-gbk.zip',
        destination: 'demo/legacy-gbk',
        mode: 'new-folder',
        conflict: 'rename',
      })
      .expect(200);

    expect(fs.readFileSync(path.join(workspaceRoot, 'demo', 'legacy-gbk', '中文', '说明.txt'))).toEqual(fileBytes);
  });

  it('keeps valid UTF-8 zip entry names with literal replacement characters', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('�中文.txt', Buffer.from('ok'));
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'utf8-replacement.zip'), zip.toBuffer());

    const preview = await request(app)
      .get('/api/workspace/archive/preview')
      .query({ path: 'demo/utf8-replacement.zip' })
      .expect(200);

    expect(preview.body.entries.map((entry: { path: string }) => entry.path)).toEqual(['�中文.txt']);
  });

  it('extracts tar.gz archives and can delete the source archive after success', async () => {
    const app = await createApp();
    const sourceDir = path.join(tempDir, 'tar-source');
    fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'src', 'main.ts'), 'console.log("ok");');
    fs.mkdirSync(path.join(workspaceRoot, 'archives'), { recursive: true });
    const archivePath = path.join(workspaceRoot, 'archives', 'code.tgz');
    await tarCreate({ gzip: true, file: archivePath, cwd: sourceDir }, ['src']);

    const preview = await request(app)
      .get('/api/workspace/archive/preview')
      .query({ path: 'archives/code.tgz' })
      .expect(200);

    expect(preview.body.format).toBe('tgz');
    expect(preview.body.entries.map((entry: { path: string }) => entry.path)).toContain('src/main.ts');

    await request(app)
      .post('/api/workspace/archive/extract')
      .send({
        path: 'archives/code.tgz',
        destination: 'archives/code',
        mode: 'new-folder',
        conflict: 'rename',
        deleteArchive: true,
      })
      .expect(200);

    expect(fs.existsSync(archivePath)).toBe(false);
    expect(fs.readFileSync(path.join(workspaceRoot, 'archives', 'code', 'src', 'main.ts'), 'utf8')).toBe('console.log("ok");');
  });

  it('rejects archive entries that try to escape the workspace', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo'), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('C:/evil.txt', Buffer.from('nope'));
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'evil.zip'), zip.toBuffer());

    const response = await request(app)
      .get('/api/workspace/archive/preview')
      .query({ path: 'demo/evil.zip' })
      .expect(400);

    expect(response.body.error).toMatch(/outside workspace|relative|empty|NUL|path/i);
    expect(fs.existsSync(path.join(workspaceRoot, 'evil.txt'))).toBe(false);
  });

  it('honors extraction conflict errors without writing final files', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'demo', 'target'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'target', 'README.md'), 'existing');
    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('new'));
    fs.writeFileSync(path.join(workspaceRoot, 'demo', 'demo.zip'), zip.toBuffer());

    const response = await request(app)
      .post('/api/workspace/archive/extract')
      .send({
        path: 'demo/demo.zip',
        destination: 'demo/target',
        mode: 'merge',
        conflict: 'error',
      })
      .expect(409);

    expect(response.body.error).toMatch(/destination/i);
    expect(fs.readFileSync(path.join(workspaceRoot, 'demo', 'target', 'README.md'), 'utf8')).toBe('existing');
    const leftovers = fs.readdirSync(workspaceRoot).filter((name) => name.startsWith('.extracting-'));
    expect(leftovers).toEqual([]);
  });

  it('clones a repository into the selected workspace directory', async () => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      return;
    }

    const app = await createApp();
    const remotePath = path.join(tempDir, 'remote.git');
    execFileSync('git', ['init', '--bare', remotePath], { stdio: 'ignore' });
    fs.mkdirSync(path.join(workspaceRoot, 'projects'), { recursive: true });

    await request(app)
      .post('/api/workspace/git/clone')
      .send({
        path: 'projects',
        url: remotePath,
        directoryName: 'copy',
      })
      .expect(200);

    expect(fs.existsSync(path.join(workspaceRoot, 'projects', 'copy', '.git'))).toBe(true);

    const list = await request(app)
      .get('/api/workspace/list')
      .query({ path: 'projects' })
      .expect(200);

    expect(list.body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'copy',
        relativePath: 'projects/copy',
        type: 'directory',
      }),
    ]));
  });

  it('rejects clone destination folders that escape the current directory', async () => {
    const app = await createApp();
    fs.mkdirSync(path.join(workspaceRoot, 'projects'), { recursive: true });

    const response = await request(app)
      .post('/api/workspace/git/clone')
      .send({
        path: 'projects',
        url: 'https://example.com/repo.git',
        directoryName: '../outside',
      })
      .expect(400);

    expect(response.body.error).toMatch(/simple folder name/i);
    expect(fs.existsSync(path.join(workspaceRoot, 'outside'))).toBe(false);
  });
});
