/**
 * Produce highlight ranges for markdown, code, references, paths and attachment citations.
 */

import { findAttachmentCitationRanges } from '../../attachmentCitations';
import { highlightFencedCode } from '../../composerCodeHighlight';
import {
    mentionRangesToHighlightRanges,
    tokenizeMarkdown,
    type HighlightRange,
    type MentionRange,
} from '../../composerHighlight';
import { classifyMention, scanMentions } from './mentions';
import { pathHighlightRanges } from './paths';
import { filterKnownTokens, scanSlashTokens } from './prefixTokens';

/**
 * What the composer knows about its workspace while tokenizing. Every set is
 * authoritative: a token is only a reference if it resolves against one of
 * them, so unknown `/tokens` and `@words` stay plain prose.
 */
export interface ComposerLanguageContext {
    /** Shell mode (`!cmd`) is not the prompt language — nothing is tokenized. */
    inputMode: 'normal' | 'shell';
    /** Lowercased names of the agents that can be mentioned. */
    knownAgentNames: ReadonlySet<string>;
    /** Mention paths confirmed by the picker, a drop, or a restored draft. */
    confirmedMentions: ReadonlySet<string>;
    /** Lowercased command, skill and built-in names invocable with `/`. */
    knownSlashNames: ReadonlySet<string>;
    /** Filenames of the currently attached files, cited inline as `[name]`. */
    attachmentFilenames: readonly string[];
}

/** Mention ranges alone — the composer also needs these to resolve references. */
export function tokenizeMentions(
    text: string,
    context: Pick<ComposerLanguageContext, 'knownAgentNames' | 'confirmedMentions'>,
): MentionRange[] {
    const ranges: MentionRange[] = [];
    for (const token of scanMentions(text)) {
        const kind = classifyMention(token.name, context);
        if (kind) ranges.push({ start: token.start, end: token.end, kind });
    }
    return ranges;
}

/**
 * Every highlight range in `text`. Ranges may overlap; `buildHighlightParts`
 * resolves them by priority.
 */
export function tokenizeComposer(
    text: string,
    context: ComposerLanguageContext,
): HighlightRange[] {
    if (!text || context.inputMode === 'shell') return [];

    const ranges: HighlightRange[] = [
        ...tokenizeMarkdown(text),
        ...highlightFencedCode(text),
        ...mentionRangesToHighlightRanges(tokenizeMentions(text, context)),
        // `~path` is inert: highlighted for the reader, never attached.
        ...pathHighlightRanges(text),
    ];

    for (const token of filterKnownTokens(scanSlashTokens(text), context.knownSlashNames)) {
        ranges.push({ start: token.start, end: token.end, style: 'mentionCommand' });
    }

    if (context.attachmentFilenames.length > 0 && text.includes('[')) {
        for (const range of findAttachmentCitationRanges(text, [...context.attachmentFilenames])) {
            ranges.push({ ...range, style: 'mentionFile' });
        }
    }

    return ranges;
}
