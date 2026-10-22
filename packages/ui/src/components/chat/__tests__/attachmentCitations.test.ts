import { describe, expect, test } from 'vitest';

import { findAttachmentCitationRanges } from '../attachmentCitations';

describe('attachment citations', () => {
    test('finds active attachment citation ranges', () => {
        expect(findAttachmentCitationRanges(
            'desktop [desktop.jpg] link [desktop.jpg](https://example.com) missing [other.jpg]',
            ['desktop.jpg'],
        )).toEqual([{ start: 8, end: 21 }]);
    });
});
