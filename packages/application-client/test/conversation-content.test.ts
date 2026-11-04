import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConversationContent, normalizeConversationUi, conversationUiText, migrateConversationUiState, createConversationContentParser } from '../src/conversation-content.js';
const definition = { type: 'choice', label: '发型', options: ['短发', '长发'], action: '继续设计' };
const fence = (value: unknown) => '```varin-ui\n' + JSON.stringify(value) + '\n```\n';

test('only assistant top-level dedicated fences activate; outer examples, quotes and user content stay opaque', () => {
  const text = 'Before\n\n' + fence(definition) + '\nAfter';
  const parts = parseConversationContent(text, { role: 'assistant' });
  assert.deepEqual(parts.map(p => p.kind), ['markdown', 'ui', 'markdown']);
  const ui = parts[1]!; assert.equal(ui.kind, 'ui'); if (ui.kind !== 'ui') return;
  assert.equal(ui.fragmentKey, 'offset:8'); assert.equal(ui.raw, fence(definition));
  assert.equal(conversationUiText(ui.node, { root: 'label:长发' }), '继续设计\n\n发型：长发');
  for (const role of ['user', 'tool', 'system']) assert.equal(parseConversationContent(text, { role }).length, 1);
  for (const wrapped of ['````markdown\n' + text + '\n````', text.split('\n').map(line => '> ' + line).join('\n'), fence(definition).split('\n').map(line => '    ' + line).join('\n')]) {
    assert.equal(parseConversationContent(wrapped, { role: 'assistant' }).every(p => p.kind === 'markdown'), true);
  }
});
test('streamed incomplete JSON stays hidden, interrupted/invalid/unknown definitions preserve exact raw fallback', () => {
  const partial = 'hello\n```varin-ui\n{"type":"choice"';
  assert.equal(parseConversationContent(partial, { role: 'assistant', streaming: true }).at(-1)?.kind, 'pending');
  const interrupted = parseConversationContent(partial, { role: 'assistant' }).at(-1)!;
  assert.equal(interrupted.kind, 'invalid');
  for (const raw of ['```varin-ui\nnot JSON\n```\n', fence({ type: 'future', label: 'Still readable' }), fence({ ...definition, options: ['same', 'same'] })]) {
    const part = parseConversationContent(raw, { role: 'assistant' })[0]!;
    assert.equal(part.kind, 'invalid'); if (part.kind === 'invalid') assert.equal(part.raw, raw);
  }
});
test('stable keys and local migration preserve reorder, reject changed meaning, and preserve independent fields', () => {
  const old = normalizeConversationUi({ type: 'form', fields: [definition, { type: 'input', label: '预算', inputType: 'number', unit: '元' }] });
  const next = normalizeConversationUi({ type: 'form', fields: [{ ...definition, options: ['新选项', '长发', '短发'] }, { type: 'input', label: '预算', inputType: 'number', unit: '元' }] });
  const values = { 'label:发型': 'label:长发', 'label:预算': 42 };
  assert.deepEqual({ ...migrateConversationUiState(old, next, values).values }, values);
  const removed = normalizeConversationUi({ type: 'form', fields: [{ ...definition, options: ['短发'] }, { type: 'input', label: '预算', inputType: 'number', unit: '元' }] });
  const migration = migrateConversationUiState(old, removed, values);
  assert.deepEqual(migration.resetKeys, ['label:发型']); assert.equal(migration.values['label:预算'], 42);
  assert.match(conversationUiText(next, values), /预算：42 元/);
});
test('append parser reuses completed node instances and detects changed source', () => {
  const parse = createConversationContentParser(), first = parse(fence(definition), { role: 'assistant', streaming: true });
  const second = parse(fence(definition) + '\nmore text\n', { role: 'assistant', streaming: true });
  assert.equal(first[0], second[0]);
  const changed = parse('intro\n' + fence(definition), { role: 'assistant' });
  assert.equal(changed[1]?.start, 6);
});
test('normalizes explicit form keys, native references, local views and browser inputs without executable code', () => {
  for (const value of [{ type: 'input', inputType: 'date' }, { type: 'disclosure', content: 'Detail' }, { type: 'tabs', tabs: [{ label: 'A', content: 'Body' }] }, { type: 'embed', ref: 'ui:work@2' }, { type: 'object', ref: 'thread:actual' }]) assert.equal(normalizeConversationUi(value).type, value.type);
  assert.throws(() => normalizeConversationUi({ type: 'embed', ref: 'ui:work' }), /fixed/);
  assert.throws(() => normalizeConversationUi({ ...definition, action: { type: 'script', label: 'Send' } }), /Unknown action/);
  assert.throws(() => normalizeConversationUi({ type: 'input', inputType: 'password' }), /Unknown input/);
});

