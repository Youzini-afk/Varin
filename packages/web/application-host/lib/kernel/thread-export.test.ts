import { describe, expect, it, vi } from 'vitest';
import type { HistoryItem, HistoryReference } from '@varin/protocol';
import type { ThreadExportSelection } from '@varin/application-client';
import { exportPublicMessage, exportThreadConversation, type ThreadExportOwners } from './thread-export.js';
const identity = { runtime: 'agent' as const, threadId: 'thread:1', branchId: 'branch:1' };
const selection: ThreadExportSelection = { ...identity, headId: 'item:3', format: 'json', includeTools: false, includeAttachments: false };
const item = (id: number, source = 'user', content: unknown = { text: `message ${id}`, credentials: 'private' }): HistoryItem => ({ id: `item:${id}`, thread_id: identity.threadId, parent: id > 1 ? `item:${id - 1}` : null, source: source as HistoryItem['source'], content, provider: { secret: 'provider-secret' } as never, run_id: 'run:1' });
function fixture(items = [item(1), item(2), item(3)]) {
  const references = items.map(value => ({ ...value, content: undefined, provider: undefined, content_ref: `content:${value.id}` }) as unknown as HistoryReference);
  const runtime = {
    thread: vi.fn(async () => ({ branches: [{ branch_id: identity.branchId }], deleted_at_ms: null })),
    historyPage: vi.fn(async (input: { headId?: string; beforeId?: string }) => {
      const end = input.beforeId ? references.findIndex(value => value.id === input.beforeId) : references.findIndex(value => value.id === input.headId) + 1;
      const start = Math.max(0, end - 2);
      return { head: input.headId, items: references.slice(start, end), previous: start > 0 ? references[start]!.id : null };
    }),
    historyItem: vi.fn(async (reference: HistoryReference) => items.find(value => value.id === reference.id)!),
    mediaRead: vi.fn(),
    exportModelReferences: vi.fn(async () => ({ spaceId: 'space:1', references: [], executions: [], bindings: [] })),
  } as unknown as ThreadExportOwners['runtime'];
  return { runtime };
}
async function collect(stream: AsyncIterable<Uint8Array>) { let text = ''; for await (const chunk of stream) text += Buffer.from(chunk).toString(); return text; }

