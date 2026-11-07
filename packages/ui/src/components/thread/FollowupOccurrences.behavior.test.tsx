import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Followup, FollowupOccurrence } from '@varin/protocol';
import type { ThreadFollowupsAPI, ThreadFamilyAPI, ThreadsAPI } from '@varin/application-client';
import { FollowupOccurrences } from './ThreadFollowups';
const navigation = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined), external: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/agent-runtime/threadNavigation', () => ({ openThreadFromNavigation: navigation.open, openExternalConversationFromNavigation: navigation.external }));
vi.mock('./ExternalConversation', () => ({ ExternalConversationView: (props: { id: string; turnId?: string; readOnly?: boolean }) => <output data-external>{JSON.stringify(props)}</output> }));
vi.mock('./ThreadEventArrangements', () => ({ ThreadEventArrangements: () => null }));
vi.mock('./ThreadFollowupOccurrenceDetails', () => ({ ThreadFollowupOccurrenceDetails: () => null }));
vi.mock('./ThreadFamily', () => ({ ThreadRunHistory: ({ identity, runId }: { identity: { threadId: string; branchId: string }; runId: string }) => <output>{JSON.stringify({ identity, runId })}</output> }));
vi.mock('@/lib/i18n', async () => { const { followupPanelEn } = await import('@/lib/i18n/messages/followups'); const words: Record<string, string> = followupPanelEn; return { useI18n: () => ({ t: (key: string, params: Record<string, unknown> = {}) => (words[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')) }) }; });
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
const identity = { runtime: 'agent' as const, threadId: 'managing-entry', branchId: 'main' };
const occurrence: FollowupOccurrence = { id: 'original-occurrence', generation: 1, accepted_cursor: 20, trigger_cursor: 15, state: 'completed', hold_reason: null,
  evidence: { kind: 'plugin_events', event_ids: ['first-message', 'second-message'], received_at_ms: 1000 } as FollowupOccurrence['evidence'],
  delivery: { thread_id: 'original-task', branch_id: 'original-branch', input_id: 'input', state: 'delivered', activation_state: 'bound', run_id: 'original-run', execution_id: null, delivered_cursor: 25, failure_code: null } };
let root: Root, container: HTMLElement;
beforeEach(() => { const { window } = parseHTML('<html><body></body></html>'); vi.stubGlobal('window', window); vi.stubGlobal('document', window.document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });
it('reads real trigger receipts via the management entry but opens their original receiving Run after retargeting', async () => {
  const occurrences = vi.fn().mockResolvedValue({ occurrences: [occurrence], nextCursor: null });
  await act(async () => root.render(<FollowupOccurrences api={{ occurrences } as unknown as ThreadFollowupsAPI} family={{} as ThreadFamilyAPI} mediaRead={vi.fn() as ThreadsAPI['mediaRead']} identity={identity} item={{ id: 'watch', thread_id: 'new-target', branch_id: 'new-branch', external_conversation_id: 'new-external', trigger: { kind: 'plugin_event' } } as Followup} />));
  const click = async (text: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!.click()); };
  await click('Read trigger history'); expect(occurrences).toHaveBeenCalledWith(identity, 'watch', undefined, expect.any(AbortSignal));
  expect(container.textContent).toContain('first-message, second-message'); expect(container.textContent).toContain('original-task');
  await click('Read processing Run'); expect(JSON.parse(container.querySelector('output')!.textContent!)).toEqual({ identity: { runtime: 'agent', threadId: 'original-task', branchId: 'original-branch' }, runId: 'original-run' });
  await click('Refresh trigger page'); expect(occurrences).toHaveBeenCalledTimes(2);
});

it('shows and opens the fixed object-route target while its original event batch is held before input admission', async () => {
  const held: FollowupOccurrence = { ...occurrence, state: 'held', hold_reason: 'branch_active', delivery: null, target: { threadId: 'routed-task', branchId: 'fixed-branch', userInput: false } };
  const occurrences = vi.fn().mockResolvedValue({ occurrences: [held], nextCursor: null });
  await act(async () => root.render(<FollowupOccurrences api={{ occurrences } as unknown as ThreadFollowupsAPI} mediaRead={vi.fn() as ThreadsAPI['mediaRead']} identity={identity} item={{ id: 'watch', thread_id: 'default-target', branch_id: 'default', trigger: { kind: 'plugin_event' } } as Followup} />));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === 'Read trigger history')!.click());
  expect(container.textContent).toContain('routed-task'); expect(container.textContent).not.toContain('default-target');
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === 'harness.threads.openConversation')!.click());
  expect(navigation.open).toHaveBeenCalledWith({ runtime: 'agent', threadId: 'routed-task', branchId: 'fixed-branch' });
});

it('reads and navigates the original external receiver and consumed turn rather than the native management anchor', async () => {
  const external: FollowupOccurrence = { ...occurrence, delivery: null, target: { threadId: 'anchor', branchId: 'anchor-branch', userInput: false, externalConversationId: 'external-original' }, external_delivery: { conversation_id: 'external-original', turn_id: 'queued-turn', state: 'completed', hold_reason: null, consumed_by_turn_id: 'consuming-turn' } };
  const occurrences = vi.fn().mockResolvedValue({ occurrences: [external], nextCursor: null });
  await act(async () => root.render(<FollowupOccurrences api={{ occurrences } as unknown as ThreadFollowupsAPI} mediaRead={vi.fn() as ThreadsAPI['mediaRead']} identity={identity} item={{ id: 'watch', thread_id: 'new-anchor', branch_id: 'new-branch', trigger: { kind: 'plugin_event' } } as Followup} />));
  const click = async (text: string) => { await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text)!.click()); };
  await click('Read trigger history'); expect(container.textContent).toContain('external-original'); expect(container.textContent).not.toContain('new-anchor');
  await click('Read original external turn'); expect(JSON.parse(container.querySelector('output[data-external]')!.textContent!)).toEqual({ id: 'external-original', turnId: 'consuming-turn', readOnly: true });
  await click('harness.threads.openConversation'); expect(navigation.external).toHaveBeenCalledWith('external-original');
});
it('shows a held external target before a turn exists instead of presenting its native anchor as the receiver', async () => {
  const held: FollowupOccurrence = { ...occurrence, state: 'held', hold_reason: 'target_unavailable', delivery: null, target: { threadId: 'native-anchor', branchId: 'main', userInput: false, externalConversationId: 'external-held' } };
  const occurrences = vi.fn().mockResolvedValue({ occurrences: [held], nextCursor: null });
  await act(async () => root.render(<FollowupOccurrences api={{ occurrences } as unknown as ThreadFollowupsAPI} mediaRead={vi.fn() as ThreadsAPI['mediaRead']} identity={identity} item={{ id: 'watch', thread_id: 'native-anchor', branch_id: 'main', trigger: { kind: 'plugin_event' } } as Followup} />));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === 'Read trigger history')!.click());
  expect(container.textContent).toContain('external-held'); expect(container.textContent).not.toContain('native-anchor'); expect(container.textContent).toContain('Receiving target is unavailable');
});
