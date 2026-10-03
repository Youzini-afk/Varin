import { describe, expect, test } from 'vitest';
import {
  createPiJsonObjectChanges,
  formatPiJsonObjectDocument,
  parsePiJsonObjectDocument,
} from './json-object-document';

describe('Pi JSON configuration documents', () => {
  test('builds top-level changes without rewriting unrelated plugin settings', () => {
    expect(createPiJsonObjectChanges({
      packages: ['npm:pi-wtf'],
      workspaceHistory: { enabled: 'auto', maxWorkspaces: 10 },
    }, {
      newPlugin: { arbitrary: true },
      workspaceHistory: { enabled: true, maxWorkspaces: 10 },
    })).toEqual({
      remove: ['packages'],
      set: {
        newPlugin: { arbitrary: true },
        workspaceHistory: { enabled: true, maxWorkspaces: 10 },
      },
    });
  });

  test('parses and formats unrestricted JSON objects', () => {
    const config = parsePiJsonObjectDocument('{"plugin":{"items":[1,true,null]}}');
    expect(config).toEqual({ plugin: { items: [1, true, null] } });
    expect(formatPiJsonObjectDocument(config)).toBe(
      '{\n  "plugin": {\n    "items": [\n      1,\n      true,\n      null\n    ]\n  }\n}\n',
    );
    expect(() => parsePiJsonObjectDocument('[]')).toThrow(
      'Pi configuration must contain a JSON object',
    );
  });
});