describe('conversation export', () => {
  it('pins pages, reads chronological bodies lazily, and excludes private outer state', async () => {
    const owners = fixture(); const stream = exportThreadConversation(owners, selection);
    await stream.next();
    expect(owners.runtime.historyItem).not.toHaveBeenCalled();
    const prefix = '{"version":2,"selection":'+JSON.stringify({threadId:'thread:1',branchId:'branch:1',headId:'item:3',firstItemId:null,lastItemId:'item:3'})+',"messages":[';
    const text = prefix + await collect(stream), parsed = JSON.parse(text);
    expect(parsed.messages.map((value: { text: string }) => value.text)).toEqual(['message 1', 'message 2', 'message 3']);
    expect(text).not.toContain('provider-secret'); expect(text).not.toContain('credentials');
    expect(owners.runtime.historyPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ headId: 'item:3', beforeId: 'item:2' }), undefined);
  });
  it('exports original user text, including an empty original, instead of Host augmentation', async () => {
    const owners = fixture([item(1, 'user', { userText: 'Read @task', text: 'Read @task\ninternal locator and resource context' }),
      item(2, 'user', { userText: '', text: 'internal attachment context' }), item(3)]);
    const text = await collect(exportThreadConversation(owners, selection));
    expect(JSON.parse(text).messages.map((value: { text: string }) => value.text)).toEqual(['Read @task', '', 'message 3']);
    expect(text).not.toContain('internal');
  });
  it('validates inclusive range membership before producing bytes or loading history bodies', async () => {
    const owners = fixture();
    const parsed = JSON.parse(await collect(exportThreadConversation(owners, { ...selection, firstItemId: 'item:2', lastItemId: 'item:2' })));
    expect(parsed.messages.map((value: { id: string }) => value.id)).toEqual(['item:2']);
    const missing = fixture();
    await expect(exportThreadConversation(missing, { ...selection, firstItemId: 'not-on-branch' }).next()).rejects.toThrow('pinned history');
    expect(missing.runtime.historyItem).not.toHaveBeenCalled();
  });
  it('streams attachments across non-base64-aligned chunks and retains message/name association', async () => {
    const attachment = { ref: 'attachment:file', filename: 'notes [final].txt', mimeType: 'text/plain', byteLength: 6 };
    const owners = { ...fixture([item(3, 'user', { text: 'file', fileAttachments: [attachment] })]), attachments: { read: vi.fn(async () => ({ attachment, stream: (async function* () { yield Buffer.from('a'); yield Buffer.from('bcde'); yield Buffer.from('f'); })() })) } };
    const parsed = JSON.parse(await collect(exportThreadConversation(owners, { ...selection, includeAttachments: true })));
    expect(parsed.messages[0].attachments[0]).toEqual({ filename: attachment.filename, mimeType: 'text/plain', byteLength: 6, attachment, dataBase64: Buffer.from('abcdef').toString('base64') });
    expect(owners.attachments.read).toHaveBeenCalledWith(expect.objectContaining(identity), attachment.ref, undefined);
  });
  it('never exports provider-only/compaction records and only includes requested tool semantics', () => {
    expect(exportPublicMessage(item(1, 'assistant', { content: { kind: 'provider_only' }, opaque: 'secret' }), true)).toBeNull();
    expect(exportPublicMessage(item(1, 'compaction', { text: 'checkpoint' }), true)).toBeNull();
    const value = item(1, 'assistant', { content: { kind: 'tool_call', call: { name: 'read', arguments: '{"path":"file"}' } }, opaque: 'secret' });
    expect(exportPublicMessage(value, false)).toBeNull();
    expect(exportPublicMessage(value, true)?.details).toEqual({ name: 'read', arguments: '{"path":"file"}' });
  });
  it('aborts without reading further message bodies', async () => {
    const owners = fixture(), abort = new AbortController(), stream = exportThreadConversation(owners, selection, abort.signal);
    await stream.next(); abort.abort(); await expect(stream.next()).rejects.toThrow(); expect(owners.runtime.historyItem).not.toHaveBeenCalled();
  });
});

it('exports assistant controls readably in Markdown while JSON, user, tool and reasoning stay raw', async () => {
  const fence = '```varin-ui\n{"type":"choice","label":"Hair","options":["Short","Long"],"action":"Continue"}\n```';
  const body = `Before\n\n${fence}\n\nAfter`;
  const owners = fixture([item(1, 'user', { text: fence }), item(2, 'assistant', { content: { kind: 'text', text: body } }),
    item(3, 'assistant', { content: { kind: 'output', output: { parts: [{ kind: 'text', text: body }] } } })]);
  const markdown = await collect(exportThreadConversation(owners, { ...selection, format: 'markdown' }));
  expect(markdown).toContain(`## user\n\n${fence}`);
  expect(markdown.split('## assistant')[1]).toContain('Before\n\nContinue\n\nHair：\n- Short\n- Long\n\nAfter');
  expect(markdown.split('## assistant')[2]).not.toContain('varin-ui');
  const json = JSON.parse(await collect(exportThreadConversation(owners, selection)));
  expect(json.messages.map((value: { text: string }) => value.text)).toEqual([fence, body, body]);
  expect(exportPublicMessage(item(4, 'tool', { content: { kind: 'output', output: { parts: [{ kind: 'text', text: fence }] } } }), true, 'markdown')?.text).toBe(fence);
  expect(exportPublicMessage(item(5, 'assistant', { content: { kind: 'reasoning_summary', text: fence } }), true, 'markdown')?.text).toBe(fence);
});

