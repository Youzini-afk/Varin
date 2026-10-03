import { describe, expect, test } from 'vitest';

import { prepareUserMarkdownContent } from './userTextPartContent';

describe('prepareUserMarkdownContent', () => {
    test('keeps fenced code < and -> unescaped for the markdown renderer', () => {
        const content = prepareUserMarkdownContent({
            textContent: '```rust\nlet values: Vec<i32> = vec![];\nlet next = old -> new;\n```',
            skillInvocations: new Set(),
        });

        expect(content).toContain('Vec<i32>');
        expect(content).toContain('old -> new');
        expect(content).not.toContain('&lt;');
        expect(content).not.toContain('-&gt;');
    });

    test('escapes raw HTML outside fences so tags display as text', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'Use <b>bold</b> and <script>alert("x")</script>',
            skillInvocations: new Set(),
        });

        expect(content).toContain('&lt;b&gt;bold&lt;/b&gt;');
        expect(content).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
        expect(content).not.toContain('<b>bold</b>');
        expect(content).not.toContain('<script>');
    });

    test('adds hard line breaks outside fences but not inside', () => {
        const content = prepareUserMarkdownContent({
            textContent: 'first\nsecond\n```ts\nconst x = 1\nconst y = 2\n```\nthird',
            skillInvocations: new Set(),
        });

        expect(content).toContain('first  \nsecond  \n```ts\n');
        expect(content).toContain('const x = 1\nconst y = 2\n```  \nthird');
        expect(content).not.toContain('const x = 1  \nconst y = 2');
    });

    test('preserves mention conversion', () => {
        const content = prepareUserMarkdownContent({
            textContent: '@agent hello\n/skill:skill-name',
            agentMention: { name: 'build-agent', token: '@agent' },
            skillInvocations: new Set(['skill:skill-name']),
        });

        expect(content).toContain('[@agent](#varin-agent:build-agent)');
        expect(content).toContain('[/skill:skill-name](#varin-skill:skill-name)');
        expect(content).toContain('hello  \n[/skill:skill-name]');
    });

    test('does not turn legacy bare slash aliases into Pi skill links', () => {
        const content = prepareUserMarkdownContent({
            textContent: '/skill-name /skill:skill-name',
            skillInvocations: new Set(['skill:skill-name']),
        });

        expect(content).toContain('/skill-name');
        expect(content).not.toContain('[/skill-name]');
        expect(content).toContain('[/skill:skill-name](#varin-skill:skill-name)');
    });
});
