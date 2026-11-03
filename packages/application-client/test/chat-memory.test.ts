import assert from 'node:assert/strict';
import test from 'node:test';
import { threadMemorySourceText } from '../src/chat-memory.js';

test('memory and handoff source selection uses original public user text', () => {
  assert.equal(threadMemorySourceText({ source: 'user', content: { userText: 'Read @task', text: 'Read @task\ninternal locator and resource context' } }), 'Read @task');
  assert.equal(threadMemorySourceText({ source: 'user', content: { userText: '', text: 'internal attachment context' } }), '');
  assert.equal(threadMemorySourceText({ source: 'user', content: { text: 'legacy user text' } }), 'legacy user text');
  assert.equal(threadMemorySourceText({ source: 'user', content: 'plain user text' }), 'plain user text');
});
