import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocumentEncodingNotice } from './DocumentEncodingMenu';

const state = vi.hoisted(() => ({ record: {} as Record<string, unknown>, setFormat: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/documents/hooks', () => ({ useDocumentRecord: () => state.record }));
vi.mock('@/lib/documents/session', () => ({ getDocumentRegistry: () => state }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const identity = { workspaceId: 'original', resourceId: 'legacy.c' };
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  state.record = { status: 'ready', errorMessage: 'Emoji cannot be saved in GBK', encoding: 'gbk', localEditRevision: 4, saveErrorRevision: 4, saveErrorReason: 'unrepresentable' };
  state.setFormat.mockReset(); state.save.mockReset().mockResolvedValue({});
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

it('keeps a failed legacy save visible and converts only when the user asks', async () => {
  await act(async () => root.render(<DocumentEncodingNotice identity={identity} />));
  expect(container.textContent).toContain('Emoji cannot be saved in GBK');
  expect(state.save).not.toHaveBeenCalled();
  const button = container.querySelector('button')!;
  await act(async () => button.click());
  expect(state.setFormat).toHaveBeenCalledWith(identity, { encoding: 'utf-8', bom: false });
  expect(state.save).toHaveBeenCalledWith(identity);
});

it('does not suggest conversion for a filesystem failure or stale error', async () => {
  state.record.saveErrorReason = 'failed';
  await act(async () => root.render(<DocumentEncodingNotice identity={identity} />));
  expect(container.querySelector('button')).toBeNull();
  state.record.saveErrorReason = 'unrepresentable'; state.record.localEditRevision = 5;
  await act(async () => root.render(<DocumentEncodingNotice identity={identity} />));
  expect(container.querySelector('button')).toBeNull();
});
