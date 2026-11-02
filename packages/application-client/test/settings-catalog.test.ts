import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_CATALOG, getSettingsCatalogEntry, querySettingsCatalog } from '../src/settings-catalog.js';

test('every structured setting publishes its accepted shape and search includes owner guidance', () => {
  const structured = SETTINGS_CATALOG.flatMap(entry => [entry.field, ...(entry.fields ?? [])].filter(Boolean));
  for (const field of structured) if (field!.kind === 'json') assert.ok(field!.schema, `Missing schema for ${field!.path}`);
  assert.ok(querySettingsCatalog({ query: 'safe request boundaries' }).some(entry => entry.id === 'self.bot-profile'));
  assert.ok(querySettingsCatalog({ query: 'modelOverrides' }).some(entry => entry.id === 'harness.compaction'));
});

test('self, future defaults and project defaults retain distinct owner targets', () => {
  assert.equal(getSettingsCatalogEntry('self.bot-profile')?.actionRef?.domain, 'service:self-bot');
  assert.equal(getSettingsCatalogEntry('self.conversation-model')?.actionRef?.domain, 'service:self-conversation');
  assert.equal(getSettingsCatalogEntry('sessions.default-model')?.owner, 'agent-settings');
  const project = getSettingsCatalogEntry('projects.default-model')!;
  assert.equal(project.owner, 'agent-settings'); assert.equal(project.scope, 'project');
  assert.deepEqual(project.fields?.map(field => field.path), ['defaultProvider', 'defaultModel', 'defaultThinkingLevel']);
  assert.equal(project.actionRef, undefined);
});

test('legacy settings without a current execution consumer remain inspectable, not fake operating controls', () => {
  for (const id of ['harness.context.compactionRecovery', 'harness.models.permissionJudge', 'harness.dispatch', 'harness.worktree',
    'projects.worktree', 'projects.worktree.setup.wait', 'chat.server-permission-auto-accept']) {
    const entry = getSettingsCatalogEntry(id)!;
    assert.equal(entry.writable, false, id); assert.equal(entry.apply, 'unsupported', id);
  }
  const documents = getSettingsCatalogEntry('harness.document-reading')!.fields!;
  assert.equal(documents.find(field => field.path.endsWith('ocrLanguage'))?.authority, undefined);
  assert.equal(documents.find(field => field.path.endsWith('doclingCommand'))?.authority, 'permissions');
  assert.equal(getSettingsCatalogEntry('voice.speech-recognition')?.fields?.find(field => field.path === 'sttServerUrl')?.authority, 'permissions');
});
