import { describe, expect, test } from 'vitest';
import {
  WEB_ACCESS_RESOLVED_PROVIDERS,
  webAccessCuratorMode,
  webAccessDraftIssue,
  webAccessProviderPath,
  webAccessRoutingMode,
} from './web-access-config-model';

describe('Web Access config model', () => {
  test('models provider precedence and every supported routing shape', () => {
    expect(webAccessRoutingMode({})).toBe('auto');
    expect(webAccessRoutingMode({ provider: 'openai' })).toBe('single');
    expect(webAccessRoutingMode({ provider: ['brave', 'exa'] })).toBe('concurrent');
    expect(webAccessRoutingMode({ provider: 'all' })).toBe('all');
    expect(webAccessRoutingMode({
      searchRouting: { providers: ['openai', 'exa'], fallbackOn: ['network'] },
    })).toBe('fallback');
    expect(webAccessRoutingMode({ provider: 'openai', searchProvider: 'brave' })).toBe('single');
    expect(webAccessProviderPath({ provider: 'openai', searchProvider: 'brave' })).toEqual(['searchProvider']);
  });

  test('models local, derived remote, and explicit curator network settings', () => {
    expect(webAccessCuratorMode({})).toBe('local');
    expect(webAccessCuratorMode({ curatorRemote: false })).toBe('local');
    expect(webAccessCuratorMode({ curatorRemote: true })).toBe('derived');
    expect(webAccessCuratorMode({ curatorRemote: { host: 'pi.example', bind: '10.0.0.2' } })).toBe('custom');
    expect(webAccessCuratorMode({ curatorRemote: 'ignored-by-plugin' })).toBe('local');
  });

  test('validates current routing, tool-name, and credential contracts', () => {
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('parallel-mcp');
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('jina');
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('duckduckgo');
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('xai');
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('brightdata');
    expect(WEB_ACCESS_RESOLVED_PROVIDERS).toContain('serper');
    expect(webAccessDraftIssue({
      futureField: { enabled: true },
      toolNames: { webSearch: 'research_web', futureTool: 'future' },
      braveApiKey: '${BRAVE_KEY}',
      provider: ['parallel-mcp', 'jina', 'duckduckgo', 'xai', 'brightdata', 'serper'],
    })).toBeNull();

    expect(webAccessDraftIssue({ provider: ['openai', 'all'] })).toEqual({
      code: 'invalid-value',
      field: 'provider',
    });
    expect(webAccessDraftIssue({
      searchRouting: { providers: ['openai', 'openai'], fallbackOn: ['network'] },
    })).toEqual({
      code: 'invalid-value',
      field: 'searchRouting.providers',
    });
    expect(webAccessDraftIssue({
      toolNames: { webSearch: 'duplicate', sourceCheck: 'duplicate' },
    })).toEqual({
      code: 'invalid-value',
      field: 'toolNames',
    });
    expect(webAccessDraftIssue({ geminiApiKey: '$BAD-SOURCE' })).toEqual({
      code: 'invalid-value',
      field: 'geminiApiKey',
    });
    expect(webAccessDraftIssue({
      searchRouting: {
        providers: ['openai', 'exa'],
        fallbackOn: ['network', 'invalid-response'],
      },
    })).toBeNull();
  });

  test('validates remote endpoints and security lists without rejecting future keys', () => {
    expect(webAccessDraftIssue({
      firecrawlBaseUrl: 'https://crawl.example.test',
      fetchContent: { domainPolicy: { allow: null, deny: ['private.example.com'] } },
      ssrf: { allowRanges: null, trustEnvProxy: true },
      futureSecurityMode: 'strict',
      braveBaseUrl: 'https://gateway.example.test/brave',
      exaBaseUrl: 'https://gateway.example.test/exa',
      tavilyBaseUrl: 'https://gateway.example.test/tavily',
      openaiSearchProviders: [],
      summaryGenerationDeadlineMs: 45_000,
      maxInlineContentChars: 60_000,
      pdf: { enabled: true, maxPages: 120, maxSizeMB: 40, provider: 'datalab' },
    })).toBeNull();

    expect(webAccessDraftIssue({ searxngBaseUrl: 'ftp://search.example.test' })).toEqual({
      code: 'invalid-value',
      field: 'searxngBaseUrl',
    });
    expect(webAccessDraftIssue({ fetchContent: { domainPolicy: { deny: ['https://example.com'] } } })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent.domainPolicy.deny',
    });
    expect(webAccessDraftIssue({ ssrf: { allowRanges: ['0.0.0.0/0'] } })).toEqual({
      code: 'invalid-value',
      field: 'ssrf.allowRanges',
    });
    expect(webAccessDraftIssue({ fetchContent: 'not-an-object' })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent',
    });
    expect(webAccessDraftIssue({ fetchContent: { domainPolicy: [] } })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent.domainPolicy',
    });
    expect(webAccessDraftIssue({ ssrf: [] })).toEqual({
      code: 'invalid-value',
      field: 'ssrf',
    });
    expect(webAccessDraftIssue({ pdf: { maxSizeMB: 51 } })).toEqual({
      code: 'invalid-value',
      field: 'pdf.maxSizeMB',
    });
    expect(webAccessDraftIssue({ braveBaseUrl: 'http://gateway.example.test' })).toEqual({
      code: 'invalid-value',
      field: 'braveBaseUrl',
    });
    expect(webAccessDraftIssue({ maxInlineContentChars: 200_001 })).toEqual({
      code: 'invalid-value',
      field: 'maxInlineContentChars',
    });
    expect(webAccessDraftIssue({ brightdataSerpZone: 'https://not-a-zone.example' })).toEqual({
      code: 'invalid-value',
      field: 'brightdataSerpZone',
    });
    // The plugin accepts positive fractional values and floors them while loading.
    expect(webAccessDraftIssue({ pdf: { maxPages: 1.5 } })).toBeNull();
  });
});
