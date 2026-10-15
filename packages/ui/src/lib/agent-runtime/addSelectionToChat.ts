import { focusChatInput } from '@/components/chat/composer/editor/dom';
import {
  formatCodeSelectionMarkdown,
  rangeToMarkdown,
  trimSelectionValue,
  wrapMarkdownSelectionForChat,
} from '@/components/chat/message/selectionMarkdown';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { appendThreadDraftText, startThreadFromNavigation } from './threadNavigation';
import { useThreadStore } from '@/stores/useThreadStore';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';

const CHAT_INPUT_SELECTOR = '[data-chat-input="true"]';

const isInsideChatComposer = (node: Node | null): boolean => {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element?.closest(CHAT_INPUT_SELECTOR));
};

const captureTextControlSelection = (): string | null => {
  const element = document.activeElement;
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
  if (isInsideChatComposer(element)) return null;
  if (element instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(element.type)) return null;
  const text = trimSelectionValue(element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0));
  return text ? wrapMarkdownSelectionForChat(text) : null;
};

const captureCodeMirrorSelection = async (
  editor: HTMLElement | null,
): Promise<string | null> => {
  if (!editor || isInsideChatComposer(editor)) return null;
  const { EditorView } = await import('@codemirror/view');
  const view = EditorView.findFromDOM(editor);
  if (!view) return null;
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const text = trimSelectionValue(view.state.sliceDoc(from, to));
  if (!text) return null;
  view.dispatch({ selection: { anchor: to } });
  return formatCodeSelectionMarkdown(text);
};

const captureDomSelection = (): string | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (isInsideChatComposer(range.commonAncestorContainer)) return null;
  const text = trimSelectionValue(selection.toString());
  if (!text) return null;
  const markdown = rangeToMarkdown(range, text);
  selection.removeAllRanges();
  return wrapMarkdownSelectionForChat(markdown);
};

export const captureSelectionMarkdown = async (): Promise<string | null> => {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const editor = document.querySelector<HTMLElement>('.cm-editor.cm-focused');
  if (editor && !isInsideChatComposer(editor)) return captureCodeMirrorSelection(editor);
  return captureTextControlSelection() ?? captureDomSelection();
};

export const addSelectionToChat = async (): Promise<boolean> => {
  const host = getRuntimeEndpointGeneration();
  const selected = useThreadStore.getState().selectedIdentity;
  const markdown = await captureSelectionMarkdown();
  if (host !== getRuntimeEndpointGeneration() || selected !== useThreadStore.getState().selectedIdentity) return false;
  const directory = useDirectoryStore.getState().currentDirectory;
  const ui = useUIStore.getState();
  ui.setActiveMainTab('chat'); ui.setSessionSwitcherOpen(false);
  if (markdown) {
    const identity = selected ?? await startThreadFromNavigation({ directory });
    if (host !== getRuntimeEndpointGeneration()) return false;
    appendThreadDraftText(identity, markdown);
  }
  queueMicrotask(focusChatInput);
  return markdown !== null;
};
