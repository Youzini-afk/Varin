/** Slash invocations are recognized at word boundaries, then checked against the registry. */
const SLASH_SCANNER = /(^|\s)\/([A-Za-z0-9][A-Za-z0-9_:-]*)/g;

export interface SlashToken {
    start: number;
    end: number;
    name: string;
}

export function scanSlashTokens(text: string): SlashToken[] {
    if (!text.includes('/')) return [];

    const tokens: SlashToken[] = [];
    SLASH_SCANNER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SLASH_SCANNER.exec(text)) !== null) {
        const name = match[2];
        const start = match.index + match[1].length;
        tokens.push({ start, end: start + 1 + name.length, name });
    }
    return tokens;
}

/** `known` contains lowercased command and skill names. */
export function filterKnownTokens(
    tokens: readonly SlashToken[],
    known: ReadonlySet<string>,
): SlashToken[] {
    return tokens.filter((token) => known.has(token.name.toLowerCase()));
}