it('keeps invalid and outer-fenced examples intact and never joins separate native parts into a live fence', () => {
  const invalid = '```varin-ui\n{"type":"unknown"}\n```';
  const example = '````markdown\n```varin-ui\n{"type":"choice","options":["A"]}\n```\n````';
  const text = `${invalid}\n\n${example}`;
  expect(exportPublicMessage(item(1, 'assistant', { content: { kind: 'text', text } }), false, 'markdown')?.text).toBe(text);
  const output = { content: { kind: 'output', output: { parts: [{ kind: 'text', text: '```varin-ui\n{"type":"choice","options":["A"]}' }, { kind: 'text', text: '```' }] } } };
  expect(exportPublicMessage(item(1, 'assistant', output), false, 'markdown')?.text).toContain('varin-ui');
});


it('exports only emitted JSON items and keeps original receipts beside typed reference associations', async () => {
  const call = { id: 'call:original', name: 'read', arguments: '{"path":"file:7"}' };
  const raw = { path: '/source/original.txt', readVersion: 'original-version' };
  const modelData = { ref: 'file:7', content: 'selected content' };
  const items = [
    item(1, 'user', { text: 'visible text includes file:999 but is never parsed for mappings' }),
    item(2, 'assistant', { content: { kind: 'tool_call', call } }),
    item(3, 'tool', { content: { kind: 'tool_result', result: { completion: { kind: 'result', content: { data: raw, model_data: modelData, parts: [] } } } } }),
  ];
  const owners = fixture(items);
  const snapshot = { spaceId: 'original-space', references: [{ reference: 'file:7', spaceId: 'original-space', kind: 'file' as const, owner: 'original-owner', target: raw }], executions: [], bindings: [{ itemId: 'item:2', operationId: 'op:original', purpose: 'read-file', original: call.arguments, target: raw }] };
  vi.mocked(owners.runtime.exportModelReferences).mockResolvedValue(snapshot);
  const full = JSON.parse(await collect(exportThreadConversation(owners, { ...selection, includeTools: true })));
  expect(full.version).toBe(2);
  expect(full.messages[1].details).toEqual(call);
  expect(full.messages[2]).toMatchObject({ details: { data: raw }, modelData });
  expect(full.modelReferences).toEqual(snapshot);
  expect(owners.runtime.exportModelReferences).toHaveBeenLastCalledWith({ threadId: identity.threadId, branchId: identity.branchId, headId: selection.headId, itemIds: ['item:1', 'item:2', 'item:3'], includeTools: true }, undefined);
  await collect(exportThreadConversation(owners, selection));
  expect(owners.runtime.exportModelReferences).toHaveBeenLastCalledWith(expect.objectContaining({ itemIds: ['item:1'], includeTools: false }), undefined);
  await collect(exportThreadConversation(owners, { ...selection, firstItemId: 'item:3', lastItemId: 'item:3', includeTools: true }));
  expect(owners.runtime.exportModelReferences).toHaveBeenLastCalledWith(expect.objectContaining({ itemIds: ['item:3'], includeTools: true }), undefined);
  owners.runtime.exportModelReferences = vi.fn();
  await collect(exportThreadConversation(owners, { ...selection, format: 'markdown' }));
  expect(owners.runtime.exportModelReferences).not.toHaveBeenCalled();
});

it('preserves the typed original attachment descriptor without reading bytes, and excludes hidden output metadata', async () => {
  const attachment = { ref: 'attachment:immutable', modelRef: 'file:8', filename: 'original.txt', mimeType: 'text/plain', byteLength: 5 };
  const owners = fixture([item(3, 'assistant', { content: { kind: 'output', output: { data: { internal: 'original' }, model_data: { ref: 'settings:9' }, parts: [{ kind: 'attachment', attachment }] } } })]);
  const parsed = JSON.parse(await collect(exportThreadConversation(owners, selection)));
  expect(parsed.messages[0].attachments[0]).toMatchObject({ attachment });
  expect(parsed.messages[0]).not.toHaveProperty('details');
  expect(parsed.messages[0]).not.toHaveProperty('modelData');
  expect(owners.runtime.exportModelReferences).toHaveBeenCalledWith(expect.objectContaining({ itemIds: ['item:3'], includeTools: false }), undefined);
  expect(owners.runtime.mediaRead).not.toHaveBeenCalled();
});
