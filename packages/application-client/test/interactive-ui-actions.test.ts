import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUiHostActions } from '../src/interactive-ui.js';

test('host action admission preserves readable intent without carrying script callbacks or implicit send capabilities', () => {
  assert.deepEqual(normalizeUiHostActions([{ key: 'continue', type: 'send', label: '发送', text: '按这些参数继续', onclick: 'sendEverything()' }]), [{ key: 'continue', type: 'send', label: '发送', text: '按这些参数继续' }]);
  assert.deepEqual(normalizeUiHostActions([]), []);
  for (const invalid of [
    [{ key: 'x', type: 'send', label: '发送' }],
    [{ key: 'x', type: 'open', label: '打开' }],
    [{ key: 'x', type: 'script', label: '运行', text: 'run()' }],
    [{ key: 'x', type: 'reference', label: '引用', includeContext: 'yes' }],
    [{ key: 'x', type: 'copy', label: '复制', text: 'result' }, { key: 'x', type: 'copy', label: '复制', text: 'other' }],
  ]) assert.throws(() => normalizeUiHostActions(invalid));
});
