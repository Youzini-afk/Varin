import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readlink, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createAgentResourceAuthority, type AdmittedAgentResourceScope, type PreparedAgentResources } from './authority.js';
import { createAdmittedDirectoryReader, createCapsuleResourceReader, createDocumentResourceReader, createPinnedResourceReader,
  contentVersion, resourceFailure, type CapturedResource, type ResourceReader } from './source-reader.js';
import { CONTEXT_FILE_NAMES, parseSkill } from './formats.js';
import { packageDelta, resourceEnabled } from './configuration.js';
import { resourceSections } from './render.js';
import { openRecoveryJournalCatalog } from '../recovery/journal-catalog.js';
import { createRecoveryFileStore } from '../recovery/file-store.test-helper.js';
import { WorkingStateStore } from '../harness/working-state/working-state-store.js';
import { asTestWorkingStateRootStore } from '../harness/working-state/working-state-root-adapter.test-helper.js';

const roots: string[] = [];
const authority = createAgentResourceAuthority();
const skill = (name: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n${body}\n`;
const scope = (extra: Partial<AdmittedAgentResourceScope> = {}): AdmittedAgentResourceScope => ({
  threadId: 'thread', branchId: 'branch', mode: 'agent', threadRole: 'main', projectId: 'project', sourceIdentity: 'source-v1', projectTrusted: true, ...extra,
});
async function fixture(files: Record<string, string | Uint8Array>, name = 'resources') {
  const root = await mkdtemp(path.join(os.tmpdir(), `varin-${name}-`)); roots.push(root);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  const reader = await createAdmittedDirectoryReader({ domainId: name, viewId: `${name}-v1`, root });
  return { root, reader, domain: { reader, displayRoot: root } };
}
function platformReader(reader: ResourceReader, root: string, platform: 'posix' | 'win32'): ResourceReader {
  if (platform === 'posix') return reader;
  // Use actual filesystem reads; substitute only the canonical file identity emitted on Windows.
  const canonicalId = (identity: string) => `file:${path.win32.join('C:\\resources', path.relative(root, identity.slice(5)))}`;
  return { ...reader,
    read: async (target, signal) => {
      const result = await reader.read(target, signal);
      return result.status === 'ready' ? { ...result, reference: { ...result.reference, canonicalId: canonicalId(result.reference.canonicalId) } } : result;
    },
    list: async (target, signal) => {
      const result = await reader.list(target, signal);
      return result.status === 'ready' ? { ...result, reference: { ...result.reference, canonicalId: canonicalId(result.reference.canonicalId) } } : result;
    },
  };
}
async function prepared(input: AdmittedAgentResourceScope): Promise<PreparedAgentResources> {
  const result = await authority.prepare(input);
  if (result.status !== 'ready') throw new Error(`${result.status}: ${result.reason} (${result.path})`);
  return result.snapshot;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Agent resource owner', () => {
  it('selects exact SYSTEM/APPEND and context aliases, preserves empty, and renders only progressive skill metadata', async () => {
    const user = await fixture({ 'SYSTEM.md': 'user system', 'APPEND_SYSTEM.md': 'user append', 'AGENTS.md': 'user context',
      'skills/quiet/SKILL.md': skill('quiet', 'QUIET SECRET BODY', 'disable-model-invocation: true\n'),
      'skills/review/SKILL.md': skill('review', 'REVIEW SECRET BODY') }, 'user');
    const project = await fixture({ '.pi/SYSTEM.md': '', '.pi/APPEND_SYSTEM.md': 'project append', 'AGENTS.md': 'ordinary root',
      'AGENTS.override.md': 'overriding root', 'src/AGENTS.MD': 'source directory', 'sibling/AGENTS.md': 'SIBLING' }, 'project');
    const snapshot = await prepared(scope({ user: user.domain, project: { ...project.domain, cwd: '' }, instructionDirectories: ['src'] }));
    expect(snapshot.system?.origin).toBe('project');
    const rendered = resourceSections(snapshot, 'runtime', 'resource_read');
    expect(rendered.preamble).toBe('runtime');
    expect(rendered.append_system).toBe('project append');
    expect(rendered.workspace_instructions).toContain('user context');
    expect(rendered.workspace_instructions).toContain('overriding root');
    expect(rendered.workspace_instructions).not.toContain('ordinary root');
    expect(rendered.workspace_instructions).not.toContain('SIBLING');
    expect(rendered.skills).toContain('review description');
    expect(rendered.skills).not.toMatch(/SECRET BODY|quiet description/);
    expect(snapshot.skills.some(item => item.name === 'quiet')).toBe(true);
    const nested = await authority.read({ snapshot, readers: [] }, { kind: 'instruction-scope', targetPath: 'src/file.ts' });
    expect(nested.status === 'ready' && nested.kind === 'instruction-scope' && nested.instructions.map(item => item.content)).toEqual(['user context', 'overriding root', 'source directory']);
    const quiet = snapshot.skills.find(item => item.name === 'quiet')!;
    const body = await authority.read({ snapshot, readers: [] }, { kind: 'skill', resourceId: quiet.id });
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('QUIET SECRET BODY');
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('uses project explicit, project auto, user explicit, user auto, then package name priority with real settings and assets', async () => {
    const user = await fixture({ 'settings.json': JSON.stringify({ skills: ['configured'], packages: ['pkg'] }),
      'configured/SKILL.md': skill('shared', 'USER EXPLICIT'), 'skills/auto/SKILL.md': skill('shared', 'USER AUTO'),
      'skills/user-wins/SKILL.md': skill('user-wins', 'USER BEATS PACKAGE') }, 'user');
    const project = await fixture({ '.pi/settings.json': JSON.stringify({ skills: ['explicit'] }),
      '.pi/explicit/SKILL.md': skill('shared', 'PROJECT EXPLICIT'), '.pi/skills/auto/SKILL.md': skill('shared', 'PROJECT AUTO'),
      '.pi/skills/project-wins/SKILL.md': skill('project-wins', 'PROJECT AUTO BEATS USER'),
      '.agents/skills/from-agent/SKILL.md': skill('agent-root', 'AGENTS ROOT') }, 'project');
    const pkg = await fixture({ 'package.json': JSON.stringify({ pi: { skills: ['skills'] } }),
      'skills/pkg/SKILL.md': skill('shared', 'PACKAGE'), 'skills/user-wins/SKILL.md': skill('user-wins', 'PACKAGE LOSES') }, 'pkg');
    const snapshot = await prepared(scope({ user: user.domain, project: { ...project.domain, cwd: '' },
      installedPackages: [{ ...pkg.domain, identity: 'pkg', source: 'pkg', scope: 'user' }] }));
    expect(snapshot.skills.find(item => item.name === 'shared')?.priority).toBe(0);
    const selected = snapshot.skills.find(item => item.name === 'shared')!;
    const body = await authority.read({ snapshot, readers: [] }, { kind: 'skill', resourceId: selected.id });
    expect(body.status === 'ready' && body.kind === 'skill' && body.file.content).toContain('PROJECT EXPLICIT');
    expect(snapshot.skills.find(item => item.name === 'user-wins')?.origin).toBe('user');
    expect(snapshot.skills.some(item => item.name === 'agent-root')).toBe(true);
    expect(snapshot.diagnostics.filter(item => item.kind === 'collision').length).toBeGreaterThanOrEqual(3);
  });

  it('does not read untrusted project settings/system/skills and does not silently turn malformed settings into defaults', async () => {
    const project = await fixture({ '.pi/settings.json': '{ broken', '.pi/SYSTEM.md': 'untrusted', 'AGENTS.md': 'admitted directory guidance' }, 'project');
    const user = await fixture({ 'SYSTEM.md': 'user system' }, 'user');
    const read = vi.fn(project.reader.read.bind(project.reader));
    const snapshot = await prepared(scope({ user: user.domain, projectTrusted: false, project: { reader: { ...project.reader, read }, cwd: '' } }));
    expect(snapshot.system?.origin).toBe('user');
    expect(read.mock.calls.every(([target]) => !target.startsWith('.pi/'))).toBe(true);
    expect(await authority.prepare(scope({ project: { ...project.domain, cwd: '' } }))).toMatchObject({ status: 'invalid', path: '.pi/settings.json' });
  });

  it.each(['posix', 'win32'] as const)('retains old captured skill bytes and bundle support files with %s file identities', async platform => {
    const user = await fixture({ 'skills/review/SKILL.md': skill('review', 'ORIGINAL'), 'skills/review/reference.txt': 'REFERENCE' }, 'user');
    const reader = platformReader(user.reader, user.root, platform);
    const domain = { ...user.domain, reader };
    const initial = await prepared(scope({ user: domain, supportingFiles: [{ skillName: 'review', relativePath: 'reference.txt' }] }));
    const descriptor = initial.skills[0]!;
    await writeFile(path.join(user.root, 'skills/review/SKILL.md'), skill('review', 'LATER'));
    await writeFile(path.join(user.root, 'skills/review/reference.txt'), 'LATER REFERENCE');
    const old = await authority.read({ snapshot: initial, readers: [reader] }, { kind: 'skill', resourceId: descriptor.id });
    expect(old.status === 'ready' && old.kind === 'skill' && old.file.content).toContain('ORIGINAL');
    const reference = await authority.read({ snapshot: initial, readers: [reader] }, { kind: 'skill-resource', resourceId: descriptor.id, relativePath: 'reference.txt' });
    expect(reference.status === 'ready' && reference.kind === 'skill-resource' && reference.file.content).toBe('REFERENCE');
    expect(await authority.read({ snapshot: initial, readers: [reader] }, { kind: 'skill-resource', resourceId: descriptor.id, relativePath: 'uncaptured.txt' })).toMatchObject({ status: 'unavailable', path: 'skills/review/uncaptured.txt' });
    const next = await prepared(scope({ user: domain }));
    expect(next.id).not.toBe(initial.id);
    expect(next.skills[0]?.id).toBe(descriptor.id);
    expect(next.skills[0]?.reference.version).not.toBe(descriptor.reference.version);
  });

  it.each(['posix', 'win32'] as const)('rejects uncaptured paths, escapes and symlinked bundle exits with %s file identities', async platform => {
    const project = await fixture({ 'AGENTS.md': 'root', 'src/AGENTS.md': 'nested' }, 'project');
    const user = await fixture({ 'skills/review/SKILL.md': skill('review', 'Read ../../auth.json'), 'auth.json': 'private' }, 'user');
    const reader = platformReader(user.reader, user.root, platform);
    const domain = { ...user.domain, reader };
    await symlink(path.join(user.root, 'auth.json'), path.join(user.root, 'skills/review/link.txt'));
    const snapshot = await prepared(scope({ user: domain, project: { ...project.domain, cwd: '' } }));
    const id = snapshot.skills[0]!.id;
    for (const target of ['../auth.json', '/tmp/private', 'C:\\private']) {
      expect(await authority.read({ snapshot, readers: [reader] }, { kind: 'skill-resource', resourceId: id, relativePath: target })).toMatchObject({ status: 'denied' });
    }
    expect(await authority.read({ snapshot, readers: [project.reader] }, { kind: 'instruction-scope', targetPath: 'src/a.ts' })).toMatchObject({ status: 'unavailable', path: 'src/AGENTS.override.md' });
    expect(await authority.prepare(scope({ user: domain, supportingFiles: [{ skillName: 'review', relativePath: 'link.txt' }] }))).toMatchObject({ status: 'denied' });
    const outside = await fixture({ 'outside.txt': 'outside' }, 'outside');
    await symlink(outside.root, path.join(user.root, 'skills/review/outside'));
    expect(await user.reader.read('skills/review/outside/outside.txt')).toMatchObject({ status: 'denied' });
  });

  it('retains ignore-file discovery, .agents markdown mode, malformed YAML and warning-only metadata rules', async () => {
    const user = await fixture({ 'skills/.gitignore': 'ignored/\n', 'skills/ignored/SKILL.md': skill('ignored', 'ignored'),
      'skills/declared/SKILL.md': skill('Bad_Name', 'kept'), 'skills/broken/SKILL.md': '---\nname: [\n---\nbody',
      'skills/empty/SKILL.md': '---\nname: missing\n---\nbody', 'skills/readme.md': '# just a note',
      'skills/declared/child/SKILL.md': skill('not-discovered', 'hidden by root SKILL') }, 'user');
    const home = await fixture({ 'skills/top.md': skill('top', 'excluded agents root markdown'),
      'skills/group/extra.md': skill('group-extra', 'included nested agents markdown') }, 'home-agents');
    const snapshot = await prepared(scope({ user: user.domain, userAgents: home.domain }));
    expect(snapshot.skills.map(item => item.name)).toEqual(['Bad_Name', 'group-extra']);
    expect(snapshot.diagnostics.some(item => item.kind === 'warning')).toBe(true);
    expect(snapshot.diagnostics.some(item => item.kind === 'invalid' && item.message.includes('YAML'))).toBe(true);
    expect(snapshot.diagnostics.some(item => item.kind === 'invalid' && item.message.includes('description'))).toBe(true);
    const parsed = parseSkill('\uFEFF---\r\nname: multiline\r\ndescription: |\r\n  first line\r\n  second line\r\nallowed-tools: [shell]\r\n---\r\nbody\r\n', 'multiline/SKILL.md');
    expect(parsed.metadata?.description).toBe('first line\nsecond line\n');
    expect(parsed.body).toBe('body');
    expect(parsed.metadata).not.toHaveProperty('allowed-tools');
  });

  it('distinguishes file failures and cancellation while unrelated preparation can progress', async () => {
    const files = await fixture({ 'empty.md': '', 'invalid.md': new Uint8Array([0xff, 0xfe, 0xff]) }, 'failures');
    expect(await files.reader.read('empty.md')).toMatchObject({ status: 'ready', content: '' });
    expect(await files.reader.read('missing.md')).toMatchObject({ status: 'missing' });
    expect(await files.reader.read('invalid.md')).toMatchObject({ status: 'invalid' });
    const controller = new AbortController(); let release!: () => void;
    const blocking: ResourceReader = { ...files.reader, read: async (target, signal) => {
      if (target === 'settings.json') { await new Promise<void>(resolve => { release = resolve; }); }
      return signal?.aborted ? resourceFailure(files.reader, target, 'cancelled', 'cancelled') : files.reader.read(target, signal);
    } };
    const slow = authority.prepare(scope({ user: { reader: blocking } }), controller.signal);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const fast = await authority.prepare(scope({ threadId: 'other', skillsEnabled: false }));
    expect(fast.status).toBe('ready');
    controller.abort(); release();
    expect(await slow).toMatchObject({ status: 'cancelled' });
    const denied: ResourceReader = { ...files.reader, read: async target => resourceFailure(files.reader, target, 'denied', 'not admitted') };
    expect(await authority.prepare(scope({ user: { reader: denied } }))).toMatchObject({ status: 'denied' });
  });

  it('reports an unavailable or replaced admitted root instead of turning it into missing content', async () => {
    const user = await fixture({ 'AGENTS.md': 'original' }, 'root-identity');
    const moved = `${user.root}-moved`; roots.push(moved);
    await rename(user.root, moved);
    expect(await user.reader.read('AGENTS.md')).toMatchObject({ status: 'unavailable' });
    await mkdir(user.root);
    await writeFile(path.join(user.root, 'AGENTS.md'), 'replacement');
    expect(await user.reader.read('AGENTS.md')).toMatchObject({ status: 'stale' });
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO instruction without opening a blocking reader or waiting for a writer', async () => {
    const user = await fixture({}, 'fifo');
    execFileSync('mkfifo', [path.join(user.root, 'SYSTEM.md')]);
    expect(await user.reader.read('SYSTEM.md')).toMatchObject({ status: 'invalid' });
    expect(await authority.prepare(scope({ user: user.domain }))).toMatchObject({ status: 'invalid', path: 'SYSTEM.md' });
    const controller = new AbortController();
    controller.abort();
    expect(await user.reader.read('SYSTEM.md', controller.signal)).toMatchObject({ status: 'cancelled' });
  });

  it('preserves package [] disable, plain/include/!/+/- filtering and project autoload:false deltas', async () => {
    const file = { path: 'skills/review/SKILL.md', base: '' };
    expect(resourceEnabled(file, ['!**', '+skills/review'])).toBe(true);
    expect(resourceEnabled(file, ['+skills/review', '!**', '-skills/review'])).toBe(false);
    expect(resourceEnabled(file, [])).toBe(true);
    expect(resourceEnabled(file, [], { emptyDisables: true })).toBe(false);
    expect(packageDelta(file, ['-skills/review', '+skills/review'])).toBe(true);
    expect(packageDelta(file, [])).toBeUndefined();
    const user = await fixture({ 'settings.json': JSON.stringify({ packages: [{ source: 'p', skills: [] }, 'q', { source: 'empty-default' }, { source: 'empty-overridden', skills: ['skills/override'] }] }) }, 'user');
    const project = await fixture({ '.pi/settings.json': JSON.stringify({ packages: [{ source: 'q', autoload: false, skills: ['-skills/review'] }] }) }, 'project');
    const p = await fixture({ 'package.json': JSON.stringify({ pi: { skills: ['skills'] } }), 'skills/p/SKILL.md': skill('p', 'disabled') }, 'package-p');
    const q = await fixture({ 'package.json': JSON.stringify({ pi: { skills: ['skills'] } }), 'skills/review/SKILL.md': skill('review', 'disabled delta'),
      'skills/keep/SKILL.md': skill('keep', 'inherited') }, 'package-q');
    const empty = await fixture({ 'package.json': JSON.stringify({ pi: { skills: [] } }),
      'skills/override/SKILL.md': skill('override', 'only an explicit settings filter may enable this') }, 'package-empty');
    const snapshot = await prepared(scope({ user: user.domain, project: { ...project.domain, cwd: '' }, installedPackages: [
      { ...empty.domain, identity: 'empty-default', source: 'empty-default', scope: 'user' },
      { ...empty.domain, identity: 'empty-overridden', source: 'empty-overridden', scope: 'user' },
      { ...p.domain, identity: 'p', source: 'p', scope: 'user' }, { ...q.domain, identity: 'q', source: 'q', scope: 'project' },
      { ...q.domain, identity: 'q', source: 'q', scope: 'user' },
    ] }));
    expect(snapshot.skills.map(item => item.name)).toEqual(['keep', 'override']);
    expect(snapshot.skills.find(item => item.name === 'override')?.packageIdentity).toBe('empty-overridden');
    expect(snapshot.diagnostics.filter(item => item.kind === 'disabled')).toHaveLength(2);
  });

  it('applies settings glob includes without treating them as source paths, and expands package manifest globs', async () => {
    const user = await fixture({ 'settings.json': JSON.stringify({ skills: ['configured', '*selected*'], packages: ['p'] }),
      'configured/selected/SKILL.md': skill('selected', 'selected'), 'configured/other/SKILL.md': skill('other', 'excluded'),
      'skills/default/SKILL.md': skill('default', 'auto unaffected by plain includes') }, 'user');
    const pkg = await fixture({ 'package.json': JSON.stringify({ pi: { skills: ['custom/**/*.md'] } }),
      'custom/nested/deeper/note.md': skill('globbed', 'globbed'), 'custom/.hidden/note.md': skill('hidden', 'hidden') }, 'package');
    const snapshot = await prepared(scope({ user: user.domain, installedPackages: [{ ...pkg.domain, identity: 'p', source: 'p', scope: 'user' }] }));
    expect(snapshot.skills.map(item => item.name)).toEqual(['selected', 'default', 'globbed']);
    expect(snapshot.diagnostics.some(item => item.location.path.includes('*'))).toBe(false);
  });

  it('requires explicit frozen ancestor capsules and reports uncaptured external configuration rather than live fallback', async () => {
    const project = await fixture({ '.pi/settings.json': JSON.stringify({ skills: ['../../external'] }) }, 'project');
    const absent = CONTEXT_FILE_NAMES.filter(name => name !== 'AGENTS.md');
    const file: CapturedResource = { reference: { domainId: 'ancestor', viewId: 'captured-v1', path: 'AGENTS.md', canonicalId: 'original:/ancestor/AGENTS.md', version: contentVersion('ancestor original') }, content: 'ancestor original' };
    const outerPath = '.agents/skills/outer/SKILL.md';
    const outerContent = skill('outer', 'CAPTURED ANCESTOR SKILL');
    const outerFile: CapturedResource = { reference: { domainId: 'ancestor', viewId: 'captured-v1', path: outerPath,
      canonicalId: 'resource:ancestor/.agents/skills/outer/SKILL.md', version: contentVersion(outerContent) }, content: outerContent };
    const skillsCapsule = createCapsuleResourceReader({ domainId: 'ancestor', viewId: 'captured-v1', files: [file, outerFile],
      directories: [
        { path: '.agents/skills', entries: [{ name: 'outer', kind: 'directory' }], version: 'tree-v1' },
        { path: '.agents/skills/outer', entries: [{ name: 'SKILL.md', kind: 'file' }], version: 'tree-v1' },
      ], missing: [...absent, ...['.agents/skills', '.agents/skills/outer'].flatMap(dir => ['.gitignore', '.ignore', '.fdignore'].map(name => `${dir}/${name}`))] });
    const snapshot = await prepared(scope({ project: { ...project.domain, cwd: '' }, ancestors: [{ reader: skillsCapsule, appliesTo: '', includeSkills: true }] }));
    expect(snapshot.skills.map(item => item.name)).toEqual(['outer']);

    expect(resourceSections(snapshot, 'runtime', 'resource_read').workspace_instructions).toContain('ancestor original');
    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ kind: 'read', status: 'denied', location: expect.objectContaining({ path: '../../external' }) }));
    expect(await authority.prepare(scope({ ancestors: [{ reader: project.reader, appliesTo: '' }] }))).toMatchObject({ status: 'unavailable' });
    const empty = createCapsuleResourceReader({ domainId: 'old', viewId: 'old-v1', files: [], directories: [] });
    expect(await authority.prepare(scope({ ancestors: [{ reader: empty, appliesTo: '' }] }))).toMatchObject({ status: 'unavailable', path: 'AGENTS.override.md' });
  });

  it('uses the existing pinned WorkingState API after live files change, and never treats uncovered Git absence as missing', async () => {
    const project = await fixture({ '.pi/settings.json': '{}', '.pi/SYSTEM.md': 'fixed system', 'AGENTS.md': 'fixed root',
      'src/AGENTS.md': 'fixed nested', '.pi/skills/review/SKILL.md': skill('review', 'FIXED SKILL'), '.pi/skills/review/reference.txt': 'FIXED REFERENCE' }, 'project');
    await symlink('.pi/skills/review', path.join(project.root, 'linked-skill'));
    await symlink('../.pi/skills/review/reference.txt', path.join(project.root, 'src/linked-reference'));
    await symlink('cycle-b', path.join(project.root, 'cycle-a'));
    await symlink('cycle-a', path.join(project.root, 'cycle-b'));
    await symlink('.', path.join(project.root, 'self'));
    await symlink('/external/not-in-pin', path.join(project.root, 'external'));
    const recovery = path.join(project.root, 'store-outside-source');
    const database = await openRecoveryJournalCatalog(recovery, { create: true });
    if (!database) throw new Error('Test catalog unavailable');
    const context = { root: recovery, database, fileStore: createRecoveryFileStore(),
      identity: { authorityId: 'test', canonicalRoot: project.root, filesystemProfile: 'test', workspaceId: 'workspace' },
      resourceOperationGate: { run: async <T>(_resources: readonly unknown[], operation: () => Promise<T>) => operation() } };
    const store = await WorkingStateStore.open(context);
    const adapter = asTestWorkingStateRootStore(store, context);
    try {
      const paths = ['.pi', '.pi/settings.json', '.pi/SYSTEM.md', 'AGENTS.md', 'src', 'src/AGENTS.md', '.pi/skills', '.pi/skills/review', '.pi/skills/review/SKILL.md', '.pi/skills/review/reference.txt'];
      const states = await store.captureDirectory(project.root, paths);
      // The legacy file fixture follows realpath even for a leaf link; production capture preserves it.
      // Read actual link values separately so this test still drives the original pinned tree API.
      for (const link of ['linked-skill', 'src/linked-reference', 'cycle-a', 'cycle-b', 'self', 'external']) {
        states[link] = { kind: 'symlink', symlinkTarget: await readlink(path.join(project.root, link)) };
      }
      await store.createBranch('workspace', 'source', states);
      const pin = await adapter.pinBranch('source', { revision: 0 });
      try {
        const reader = createPinnedResourceReader({ domainId: 'project', store: adapter, pin, coverage: { kind: 'complete' } });
        expect(await reader.read('linked-skill/SKILL.md')).toMatchObject({ status: 'ready', reference: { canonicalId: 'resource:project/.pi/skills/review/SKILL.md' } });
        expect(await reader.read('src/linked-reference')).toMatchObject({ status: 'ready', content: 'FIXED REFERENCE' });
        expect(await reader.read('self/self/AGENTS.md')).toMatchObject({ status: 'ready', content: 'fixed root' });
        expect(await reader.list('linked-skill')).toMatchObject({ status: 'ready', entries: expect.arrayContaining([{ name: 'SKILL.md', kind: 'file' }]) });
        expect(await reader.read('cycle-a')).toMatchObject({ status: 'invalid', reason: expect.stringContaining('cycle') });
        expect(await reader.read('external')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('External symlink') });
        await writeFile(path.join(project.root, '.pi/SYSTEM.md'), 'later system');
        await rm(path.join(project.root, 'src/AGENTS.md'));
        await writeFile(path.join(project.root, '.pi/skills/review/SKILL.md'), skill('review', 'LATER SKILL'));
        const snapshot = await prepared(scope({ project: { reader, cwd: '' } }));
        expect(resourceSections(snapshot, 'runtime', 'resource_read').preamble).toBe('fixed system');
        const nested = await authority.read({ snapshot, readers: [reader] }, { kind: 'instruction-scope', targetPath: 'src/main.ts' });
        expect(nested.status === 'ready' && nested.kind === 'instruction-scope' && nested.instructions.map(item => item.content)).toEqual(['fixed root', 'fixed nested']);
        const support = await authority.read({ snapshot, readers: [reader] }, { kind: 'skill-resource', resourceId: snapshot.skills[0]!.id, relativePath: 'reference.txt' });
        expect(support.status === 'ready' && support.kind === 'skill-resource' && support.file.content).toBe('FIXED REFERENCE');
        const incomplete = createPinnedResourceReader({ domainId: 'old-git', store: adapter, pin, coverage: { kind: 'selected', paths: ['known-missing'], subtrees: [] } });
        expect(await incomplete.read('unknown-ignored')).toMatchObject({ status: 'unavailable' });
        expect(await incomplete.read('known-missing')).toMatchObject({ status: 'missing' });
        expect(await incomplete.list('.pi/skills')).toMatchObject({ status: 'unavailable' });
        expect(await incomplete.read('AGENTS.md')).toMatchObject({ status: 'ready', content: 'fixed root' });
      } finally { await pin.release(); }
    } finally { database.close(); }
  });

  it('adapts Documents revisions without promoting live readers to immutable snapshots', async () => {
    const readSnapshot = vi.fn(async (resource: { workspaceId: string; resourceId: string }) => ({ status: 'ready' as const,
      resource, revision: 'document-v1', content: '', encoding: 'utf8', bom: false, byteLength: 0, modifiedAt: 'now' }));
    const reader = createDocumentResourceReader({ domainId: 'workspace', viewId: 'request-view', workspaceId: 'workspace', documents: { readSnapshot },
      list: async target => ({ status: 'unavailable', domainId: 'workspace', viewId: 'request-view', path: target, reason: 'Not provided' }) });
    const signal = new AbortController().signal;
    expect(await reader.read('AGENTS.md', signal)).toMatchObject({ status: 'ready', content: '', reference: { version: 'document-v1' } });
    expect(readSnapshot).toHaveBeenCalledWith({ workspaceId: 'workspace', resourceId: 'AGENTS.md' }, { signal });
    expect(reader.consistency).toBe('capture-only');
    expect(await reader.read('../other')).toMatchObject({ status: 'denied' });
  });
});
