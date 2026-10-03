import { describe, expect, test } from 'vitest';
import { commandMatchesSearch } from '../commandAutocompleteItems';

describe('Pi command autocomplete search', () => {
  test('matches command names and descriptions', () => {
    const command = {
      description: 'Review the active workspace',
      name: 'workspace-review',
    };
    expect(commandMatchesSearch(command, 'workspace')).toBe(true);
    expect(commandMatchesSearch(command, 'active work')).toBe(true);
    expect(commandMatchesSearch(command, 'deploy')).toBe(false);
  });

  test('matches aliases supplied by Pi command metadata', () => {
    expect(commandMatchesSearch({
      name: 'checkpoint',
      searchAliases: ['snapshot', 'recovery point'],
    }, 'recover')).toBe(true);
  });
});
