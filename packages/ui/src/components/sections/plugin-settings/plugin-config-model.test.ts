import { describe, expect, test } from 'vitest';
import {
  asJsonObject,
  hasJsonPath,
  invalidCommandWords,
  normalizeCommandWords,
  parseJsoncObject,
  readJsonPath,
  removeJsoncPath,
  removeJsonPath,
  setJsonPath,
  updateJsoncPath,
} from './plugin-config-model';

describe('plugin config model', () => {
  test('updates one nested field without dropping unknown plugin fields', () => {
    const source = {
      futureField: { enabled: true },
      watchdog: { enabled: false, futureMode: 'strict' },
    };
    const updated = setJsonPath(source, ['watchdog', 'enabled'], true);

    expect(readJsonPath(updated, ['watchdog', 'enabled'])).toBe(true);
    expect(readJsonPath(updated, ['watchdog', 'futureMode'])).toBe('strict');
    expect(readJsonPath(updated, ['futureField', 'enabled'])).toBe(true);
    expect(source.watchdog.enabled).toBe(false);
  });

  test('removes empty parent objects while keeping siblings', () => {
    const source = { agent: { model: 'provider/model' }, untouched: 1 };
    const updated = removeJsonPath(source, ['agent', 'model']);

    expect(updated).toEqual({ untouched: 1 });
    expect(hasJsonPath(updated, ['agent', 'model'])).toBe(false);
  });

  test('patches JSONC while preserving comments and unknown fields', () => {
    const source = '{\n  // retained\n  "historian": { "model": "old", "future": true }\n}\n';
    const updated = updateJsoncPath(source, ['historian', 'model'], 'new');
    const parsed = parseJsoncObject(updated);

    expect(updated).toContain('// retained');
    expect(asJsonObject(parsed.historian).future).toBe(true);
    expect(asJsonObject(parsed.historian).model).toBe('new');
  });

  test('removes empty JSONC parents while preserving sibling fields and comments', () => {
    const source = '{\n  "subc": { "connection_file": "connection.json" },\n  "future": {\n    // retained\n    "enabled": true\n  }\n}\n';
    const updated = removeJsoncPath(source, ['subc', 'connection_file']);

    expect(updated).toContain('// retained');
    expect(parseJsoncObject(updated)).toEqual({ future: { enabled: true } });
  });

  test('normalizes and validates pi-wtf command words', () => {
    const words = normalizeCommandWords('fix, rewind\nfix bad/word');
    expect(words).toEqual(['fix', 'rewind', 'bad/word']);
    expect(invalidCommandWords(words)).toEqual(['bad/word']);
  });
});
