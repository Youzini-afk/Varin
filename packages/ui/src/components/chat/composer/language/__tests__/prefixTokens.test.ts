import { describe, expect, test } from 'vitest';

import { filterKnownTokens, scanSlashTokens } from '../prefixTokens';

describe('slash invocations', () => {
    test('recognizes command and namespaced skill names at word boundaries', () => {
        const text = '/review then /My_Skill\n/skill:workspace-check /a1 /workspace-review';
        const tokens = scanSlashTokens(text);
        expect(tokens.map((token) => text.slice(token.start, token.end))).toEqual([
            '/review', '/My_Skill', '/skill:workspace-check', '/a1', '/workspace-review',
        ]);
    });

    test('leaves path separators and incomplete names alone', () => {
        expect(scanSlashTokens('src/components/App.tsx a/b / /-dash /_under')).toEqual([]);
    });

    test('only registered names are references, independent of typed casing', () => {
        const tokens = scanSlashTokens('/Review /unknown /plan');
        expect(filterKnownTokens(tokens, new Set(['review', 'plan'])).map((token) => token.name))
            .toEqual(['Review', 'plan']);
        expect(filterKnownTokens(tokens, new Set())).toEqual([]);
    });
});
