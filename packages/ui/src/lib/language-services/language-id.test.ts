import { afterEach, describe, expect, test } from 'vitest';
import {
  languageIdFromResourceId,
  languageIdsFromResourceId,
  monacoLanguageIdForHostLanguage,
  monacoLanguageIdFromResourceId,
} from './language-id';
import {
  getLanguageDiagnosticsForResource,
  replaceLanguageDiagnostics,
  resetLanguageDiagnostics,
} from './diagnostics-registry';
import { resetWorkbenchPanelsForRuntimeSwitch } from '@/lib/workbench/editors/panels';

afterEach(() => {
  resetLanguageDiagnostics();
  resetWorkbenchPanelsForRuntimeSwitch();
});

test('Monaco tokenization aliases JSX host language identifiers without changing Host IDs', () => {
  expect(monacoLanguageIdForHostLanguage('typescriptreact')).toBe('typescript');
  expect(monacoLanguageIdForHostLanguage('javascriptreact')).toBe('javascript');
  expect(monacoLanguageIdForHostLanguage('shellscript')).toBe('shell');
  expect(monacoLanguageIdForHostLanguage('rust')).toBe('rust');
});

test('resolves one language identity for the Host language view and the editor', () => {
  // A second table made `.sh` two Host sessions and hid `.mts` from the agent.
  expect(languageIdFromResourceId('scripts/build.sh')).toBe('shellscript');
  expect(languageIdFromResourceId('src/entry.mts')).toBe('typescript');
  expect(languageIdFromResourceId('src/entry.cjs')).toBe('javascript');
  expect(languageIdFromResourceId('infra/Dockerfile')).toBe('dockerfile');
  expect(languageIdFromResourceId('Main.java')).toBe('java');
});

test('Monaco tokenization resolves registered filenames, patterns, and longest extensions', () => {
  const definitions = [
    { id: 'dockerfile', filenames: ['Dockerfile'] },
    { id: 'typescript', extensions: ['.ts', '.d.ts'] },
    { id: 'yaml', filenamePatterns: ['*.config.yml'] },
  ];
  expect(monacoLanguageIdFromResourceId('infra/Dockerfile', definitions)).toBe('dockerfile');
  expect(monacoLanguageIdFromResourceId('src/types.d.ts', definitions)).toBe('typescript');
  expect(monacoLanguageIdFromResourceId('build/app.config.yml', definitions)).toBe('yaml');
  expect(languageIdsFromResourceId('src/component.tsx', [{ id: 'typescript', extensions: ['.tsx'] }])).toEqual({
    hostLanguageId: 'typescriptreact',
    monacoLanguageId: 'typescript',
  });
});

describe('language id', () => {
  test('maps known extensions and falls back to plaintext', () => {
    expect(languageIdFromResourceId('src/app.ts')).toBe('typescript');
    expect(languageIdFromResourceId('src/app.py')).toBe('python');
    expect(languageIdFromResourceId('README')).toBe('plaintext');
  });
});

describe('language diagnostics registry', () => {
  test('keeps previous diagnostics when a newer version is stale', () => {
    const accepted = (resourceId: string, documentVersion: number) => (
      resourceId === 'a.ts' && documentVersion === 1
    );
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 1,
      severity: 'error',
      message: 'old',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], accepted);
    replaceLanguageDiagnostics('ws', 'typescript', 'b.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'b.ts' },
      documentVersion: 1,
      severity: 'warning',
      message: 'other',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
    }], () => true);
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 2,
      severity: 'error',
      message: 'new',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], accepted);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts').map((item) => item.message)).toEqual(['old']);
    expect(getLanguageDiagnosticsForResource('ws', 'b.ts').map((item) => item.message)).toEqual(['other']);
  });

  test('clears a resource when the language server publishes an empty diagnostic set', () => {
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 1,
      severity: 'error',
      message: 'gone',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], () => true);
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [], () => true);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts')).toEqual([]);
  });

  test('keeps each unchanged resource snapshot referentially stable for React subscribers', () => {
    const firstEmpty = getLanguageDiagnosticsForResource('ws', 'a.ts');
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts')).toBe(firstEmpty);

    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 1,
      severity: 'warning',
      message: 'stable',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], () => true);
    const populated = getLanguageDiagnosticsForResource('ws', 'a.ts');
    expect(populated).not.toBe(firstEmpty);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts')).toBe(populated);

    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [], () => true);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts')).toBe(firstEmpty);
  });
});
