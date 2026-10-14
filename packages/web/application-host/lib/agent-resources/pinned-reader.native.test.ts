import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAgentResourceAuthority, type AdmittedAgentResourceScope } from './authority.js';
import { createPinnedResourceReader } from './source-reader.js';
import { resourceSections } from './render.js';
import { createDocumentAuthority } from '../documents/authority.js';
import { createAuthorityTestRuntime } from '../kernel/authority.test-helper.js';
const roots: string[] = [];
const authority = createAgentResourceAuthority();
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`;
const scope = (extra: Partial<AdmittedAgentResourceScope> = {}): AdmittedAgentResourceScope => ({
  threadId: 'thread', branchId: 'branch', mode: 'agent', threadRole: 'main', projectId: 'project', sourceIdentity: 'source-v1', projectTrusted: true, ...extra,
});
async function fixture(files: Record<string, string>, name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `varin-${name}-`)); roots.push(root);
  for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), content); }
  return { root };
}
async function prepared(input: AdmittedAgentResourceScope) {
  const result = await authority.prepare(input);
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.snapshot;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  it('uses the existing pinned WorkingState API after live files change, and never treats uncovered Git absence as missing', async () => {
    const project = await fixture({ '.varin/settings.json': '{}', '.varin/resources/SYSTEM.md': 'fixed system', 'AGENTS.md': 'fixed root',
      'src/AGENTS.md': 'fixed nested', '.varin/resources/skills/review/SKILL.md': skill('review', 'FIXED SKILL'), '.varin/resources/skills/review/reference.txt': 'FIXED REFERENCE' }, 'project');
    await symlink('.varin/resources/skills/review', path.join(project.root, 'linked-skill'));
    await symlink('../.varin/resources/skills/review/reference.txt', path.join(project.root, 'src/linked-reference'));
    await symlink('cycle-b', path.join(project.root, 'cycle-a'));
    await symlink('cycle-a', path.join(project.root, 'cycle-b'));
    await symlink('.', path.join(project.root, 'self'));
    await symlink('/external/not-in-pin', path.join(project.root, 'external'));
    const recovery = path.join(project.root, 'store-outside-source');
    const documents = createDocumentAuthority({ hostId: '11111111-1111-4111-8111-111111111111', dataDir: recovery });
    const { workspaceId } = await documents.resolveWorkspace({ path: project.root });
    const native = await createAuthorityTestRuntime({ documents, hostId: documents.hostId, dataDir: recovery });
    try {
      await native.workingStates.withBranchStore(workspaceId, 'resource-pinned-read', async adapter => {
      const paths = ['.varin', '.varin/resources', '.varin/settings.json', '.varin/resources/SYSTEM.md', 'AGENTS.md', 'src', 'src/AGENTS.md', '.varin/resources/skills', '.varin/resources/skills/review', '.varin/resources/skills/review/SKILL.md', '.varin/resources/skills/review/reference.txt'];
      const states = await adapter.captureDirectory(project.root, [...paths, 'linked-skill', 'src/linked-reference', 'cycle-a', 'cycle-b', 'self', 'external']);
      await adapter.createBranch(workspaceId, 'source', states);
      const pin = await adapter.pinBranch('source', { revision: 0 });
      try {
        const reader = createPinnedResourceReader({ domainId: 'project', store: adapter, pin, coverage: { kind: 'complete' } });
        expect(await reader.read('linked-skill/SKILL.md')).toMatchObject({ status: 'ready', reference: { canonicalId: 'resource:project/.varin/resources/skills/review/SKILL.md' } });
        expect(await reader.read('src/linked-reference')).toMatchObject({ status: 'ready', content: 'FIXED REFERENCE' });
        expect(await reader.read('self/self/AGENTS.md')).toMatchObject({ status: 'ready', content: 'fixed root' });
        expect(await reader.list('linked-skill')).toMatchObject({ status: 'ready', entries: expect.arrayContaining([{ name: 'SKILL.md', kind: 'file' }]) });
        expect(await reader.read('cycle-a')).toMatchObject({ status: 'invalid', reason: expect.stringContaining('cycle') });
        expect(await reader.read('external')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('External symlink') });
        await writeFile(path.join(project.root, '.varin/resources/SYSTEM.md'), 'later system');
        await rm(path.join(project.root, 'src/AGENTS.md'));
        await writeFile(path.join(project.root, '.varin/resources/skills/review/SKILL.md'), skill('review', 'LATER SKILL'));
        const snapshot = await prepared(scope({ project: { reader, cwd: '' } }));
        expect(resourceSections(snapshot, 'runtime', 'resource_read').preamble).toBe('fixed system');
        const nested = await authority.read({ snapshot, readers: [reader] }, { kind: 'instruction-scope', targetPath: 'src/main.ts' });
        expect(nested.status === 'ready' && nested.kind === 'instruction-scope' && nested.instructions.map(item => item.content)).toEqual(['fixed root', 'fixed nested']);
        const support = await authority.read({ snapshot, readers: [reader] }, { kind: 'skill-resource', resourceId: snapshot.skills[0]!.id, relativePath: 'reference.txt' });
        expect(support.status === 'ready' && support.kind === 'skill-resource' && support.file.content).toBe('FIXED REFERENCE');
        const incomplete = createPinnedResourceReader({ domainId: 'old-git', store: adapter, pin, coverage: { kind: 'selected', paths: ['known-missing'], subtrees: [] } });
        expect(await incomplete.read('unknown-ignored')).toMatchObject({ status: 'unavailable' });
        expect(await incomplete.read('known-missing')).toMatchObject({ status: 'missing' });
        expect(await incomplete.list('.varin/resources/skills')).toMatchObject({ status: 'unavailable' });
        expect(await incomplete.read('AGENTS.md')).toMatchObject({ status: 'ready', content: 'fixed root' });
      } finally { await pin.release(); }
      });
    } finally { await native.dispose(); await documents.dispose(); }
  }, 60_000);
