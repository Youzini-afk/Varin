import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseExplicitSkillCommand, prepareExplicitSkillActivation } from './activation.js';
import { createAgentResourceAuthority, type PreparedAgentResources } from './authority.js';
import { createAdmittedDirectoryReader } from './source-reader.js';
import { resourceSections } from './render.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const skillFile = (name: string, body: string, extra = '') => `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n${body}\n`;
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-skill-activation-')); roots.push(root);
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  for (const [file, content] of Object.entries(files)) await write(file, content);
  const reader = await createAdmittedDirectoryReader({ domainId: 'user', viewId: 'captured-user', root });
  const prepare = async () => {
    const result = await createAgentResourceAuthority().prepare({ threadId: 'thread', branchId: 'branch', mode: 'agent', threadRole: 'main',
      projectId: null, sourceIdentity: null, projectTrusted: false, user: { reader, displayRoot: root } });
    if (result.status !== 'ready') throw new Error(result.reason);
    return result.snapshot;
  };
  return { root, write, prepare };
}
const activate = (snapshot: PreparedAgentResources, text = '/skill:review args') => {
  const command = parseExplicitSkillCommand(text);
  if (!command) throw new Error('Test requires an explicit command');
  return prepareExplicitSkillActivation(snapshot, command);
};

describe('Explicit skill resource preparation', () => {
  it('recognizes only a leading SDK command and preserves the ASCII-space parsing boundary', () => {
    for (const text of [' /skill:review', '\n/skill:review', 'please /skill:review', '`/skill:review`', '/skill', '/skill review']) {
      expect(parseExplicitSkillCommand(text)).toBeNull();
    }
    expect(parseExplicitSkillCommand('/skill:review  first\n second  ')).toEqual({ name: 'review', arguments: 'first\n second' });
    expect(parseExplicitSkillCommand('/skill:review\targs')).toEqual({ name: 'review\targs', arguments: '' });
    expect(parseExplicitSkillCommand('/skill:review\nargs rest')).toEqual({ name: 'review\nargs', arguments: 'rest' });
    expect(parseExplicitSkillCommand('/skill:review /skill:other')).toEqual({ name: 'review', arguments: '/skill:other' });
  });

  it('uses the frozen hidden winner, retains exact resource provenance and never reopens a changed asset', async () => {
    const original = '\uFEFF---\r\nname: review\r\ndescription: review description\r\ndisable-model-invocation: true\r\nallowed-tools: [shell]\r\n---\r\n  ORIGINAL $ARGUMENTS\r\n';
    const f = await fixture({ 'settings.json': JSON.stringify({ skills: ['selected'] }), 'selected/SKILL.md': original,
      'skills/loser/SKILL.md': skillFile('review', 'COLLISION LOSER') });
    const snapshot = await f.prepare();
    expect(resourceSections(snapshot, 'runtime', 'resource_read').skills ?? '').not.toContain('review description');
    expect(snapshot.diagnostics.some(item => item.kind === 'collision')).toBe(true);
    const selected = snapshot.skills[0]!;
    const rawText = '/skill:review  first\n second  ';
    await f.write('selected/SKILL.md', skillFile('review', 'LATER'));
    const later = await f.prepare();
    const old = activate(snapshot, rawText);
    expect(old.status).toBe('ready');
    if (old.status !== 'ready') throw new Error(old.reason);
    expect(old.skill).toMatchObject({ snapshotId: snapshot.id, resourceId: selected.id, reference: selected.reference,
      name: 'review', arguments: 'first\n second', body: 'ORIGINAL $ARGUMENTS' });
    expect(old.skill.reference).not.toBe(selected.reference);
    expect(snapshot.capturedFiles.find(file => file.reference.path === 'selected/SKILL.md')?.content).toBe(original);
    expect(activate(later)).toMatchObject({ status: 'ready', skill: { body: 'LATER' } });
    await rm(f.root, { recursive: true, force: true });
    expect(activate(snapshot)).toMatchObject({ status: 'ready', skill: { body: 'ORIGINAL $ARGUMENTS' } });
  });

  it('does not silently fall through for unknown, empty or ambiguous skill selections', async () => {
    const f = await fixture({ 'skills/review/SKILL.md': skillFile('review', 'BODY') });
    const snapshot = await f.prepare();
    expect(activate(snapshot, '/skill:unknown')).toMatchObject({ status: 'missing' });
    expect(activate(snapshot, '/skill:')).toMatchObject({ status: 'invalid' });
    expect(activate(snapshot, '/skill: arg')).toMatchObject({ status: 'invalid' });
    expect(activate(snapshot, '/skill:review\targ')).toMatchObject({ status: 'missing' });
    const duplicate = structuredClone(snapshot);
    duplicate.skills.push({ ...duplicate.skills[0]!, id: 'another-winner' });
    expect(activate(duplicate)).toMatchObject({ status: 'invalid' });
  });

  it('distinguishes missing capture, changed provenance, malformed material and cancellation', async () => {
    const f = await fixture({ 'skills/review/SKILL.md': skillFile('review', 'BODY') });
    const snapshot = await f.prepare();
    const mutateCapture = (mutate: (snapshot: PreparedAgentResources, index: number) => void) => {
      const candidate = structuredClone(snapshot);
      const index = candidate.capturedFiles.findIndex(file => file.reference.path === candidate.skills[0]!.reference.path);
      mutate(candidate, index);
      return activate(candidate);
    };
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles.splice(index, 1); })).toMatchObject({ status: 'unavailable' });
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles.push(candidate.capturedFiles[index]!); })).toMatchObject({ status: 'invalid' });
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles[index]!.reference.version = 'different'; })).toMatchObject({ status: 'stale' });
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles[index]!.reference.canonicalId = 'different'; })).toMatchObject({ status: 'stale' });
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles[index]!.content = '---\nname: [broken\n---\nBODY'; })).toMatchObject({ status: 'invalid' });
    expect(mutateCapture((candidate, index) => { candidate.capturedFiles[index]!.content = skillFile('other', 'BODY'); })).toMatchObject({ status: 'stale' });
    const signal = AbortSignal.abort();
    expect(prepareExplicitSkillActivation(snapshot, { name: 'review', arguments: '' }, signal)).toMatchObject({ status: 'cancelled' });
  });

  it('keeps warning-only selected names invocable and accepts an empty skill body', async () => {
    const f = await fixture({ 'skills/review/SKILL.md': skillFile('Upper_Name', '') });
    const snapshot = await f.prepare();
    expect(snapshot.diagnostics.some(item => item.kind === 'warning')).toBe(true);
    expect(activate(snapshot, '/skill:Upper_Name')).toMatchObject({ status: 'ready', skill: { name: 'Upper_Name', body: '' } });
  });

  it('retains a root skill name derived from the original admitted directory', async () => {
    const f = await fixture({ 'settings.json': JSON.stringify({ skills: ['.'] }),
      'SKILL.md': '---\ndescription: Root directory skill\n---\nROOT BODY' });
    const snapshot = await f.prepare();
    const selected = snapshot.skills[0]!;
    expect(selected.name).toBe(path.basename(f.root));
    expect(selected.reference.path).toBe('SKILL.md');
    await rm(f.root, { recursive: true, force: true });
    expect(activate(snapshot, `/skill:${selected.name}`)).toMatchObject({ status: 'ready', skill: { name: selected.name, body: 'ROOT BODY' } });
  });
});
