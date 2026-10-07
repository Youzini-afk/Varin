import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import type { AgentPersonalizationCatalog, AgentSystemPromptSnapshot } from '@varin/protocol';
import { AgentPromptPage } from './AgentPromptPage';
import { AgentMemoryPage } from './AgentMemoryPage';

const fixture = vi.hoisted(() => ({ catalog: {} as AgentPersonalizationCatalog, snapshot: {} as AgentSystemPromptSnapshot,
  update: vi.fn(async (..._args: unknown[]) => true), load: vi.fn(), project: { id: 'project-a', path: '/repo', label: 'Project A' } }));
vi.mock('./agentSettings', () => ({ useAgentSettings: () => ({ catalog: fixture.catalog, error: null, busy: false,
  runtime: 'local', load: fixture.load, update: fixture.update }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/pi-runtime/client', () => ({ getPiRuntimeConnection: async () => ({ client: {
  request: async () => fixture.snapshot, subscribe: () => () => {},
} }) }));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: (select: (value: unknown) => unknown) => select({
  currentSessionId: 'chat', summaries: [{ id: 'chat', cwd: '/repo', name: 'Current task' }], records: { chat: { open: true } },
}) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (value: unknown) => unknown) => select({ projects: [fixture.project], activeProjectId: 'project-a' }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (value: unknown) => unknown) => select({ currentDirectory: '/repo' }) }));
vi.mock('@/stores/useBotSessionIndex', () => ({ useBotSessionIndex: () => ({}), refreshBotSessionIndex: async () => {}, regularPiSessions: (sessions: unknown) => sessions }));
vi.mock('@/components/sections/shared/SettingsPageLayout', () => ({ SettingsPageLayout: ({ children }: React.PropsWithChildren) => <main>{children}</main> }));
// Linkedom supplies input events; the shared textarea's browser change mapping is outside these behavior checks.
vi.mock('@/components/ui/textarea', () => ({ Textarea: ({ onChange, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
  <textarea {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLTextAreaElement>)} /> }));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.catalog = { revision: 4, prompts: {}, memories: [
    { id: 1, scope: { kind: 'global' }, content: 'Global note', updatedAt: '' },
    { id: 2, scope: { kind: 'project', id: 'project-a' }, content: 'Project note', updatedAt: '' },
  ] };
  fixture.snapshot = { mode: 'agent', sessionId: 'chat', original: { preamble: 'Official identity', rules: 'Official rules', project_context: 'Project instructions', cwd: '/repo' },
    sections: {}, content: '', personalization: { mode: 'agent', revision: 0, threadRole: 'main', sessionId: 'chat', profiles: [], memories: [] } };
  fixture.update.mockReset().mockResolvedValue(true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
const click = (label: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => button.textContent === label || button.getAttribute('aria-label') === label)!.click());
const type = (text: string) => act(async () => {
  const field = container.querySelector('textarea')!; field.value = text; field.dispatchEvent(new Event('input', { bubbles: true }));
});

test('edits official prompt text, previews generated context and saves only edits against the revision opened', async () => {
  await act(async () => root.render(<AgentPromptPage />));
  expect(container.querySelector('textarea')?.value).toContain('Official rules');
  expect(container.querySelector('pre')?.textContent).toContain('Project instructions');
  expect(container.querySelector('pre')?.textContent).toContain('Global note');
  await type('My identity\n\n<rules>\nOfficial rules\n</rules>');
  expect(container.querySelector('pre')?.textContent).toContain('My identity');
  // An incoming change must not silently turn this draft into a current-revision overwrite.
  fixture.catalog = { ...fixture.catalog, revision: 5 };
  await act(async () => root.render(<AgentPromptPage />));
  await click('assistant.save');
  expect(fixture.update).toHaveBeenCalledWith('prompt', { scope: { kind: 'global' }, revision: 4, profile: { sections: { preamble: 'My identity' } } });
});

test('shows scope-specific notes and keeps an edit on its selected project', async () => {
  await act(async () => root.render(<AgentMemoryPage />));
  expect(container.textContent).toContain('Global note');
  expect(container.textContent).not.toContain('Project note');
  await click('assistant.scope.project');
  expect(container.textContent).toContain('Project note');
  expect(container.textContent).not.toContain('Global note');
  await click('assistant.edit'); await type('Updated project decision');
  await click('assistant.save');
  expect(fixture.update).toHaveBeenCalledWith('memory', { id: 2, scope: { kind: 'project', id: 'project-a' }, content: 'Updated project decision', revision: 4 });
});

test('previews the conversation memory checkpoint while newly saved notes remain in the catalog', async () => {
  fixture.snapshot.memorySnapshot = { revision: 2, sessionId: 'chat', memories: [{ id: 1, scope: { kind: 'global' }, content: 'Checkpoint note', updatedAt: '' }] };
  await act(async () => root.render(<AgentPromptPage />));
  expect(container.querySelector('pre')?.textContent).toContain('Checkpoint note');
  expect(container.querySelector('pre')?.textContent).not.toContain('Global note');
  fixture.catalog = { ...fixture.catalog, revision: 5, memories: [{ ...fixture.catalog.memories[0]!, content: 'Newly saved note' }] };
  await act(async () => root.render(<AgentPromptPage />));
  expect(container.querySelector('pre')?.textContent).toContain('Checkpoint note');
  expect(container.querySelector('pre')?.textContent).not.toContain('Newly saved note');
});
