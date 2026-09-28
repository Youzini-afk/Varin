import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUpdates, renderReport } from './dependabot-report.mjs';

const pr = (body) => ({ body, number: 1, html_url: 'https://github.com/example/repo/pull/1', head: { sha: 'abc123' } });
const notes = '<details><summary>Release notes</summary><blockquote><h2>Breaking Changes</h2><ul><li>Removed oldHook; use newHook.</li></ul></blockquote></details>';

test('keeps every grouped version even when notes are truncated midway', () => {
  const body = '| Package | From | To |\n| --- | --- | --- |\n| [first](https://github.com/example/first) | `1.0.0` | `2.0.0` |\n| second | `0.1.0` | `0.2.0` |\n\nUpdates `first` from 1.0.0 to 2.0.0\n' + notes + '\n_Description has been truncated_';
  const report = renderReport(pr(body), [], 'https://github.com/example/repo/actions/runs/1');
  assert.deepEqual(report.updates.map(({ name, from, to }) => ({ name, from, to })), [
    { name: 'first', from: '1.0.0', to: '2.0.0' }, { name: 'second', from: '0.1.0', to: '0.2.0' },
  ]);
  assert.match(report.comment, /0.x 次版本/);
  assert.match(report.comment, /没有可提取的发布说明/);
  assert.match(report.comment, /正文已被截断/);
});

test('recognizes a single-package bump and preserves the full target version', () => {
  assert.deepEqual(parseUpdates('Bumps [undici](https://github.com/nodejs/undici) from 7.29.1 to 8.11.2.\n')[0], {
    name: 'undici', from: '7.29.1', to: '8.11.2', section: 'Bumps [undici](https://github.com/nodejs/undici) from 7.29.1 to 8.11.2.\n',
  });
});

test('deduplicates shared release notes without losing either dependency range', () => {
  const report = renderReport(pr(`Updates \`core\` from 1.0.0 to 2.0.0\n${notes}\nUpdates \`agent\` from 1.0.0 to 2.0.0\n${notes}`), [], 'https://example.com/run');
  assert.equal(report.markdown.match(/Removed oldHook/g).length, 1);
  assert.match(report.markdown, /core 1.0.0 → 2.0.0/);
  assert.match(report.markdown, /agent 1.0.0 → 2.0.0/);
  assert.match(report.comment, /原文包含破坏性变更/);
});

test('escapes upstream markup and deactivates mentions in report excerpts', () => {
  const report = renderReport(pr('Updates `lib` from 1.0.0 to 1.0.1\n<details><summary>Changelog</summary><blockquote><li>&lt;script&gt;alert(1)&lt;/script&gt; @someone</li></blockquote></details>'), [], 'https://example.com/run');
  assert.doesNotMatch(report.comment, /<script>|@someone/);
  assert.match(report.comment, /&lt;script&gt;/);
});
