export interface CitationRange {
    start: number;
    end: number;
}

const normalizeFilenameKey = (filename: string): string => filename.trim().toLowerCase();

export const findAttachmentCitationRanges = (text: string, filenames: string[]): CitationRange[] => {
    if (!text || !text.includes('[') || filenames.length === 0) {
        return [];
    }

    const known = new Set(filenames.map(normalizeFilenameKey));
    const ranges: CitationRange[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('[', cursor);
        if (start === -1) {
            break;
        }

        const end = text.indexOf(']', start + 1);
        if (end === -1) {
            break;
        }

        // Markdown links keep their normal link highlighting; attachment citations
        // are plain bracket references like [desktop.png].
        if (text[end + 1] !== '(') {
            const name = text.slice(start + 1, end).trim();
            if (known.has(normalizeFilenameKey(name))) {
                ranges.push({ start, end: end + 1 });
            }
        }

        cursor = end + 1;
    }

    return ranges;
};
