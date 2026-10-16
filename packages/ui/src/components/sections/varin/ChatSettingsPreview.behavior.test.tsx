import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dict } from '@/lib/i18n/messages/en';
import { useUIStore } from '@/stores/useUIStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { ChatSettingsPreview, type ChatPreviewScene } from './ChatSettingsPreview';

const extensionRender = vi.hoisted(() => vi.fn(() => undefined));
const matchRenderers = vi.hoisted(() => vi.fn(() => []));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? name)) }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/icons/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('@/components/ui/VarinLogo', () => ({ VarinLogo: () => null }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content, enableFileReferences }: { content: string; enableFileReferences?: boolean }) => <div data-file-links={enableFileReferences}>{content}</div> }));
vi.mock('@/components/conversation/ChatFileChangePreview', () => ({ ChatFileChangePreview: ({ onOpen }: { onOpen?: () => void }) => <button disabled={!onOpen}>sample file</button>, ChatFileChangePreviewScope: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PierreDiffViewer: ({ renderSideBySide }: { renderSideBySide: boolean }) => <div data-split-diff={renderSideBySide} /> }));
vi.mock('@/lib/extensions/workbench-registry', () => ({ useWorkbenchMatchRenderers: matchRenderers, renderFirstWorkbenchMatch: extensionRender }));

let root: Root;
let container: HTMLDivElement;
let scene: ChatPreviewScene;
const render = async () => act(async () => root.render(<ChatSettingsPreview scene={scene} onSceneChange={value => { scene = value; void render(); }} />));
beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body></body></html>');
  for (const [name, value] of Object.entries({ document, window, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: () => ({ lineHeight: '20', fontSize: '13' }) })) vi.stubGlobal(name, value);
  window.HTMLElement.prototype.scrollTo = vi.fn();
  useUIStore.setState({ chatRenderMode: 'live', activityRenderMode: 'collapsed', showReasoningTraces: true, collapsibleThinkingBlocks: true,
    showExpandedBashTools: false, showExpandedEditTools: false, showTurnChangedFiles: true, showToolFileIcons: true, diffLayoutPreference: 'inline',
    chatContentWidth: 960, fontSize: 100, padding: 100, persistChatDraft: true, inputSpellcheckEnabled: true, draftStartersVisible: true });
  usePreferencesStore.setState({ settingsDefaultFileViewerPreview: true });
  extensionRender.mockClear(); matchRenderers.mockClear(); scene = 'conversation';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses the production turn renderer without activating extensions or granting file/terminal actions', async () => {
  await render();
  expect(container.querySelector('[data-conversation-user-message]')).not.toBeNull();
  expect(container.querySelector('[data-conversation-sorted-activity]')).toBeNull();
  expect(container.textContent).toContain(dict['settings.chat.preview.answer']);
  expect(container.textContent).toContain(dict['chat.changedFiles.title']);
  expect(extensionRender).not.toHaveBeenCalled();
  expect(matchRenderers.mock.calls.every(call => (call as unknown[])[2] === false)).toBe(true);
  const fileButton = [...container.querySelectorAll('button')].find(button => button.textContent === 'src/validate.ts');
  expect(fileButton?.disabled).toBe(true);
  expect(container.querySelector('[data-file-links="true"]')).toBeNull();
});

it('changes real activity layout, thinking visibility and tool disclosure defaults as preferences change', async () => {
  await render();
  expect(container.querySelector('details[data-conversation-tool-disclosure="tool:settings-preview:test"]')?.hasAttribute('open')).toBe(false);
  await act(async () => useUIStore.setState({ showExpandedBashTools: true }));
  expect(container.querySelector('details[data-conversation-tool-disclosure="tool:settings-preview:test"]')?.hasAttribute('open')).toBe(true);
  await act(async () => useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'collapsed' }));
  expect(container.querySelector('[data-conversation-sorted-activity] > button')?.getAttribute('aria-expanded')).toBe('false');
  await act(async () => useUIStore.setState({ activityRenderMode: 'summary' }));
  expect(container.querySelector('[data-conversation-sorted-activity] > button')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-conversation-activity-kind="thinking"]')).not.toBeNull();
  await act(async () => useUIStore.setState({ showReasoningTraces: false }));
  expect(container.querySelector('[data-conversation-activity-kind="thinking"]')).toBeNull();
});

it('lets users collapse the preview, switch file scenes and change the shared diff preference', async () => {
  await render();
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.hasAttribute('hidden')).toBe(true);
  await act(async () => toggle.click());
  scene = 'files'; await render();
  expect(container.querySelector('[data-split-diff]')?.getAttribute('data-split-diff')).toBe('false');
  await act(async () => useUIStore.setState({ diffLayoutPreference: 'side-by-side' }));
  expect(container.querySelector('[data-split-diff]')?.getAttribute('data-split-diff')).toBe('true');
  const file = [...container.querySelectorAll('button')].find(button => button.textContent === 'README.md')!;
  expect(file.getAttribute('aria-expanded')).toBe('true');
  expect(container.textContent).toContain(dict['settings.chat.preview.readme']);
  await act(async () => usePreferencesStore.setState({ settingsDefaultFileViewerPreview: false }));
  expect(container.querySelector('pre')?.textContent).toBe(dict['settings.chat.preview.readme']);
});

it('keeps sample sending and draft retention local to the preview', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  scene = 'input'; await render();
  const input = container.querySelector('textarea')!;
  const type = async (text: string) => act(async () => {
    input.value = text;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const revisit = () => [...container.querySelectorAll('button')].find(button => button.textContent === dict['settings.chat.preview.revisit'])!;
  await type('Keep this draft');
  await act(async () => revisit().click());
  expect(input.value).toBe('Keep this draft');
  await act(async () => useUIStore.setState({ persistChatDraft: false }));
  await act(async () => revisit().click());
  expect(input.value).toBe('');
  await type('Check one more case');
  await act(async () => container.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Check one more case');
  expect(input.value).toBe('');
  expect(fetch).not.toHaveBeenCalled();
});
