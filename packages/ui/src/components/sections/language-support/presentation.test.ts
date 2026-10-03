import { describe, expect, test } from 'vitest';
import type { LanguageSupportLanguageRow } from '@varin/application-client';
import {
  canImportGrammar,
  canInstallGrammar,
  formatPackBytes,
  grammarStatusKey,
  grammarStatusTone,
  languageServerStatusKey,
  languageServerStatusTone,
  structureNoteKey,
} from './presentation';

const row = (overrides: Partial<LanguageSupportLanguageRow> = {}): LanguageSupportLanguageRow => ({
  languageId: 'python',
  grammarStatus: 'available',
  capabilities: { outline: false, classifyHits: false, literalCalls: false, imports: false },
  fileCount: 3,
  wanted: false,
  ...overrides,
});

describe('language support presentation', () => {
  test('maps language-server snapshots to settings keys without inventing a new status owner', () => {
    expect(languageServerStatusKey('ready')).toBe('settings.languageSupport.lsp.ready');
    expect(languageServerStatusKey('absent')).toBe('settings.languageSupport.lsp.absent');
    expect(languageServerStatusTone('ready')).toBe('success');
    expect(languageServerStatusTone('failed')).toBe('danger');
  });

  test('maps structure grammar statuses and only offers install for available packs', () => {
    expect(grammarStatusKey('bundled')).toBe('settings.languageSupport.grammar.bundled');
    expect(grammarStatusKey('user-unverified')).toBe('settings.languageSupport.grammar.userUnverified');
    expect(canInstallGrammar('available')).toBe(true);
    expect(canInstallGrammar('bundled')).toBe(false);
    expect(canInstallGrammar('absent')).toBe(false);
    expect(canImportGrammar('absent')).toBe(true);
    expect(canImportGrammar('bundled')).toBe(false);
  });

  test('an installed grammar that produces no outline is not shown as success', () => {
    const inert = { outline: false, classifyHits: false, literalCalls: false, imports: false };
    const working = { outline: true, classifyHits: true, literalCalls: false, imports: false };
    expect(grammarStatusTone('installed', inert)).toBe('warning');
    expect(grammarStatusTone('installed', working)).toBe('success');
    expect(grammarStatusTone('bundled', inert)).toBe('warning');
    expect(structureNoteKey(row({ grammarStatus: 'installed' })))
      .toBe('settings.languageSupport.note.installedWithoutQuery');
    expect(structureNoteKey(row({ grammarStatus: 'installed', capabilities: working }))).toBeNull();
  });

  test('warns before install when the published pack carries no structure query', () => {
    const pack = { abi: 15, bytes: 1024, packageName: 'tree-sitter-toml', version: '0.7.0', providesOutline: false };
    expect(structureNoteKey(row({ pack }))).toBe('settings.languageSupport.note.packWithoutQuery');
    expect(structureNoteKey(row({ pack: { ...pack, providesOutline: true } }))).toBeNull();
  });

  test('an unreadable index is unknown, not absent, and offers no actions', () => {
    expect(grammarStatusKey('unknown')).toBe('settings.languageSupport.grammar.unknown');
    expect(grammarStatusTone('unknown')).toBe('muted');
    expect(canInstallGrammar('unknown')).toBe(false);
    expect(canImportGrammar('unknown')).toBe(false);
    expect(structureNoteKey(row({ grammarStatus: 'unknown' })))
      .toBe('settings.languageSupport.note.storeUnreadable');
  });

  test('formats pack sizes so a multi-megabyte download is visible before the click', () => {
    expect(formatPackBytes(5_350_581)).toBe('5.1 MB');
    expect(formatPackBytes(24_040)).toBe('23 KB');
    expect(formatPackBytes(512)).toBe('512 B');
  });
});
