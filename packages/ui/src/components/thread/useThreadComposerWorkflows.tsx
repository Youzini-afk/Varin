import React from 'react';
import { getRuntimeEndpointGeneration, type ThreadIdentity, type ThreadSnapshot, type ThreadsAPI } from '@varin/application-client';
import { EMPTY_THREAD_DRAFT, useThreadDraftStore } from '@/stores/useThreadDraftStore';
import type { ComposerCommandAction } from '@/lib/commands/surface-command-types';
import type { ComposerRecipient } from './composerWorkflowState';
import { ComposerRecipientPicker } from './ComposerRecipientPicker';
import { ComposerDirectedInput } from './ComposerDirectedInput';
import { ThreadExportForm } from './ThreadExportForm';
import { ThreadHandoffForm } from './ThreadHandoffForm';
import { ThreadRememberForm } from './ThreadRememberForm';

export function useThreadComposerWorkflows({ api, identity, snapshot, draftKey, draftText, selectedText, onMemoryOpen, refresh, disabled }: {
  api: ThreadsAPI; identity: ThreadIdentity; snapshot?: ThreadSnapshot; draftKey: string; draftText: string;
  selectedText?: string; onMemoryOpen?(): void; refresh?(): void; disabled?: string;
}): { actions: Record<string, ComposerCommandAction | undefined>; directed: React.ReactNode | null } {
  const host = getRuntimeEndpointGeneration();
  const draft = useThreadDraftStore(state => state.drafts[draftKey] ?? EMPTY_THREAD_DRAFT);
  const recipient = draft.composerWorkflow?.recipient;
  const select = React.useCallback((next?: ComposerRecipient) => {
    if (host !== getRuntimeEndpointGeneration()) return;
    useThreadDraftStore.getState().patch(draftKey, current => ({ composerWorkflow: { ...current.composerWorkflow, recipient: next } }));
  }, [draftKey, host]);
  const actions: Record<string, ComposerCommandAction | undefined> = {
    export: api.workflows && snapshot ? { disabled, content: <ThreadExportForm key={`${draftKey}:export`} api={api} identity={identity} snapshot={snapshot} /> } : undefined,
    remember: api.workflows ? { disabled, content: (_complete, context) => <ThreadRememberForm key={`${draftKey}:remember`} api={api} identity={identity} draftKey={draftKey} initialText={selectedText || context?.selectedText || (context ? context.text : draftText)} onOpen={onMemoryOpen} /> } : undefined,
    handoff: api.collaboration && api.family && snapshot ? { disabled, content: (complete, context) => <ThreadHandoffForm key={`${draftKey}:handoff`} api={api} identity={identity} snapshot={snapshot} draftKey={draftKey} initialText={selectedText || context?.selectedText || (context ? context.text : draftText)} onRecipient={select} onDone={complete} refresh={refresh} /> } : undefined,
    contact: api.messages && api.family ? { disabled, content: complete => <ComposerRecipientPicker key={`${draftKey}:contact`} api={api} identity={identity} onSelect={next => { select(next); complete(); }} /> } : undefined,
  };
  return { actions, directed: recipient && !disabled ? <ComposerDirectedInput key={`${draftKey}:directed`} api={api} identity={identity} draftKey={draftKey} recipient={recipient} select={select} onSent={refresh ?? (() => {})} /> : null };
}