test('raw HTML/comment examples stay opaque and complete content following them is recognized', () => {
  for (const [open, close] of [['<!--', '-->'], ['<pre>', '</pre>'], ['<div>', '</div>\n'], ['<?example', '?>']]) {
    const example = open + '\n' + fence(definition) + close + '\n\n';
    const parts = parseConversationContent(example + fence(definition), { role: 'assistant' });
    assert.equal(parts.filter(part => part.kind === 'ui').length, 1);
    assert.equal(parts.at(-1)?.start, example.length);
  }
});

test('free text and multiple selections preserve actual expression; changed units reset numeric interpretation', () => {
  const choice = normalizeConversationUi({ ...definition, multiple: true, allowOther: true });
  assert.equal(conversationUiText(choice, { root: ['label:短发'], 'root:other': '我想保留刘海\n不要太短' }), '继续设计\n\n发型：短发、我想保留刘海\n不要太短');
  const before = normalizeConversationUi({ type: 'input', label: '距离', inputType: 'number', unit: 'km' });
  const after = normalizeConversationUi({ type: 'input', label: '距离', inputType: 'number', unit: 'm' });
  assert.deepEqual(migrateConversationUiState(before, after, { root: 10 }).resetKeys, ['root']);
});

test('a closing marker at the token frontier is not cached before its line is complete', () => {
  const parse = createConversationContentParser(), initial = fence(definition).trimEnd();
  assert.equal(parse(initial, { role: 'assistant', streaming: true })[0]?.kind, 'ui');
  assert.equal(parse(initial + 'still part of code', { role: 'assistant', streaming: true })[0]?.kind, 'pending');
});

test('migration preserves surviving multiple choices, standalone other text and in-progress browser numeric text', () => {
  const before = normalizeConversationUi({ ...definition, multiple: true, allowOther: true });
  const after = normalizeConversationUi({ ...definition, multiple: true, allowOther: true, options: ['短发'] });
  const migrated = migrateConversationUiState(before, after, { root: ['label:短发', 'label:长发'], 'root:other': '自选' });
  assert.deepEqual(migrated.values.root, ['label:短发']); assert.equal(migrated.values['root:other'], '自选'); assert.deepEqual(migrated.resetKeys, ['root']);
  assert.equal(migrateConversationUiState(before, after, { 'root:other': '只有自由表达' }).values['root:other'], '只有自由表达');
  const number = normalizeConversationUi({ type: 'input', inputType: 'number', min: 0 });
  assert.equal(migrateConversationUiState(number, number, { root: '0.50' }).values.root, '0.50');
  assert.equal(migrateConversationUiState(number, number, { root: '' }).values.root, '');
});

test('projects readable assistant copy without inventing selected values or altering other roles', async () => {
  const { conversationContentText } = await import('../src/conversation-content.js');
  const fence = '```varin-ui\n{"type":"choice","label":"Hair","options":["Short","Long"],"action":"Continue"}\n```';
  assert.equal(conversationContentText(fence, { role: 'assistant' }), 'Continue\n\nHair：\n- Short\n- Long');
  assert.equal(conversationContentText(fence, { role: 'user' }), fence);
  assert.equal(conversationContentText(fence, { role: 'tool' }), fence);
  assert.equal(conversationContentText('```varin-ui\n{"type":', { role: 'assistant', streaming: true }), '```varin-ui\n{"type":');
});

test('retains a complete frontier definition through unchanged repaints and durable commit', () => {
  const parse = createConversationContentParser(), text = fence(definition).trimEnd();
  const initial = parse(text, { role: 'assistant', streaming: true });
  assert.equal(parse(text, { role: 'assistant', streaming: true })[0], initial[0]);
  assert.equal(parse(text, { role: 'assistant', streaming: false })[0], initial[0]);
  assert.equal(parse(text + 'invalid close suffix', { role: 'assistant', streaming: true })[0]?.kind, 'pending');
});
