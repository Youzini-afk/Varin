import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Operation } from '@varin/protocol';
import type { ThreadsAPI } from '@varin/application-client';
import { ChatQuestionTool } from './ChatQuestionTool';
import { ConversationContext, type ConversationPresentation } from './ConversationContext';
import { useToolOperation } from './useToolOperation';

vi.mock('@/lib/i18n', async original => ({
  ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));

const identity = { runtime: 'agent' as const, threadId: 'thread:question', branchId: 'branch:question' };
const questionArguments = { questions: [{ id: 'choice', question: 'Which approach?', options: [{ id: 'a', label: 'First' }], selection: 'single', required: true }] };
const operation = (id: string, revision: number): Operation => ({
  id, revision, run_id: 'run:question', epoch: 1, phase: 'waiting', outcome: null, effect: 'none',
  execution_owner: null, external_receipt: null, call_completion: null, cancel_requested: false,
  lifetime: 'run', handed_off: false, executor: 'ask_user', waiting_on: id,
  intent: { call: { name: 'ask_user', arguments: questionArguments } }, result: null,
});
let root: Root, container: HTMLElement, presentation: ConversationPresentation;
let reader: ReturnType<typeof useToolOperation>;
const read = vi.fn<ThreadsAPI['operation']>();
const run = vi.fn<ThreadsAPI['run']>();

beforeEach(() => {
  const { window, document } = parseHTML('<html><body></body></html>');
  for (const [name, value] of Object.entries({ window, document, Element: window.Element, HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true })) vi.stubGlobal(name, value);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  read.mockReset(); run.mockReset();
  run.mockResolvedValue({ id: 'run:question', thread_id: identity.threadId, branch_id: identity.branchId } as Awaited<ReturnType<ThreadsAPI['run']>>);
  presentation = { api: { operation: read, run } as unknown as ThreadsAPI, identity, head: null, toolExecutions: {},
    quote() {}, async openFile() {}, async fileTarget() { throw new Error('Not used'); } };
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

function Probe({ id, projected }: { id?: string; projected?: Operation }) {
  reader = useToolOperation(id, projected);
  return <span>{reader.operation ? `${reader.operation.id}:${reader.operation.revision}` : 'unavailable'}</span>;
}
const renderProbe = (id?: string, projected?: Operation) => act(async () => root.render(
  <ConversationContext.Provider value={presentation}><Probe id={id} projected={projected} /></ConversationContext.Provider>,
));

it('renders a streamed question before an operation exists and adopts its later accepted operation', async () => {
  const id = 'request:tool:question';
  const renderQuestion = (accepted?: Operation, generating = true) => act(async () => root.render(
    <ConversationContext.Provider value={presentation}>
      <ChatQuestionTool call={{ type: 'toolCall', id: 'question-call', name: 'ask_user', arguments: questionArguments,
        ...(generating ? { rawArguments: JSON.stringify(questionArguments) } : {}) }}
        execution={accepted ? { toolCallId: 'question-call', operationId: accepted.id, operation: accepted,
          name: 'ask_user', args: questionArguments, status: 'waiting' } : undefined}
        status={accepted ? 'waiting' : 'running'} generating={generating} cwd="" output={null} details={null} />
    </ConversationContext.Provider>,
  ));
  await renderQuestion();
  expect(container.textContent).toContain('Which approach?');
  expect(container.textContent).toContain('chat.tools.preparingCall');
  await renderQuestion(operation(id, 2), false);
  expect(container.textContent).toContain('Which approach?');
  // A read-only historical question can also be mounted without a retained Operation.
  await renderQuestion(undefined, false);
  expect(container.textContent).toContain('Which approach?');
  expect(read).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it('keeps a missing operation unavailable and does not read or adopt an unrelated projection', async () => {
  await renderProbe(undefined, operation('other', 1));
  expect(container.textContent).toBe('unavailable');
  expect(reader.available).toBe(false);
  await act(async () => { await reader.refresh(); await reader.cancel(); });
  expect(read).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it('selects the newest matching revision and releases loaded state when the operation changes', async () => {
  const id = 'request:tool:question';
  read.mockResolvedValue(operation(id, 3));
  await renderProbe(id, operation(id, 1));
  expect(reader.operation?.revision).toBe(1);
  await act(async () => reader.refresh());
  expect(reader.operation?.revision).toBe(3);
  await renderProbe(id, operation(id, 2));
  expect(reader.operation?.revision).toBe(3);
  await renderProbe(id, operation(id, 4));
  expect(reader.operation?.revision).toBe(4);
  await renderProbe('different-operation', operation(id, 5));
  expect(reader.operation).toBeUndefined();
  await renderProbe();
  expect(reader.operation).toBeUndefined();
  expect(reader.available).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(id);
});
