import { describe, expect, test } from 'vitest';

import { getApplyPatchFileEntries } from './toolDiffUtils';

describe('toolDiffUtils', () => {
    test('reads every recorded apply_patch change and opens move destinations', () => {
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
});
