import { describe, expect, test } from 'vitest';

import { getApplyPatchFileEntries, getDiffPatchEntries, getRenderablePatchInfo } from './toolDiffUtils';

const identity = (path: string) => path;

describe('toolDiffUtils', () => {
    test('reads every Pi apply_patch change and opens move destinations', () => {
        expect(getApplyPatchFileEntries({
            changes: [
                { kind: 'update', path: 'src/old.ts', moveTo: 'src/new.ts', displayDiff: '@@ -1 +1 @@\n-old\n+new' },
                { kind: 'add', path: 'src/added.ts', displayDiff: '@@ -0,0 +1 @@\n+new' },
                { kind: 'delete', path: 'src/deleted.ts', displayDiff: '@@ -1 +0,0 @@\n-old' },
            ],
        })).toEqual([
            { deleted: false, filePath: 'src/new.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
            { deleted: false, filePath: 'src/added.ts', patch: '@@ -0,0 +1 @@\n+new' },
            { deleted: true, filePath: 'src/deleted.ts', patch: '@@ -1 +0,0 @@\n-old' },
        ]);
    });

    test('renders raw apply_patch add-file envelopes as visual diffs', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Add File: src/app.ts',
            '+const value = 1;',
            '+export default value;',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/app.ts');
        expect(entries[0]?.patch).toContain('--- /dev/null');
        expect(entries[0]?.patch).toContain('+++ b/src/app.ts');
        expect(entries[0]?.patch).toContain('+const value = 1;');
        expect(entries[0]?.patch).not.toContain('*** Begin Patch');
    });

    test('renders raw apply_patch update envelopes with synthetic hunks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Update File: src/app.ts',
            '@@',
            ' const keep = true;',
            '-const value = 1;',
            '+const value = 2;',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/app.ts');
        expect(entries[0]?.patch).toContain('--- a/src/app.ts');
        expect(entries[0]?.patch).toContain('+++ b/src/app.ts');
        expect(entries[0]?.patch).toContain('@@ -1,2 +1,2 @@');
        expect(entries[0]?.patch).not.toContain('*** End Patch');
    });

    test('splits multi-file apply_patch envelopes into visual diff entries', () => {
        const entries = getDiffPatchEntries(undefined, [
            '*** Begin Patch',
            '*** Add File: src/a.ts',
            '+export const a = 1;',
            '*** Update File: src/b.ts',
            '@@',
            '-export const b = 1;',
            '+export const b = 2;',
            '*** End Patch',
        ].join('\n'), identity);

        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.renderMode)).toEqual(['diff', 'diff']);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('splits multi-file unified patches into one renderable entry per file', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '@@ -1 +1 @@',
            '-left',
            '+right',
        ].join('\n'), identity);

        expect(entries.map((entry) => entry.renderMode)).toEqual(['diff', 'diff']);
        expect(entries.map((entry) => entry.title)).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('uses metadata.files patches before top-level fallback diffs', () => {
        const entries = getDiffPatchEntries({
            files: [{
                relativePath: 'src/file.ts',
                patch: [
                    '--- a/src/file.ts',
                    '+++ b/src/file.ts',
                    '@@ -1 +1 @@',
                    '-old',
                    '+new',
                ].join('\n'),
            }],
        }, 'not a diff', identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(entries[0]?.title).toBe('src/file.ts');
    });

    test('synthesizes headers for valid headerless hunks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('diff');
        expect(getRenderablePatchInfo(entries[0]?.patch ?? '')).not.toBeNull();
    });

    test('keeps malformed unified patches as text fallbacks', () => {
        const entries = getDiffPatchEntries(undefined, [
            '--- a/src/file.ts',
            '+++ b/src/file.ts',
            '@@',
            '-old',
            '+new',
        ].join('\n'), identity);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.renderMode).toBe('text');
        expect(entries[0]?.patch).toContain('@@');
    });
});
