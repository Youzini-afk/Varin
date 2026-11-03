import assert from 'node:assert/strict';
import test from 'node:test';
import { exportDesktopFrontendEntries, FRONTEND_RECOVERED_DRAFTS_KEY, validateDesktopFrontendStage } from '../src/desktop-frontend-migration.js';
test('migrates explicit UI fields without authentication, unknown store fields or credential-bearing URLs', () => {
  const result = exportDesktopFrontendEntries([
    ['config-store', JSON.stringify({ version: 1, state: { voiceProvider: 'openai', openaiApiKey: 'DO_NOT_EXPORT', openaiCompatibleApiKey: 'DO_NOT_EXPORT_2', sttApiKey: 'DO_NOT_EXPORT_3', openaiCompatibleUrl: 'https://user:password@example.com', browserVoice: 'test', unknown: 'no' } })],
    ['openaiApiKey', 'DO_NOT_EXPORT'], ['varin.uiAuth.trustDevice', 'true'], ['arbitrary-cookie', 'secret'],
    ['varin.ui.v1', JSON.stringify({ state: { theme: 'dark', sidebarWidth: 325, notAPreference: 'no' } })],
    ['varin.companion.association', JSON.stringify({ botId: 'bot-1' })],
    ['varin.editor-workbench.owner', 'documents-owner-1'], ['varin.editor-workbench:/work', JSON.stringify({ version: 1, workspaceId: '/work', state: { activeGroup: 'g1' }, unexpected: 'ignored' })],
    ['varin.integrate.conflict:/work', JSON.stringify({ repoRoot: '/work', remainingCommits: ['abc'], currentCommit: 'abc' })],
  ]);
  assert.deepEqual(JSON.parse(result.entries['config-store']!).state, { browserVoice: 'test', openaiCompatibleUrl: null, voiceProvider: 'openai' });
  assert.equal(JSON.stringify(result).includes('DO_NOT_EXPORT'), false);
  assert.equal(result.credentialSlots.length, 4);
  assert.equal(result.entries['varin.uiAuth.trustDevice'], undefined);
  assert.deepEqual(JSON.parse(result.entries['varin.companion.association']!), { botId: 'bot-1' });
  assert.equal(result.entries['varin.editor-workbench.owner'], 'documents-owner-1');
  assert.deepEqual(JSON.parse(result.entries['varin.editor-workbench:/work']!), { version: 1, workspaceId: '/work', state: { activeGroup: 'g1' } });
  assert.deepEqual(JSON.parse(result.entries['varin.ui.v1']!).state, { theme: 'dark', sidebarWidth: 325 });
});
test('retains queued messages as reviewable drafts and never hydrates auto-send state', () => {
  const payload = exportDesktopFrontendEntries([['varin.messageQueue.v1', JSON.stringify({ state: { followUpBehavior: 'queue', queuedMessages: { 'host\nworkspace\nthread': [{ id: 'q1', content: 'Please review', attachments: [{ filename: 'paper.pdf', grant: 'do-not-copy' }] }] } } })]]);
  assert.equal(payload.pendingDrafts, 1);
  assert.deepEqual(JSON.parse(payload.entries['varin.messageQueue.v1']!).state, { followUpBehavior: 'queue' });
  assert.deepEqual(JSON.parse(payload.entries[FRONTEND_RECOVERED_DRAFTS_KEY]!).drafts[0].message.attachments, [{ filename: 'paper.pdf' }]);
  const stage = { schema: 1, id: 'one', digest: 'a'.repeat(64), sourceOrigin: 'varin-ui://app', sourceVersion: '1', stage: 'staged', payload };
  assert.equal(validateDesktopFrontendStage(stage), stage);
  assert.throws(() => validateDesktopFrontendStage({ ...stage, payload: { ...payload, entries: { ...payload.entries, openaiApiKey: 'secret' } } }));
  assert.throws(() => validateDesktopFrontendStage({ ...stage, payload: { ...payload, credentialSlots: ['arbitrary-secret'] } }));
  assert.throws(() => validateDesktopFrontendStage({ ...stage, payload: { ...payload, pendingDrafts: 0 } }));
  assert.throws(() => validateDesktopFrontendStage({ ...stage, payload: { ...payload, indexedDb: 'completed' } }));
});
