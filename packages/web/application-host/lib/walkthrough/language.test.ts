import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-language-'));
process.env.VARIN_DATA_DIR = TEMP_DATA_DIR;

vi.mock('../git/service.js', () => ({
  resolveWorktreeTopLevel: vi.fn(async () => ({ root: '/repo' })),
  getDiff: vi.fn(),
  getRangeDiff: vi.fn(),
  getUntrackedDiffs: vi.fn(async () => []),
  listUntrackedPaths: vi.fn(async () => []),
}));


const { normalizeLanguage } = await import('./languages.js');
const { buildPrompt } = await import('./prompt.js');
const { generateWalkthrough: nativeGenerateWalkthrough, getWalkthrough: nativeGetWalkthrough } = await import('./index.js');
const describeModel = vi.fn<import('../model-text/service.js').ModelTextService['describe']>();
const generateText = vi.fn<import('../model-text/service.js').ModelTextService['generate']>();
const modelText = {describe:describeModel,generate:generateText};
const generateWalkthrough = (input: Parameters<typeof nativeGenerateWalkthrough>[0]) => nativeGenerateWalkthrough(input, {modelText});
const getWalkthrough = (input: Parameters<typeof nativeGetWalkthrough>[0]) => nativeGetWalkthrough(input, {modelText});
const gitService = await import('../git/service.js');
const getDiff = vi.mocked(gitService.getDiff);
import type { WalkthroughSource } from './types.js';

const SOURCE: WalkthroughSource = { kind: 'working-tree', scope: 'all' };

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
+const added = true;
`;

const RESPONSE = JSON.stringify({
  title: 'Change',
  focus: 'why',
  chapters: [{
    title: 'Data',
    icon: 'doc',
    blurb: '',
    stops: [{ title: 'Adds a flag', hunks: ['h1'], importance: 'normal', prose: 'It adds a flag.' }],
  }],
});

const PROMPT_INPUT: Parameters<typeof buildPrompt>[0] = {
  digest: { files: [] },
  fileCount: 1,
  hunkCount: 1,
  source: SOURCE,
};

describe('normalizeLanguage', () => {


  it('tolerates case and separator drift from a platform locale', () => {
    expect(normalizeLanguage('uk-UA')).toBe('uk');
    expect(normalizeLanguage('pt_br')).toBe('pt-BR');
    expect(normalizeLanguage('ja-JP')).toBe('ja');
  });

  // A language preference is about prose. Refusing to write a walkthrough over
  // an unrecognised tag would be a worse answer than writing it in English.
  it('falls back to English rather than failing', () => {
    expect(normalizeLanguage('kl')).toBe('en');
    expect(normalizeLanguage('')).toBe('en');
    expect(normalizeLanguage(undefined)).toBe('en');
    expect(normalizeLanguage({ toString: () => 'uk' })).toBe('en');
  });


});

describe('prompt language instruction', () => {
  it('says nothing when the prompt language is already the output language', () => {
    const { system } = buildPrompt({ ...PROMPT_INPUT, language: 'en' });
    expect(system).not.toMatch(/Write all prose/);
  });

  it('asks for prose in the chosen language', () => {
    const { system } = buildPrompt({ ...PROMPT_INPUT, language: 'uk' });
    expect(system).toMatch(/Write all prose in Ukrainian/);
  });

  // Aliases are keys the server resolves back to hunk ids and icon/importance
  // are validated against fixed English values, so a translated one is dropped
  // by the normalizer —silently losing an anchor or a style.
  it('holds back the parts that are not prose', () => {
    const { system } = buildPrompt({ ...PROMPT_INPUT, language: 'ja' });
    expect(system).toMatch(/Keep these in English exactly as given/);
    expect(system).toMatch(/hunk aliases/);
    expect(system).toMatch(/"importance"/);
  });

  it('defaults to English when no language is passed', () => {
    expect(buildPrompt(PROMPT_INPUT).system).toBe(buildPrompt({ ...PROMPT_INPUT, language: 'en' }).system);
  });
});

describe('generating in a language', () => {
  beforeEach(() => {
    fs.rmSync(path.join(TEMP_DATA_DIR, 'walkthroughs'), { recursive: true, force: true });
    describeModel.mockResolvedValue({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'default' as const,
      hasLogin: true,
      inputCharBudget: 1_000_000,
      contextTokens: 250_000,
      contextKnown: true,
      structuredOutput: true,
      outputTokens: null,
      outputTokenLimit: null,
    });
    getDiff.mockImplementation(async (directory: unknown = undefined, options: { contextLines?: number | undefined; staged?: boolean | undefined } = {}) => {
      void directory;
      return options.staged ? '' : PATCH;
    });
    generateText.mockReset();
    generateText.mockResolvedValue({
      requestId: 'model-text:test',
      text: RESPONSE,
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5',
    });
  });

  afterAll(() => {
    fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
  });

  it('sends the instruction and records the language with the result', async () => {
    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });

    expect(generateText.mock.calls[0]?.[0].system).toMatch(/Write all prose in Ukrainian/);
    expect(result.language).toBe('uk');
  });

  it('does not serve one language from the other language cache entry', async () => {
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });
    generateText.mockClear();

    const english = await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'en' });

    expect(english.fromCache).toBeFalsy();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(english.language).toBe('en');
  });

  // Switching away and back must not cost a second generation: the earlier
  // walkthrough is still addressed by its own key.
  it('returns the earlier language from cache when it is asked for again', async () => {
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'en' });
    generateText.mockClear();

    const back = await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });

    expect(back.fromCache).toBe(true);
    expect(back.language).toBe('uk');
    expect(generateText).not.toHaveBeenCalled();
  });

  // The pointer only knows what was generated here last. After a language
  // switch that is the answer to a different question, and reading it instead
  // left the panel showing English while the picker said Ukrainian —with the
  // Ukrainian walkthrough sitting unused in the cache.
  it('reads back the walkthrough written in the language being asked for', async () => {
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'en' });
    generateText.mockClear();

    const ukrainian = await getWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });

    expect(ukrainian.language).toBe('uk');
    expect(ukrainian.walkthrough).toBeTruthy();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('switches back and forth without generating anything', async () => {
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' });
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'ja' });
    generateText.mockClear();

    expect((await getWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' })).language).toBe('uk');
    expect((await getWalkthrough({ directory: '/repo', source: SOURCE, language: 'ja' })).language).toBe('ja');
    expect((await getWalkthrough({ directory: '/repo', source: SOURCE, language: 'uk' })).language).toBe('uk');
    expect(generateText).not.toHaveBeenCalled();
  });

  // Falling back is still right: an English review beats an empty panel, and
  // the response says which language it is in so the panel can be honest.
  it('falls back to the last walkthrough when none exists in that language', async () => {
    await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'en' });

    const korean = await getWalkthrough({ directory: '/repo', source: SOURCE, language: 'ko' });

    expect(korean.walkthrough).toBeTruthy();
    expect(korean.language).toBe('en');
  });

  it('treats an unknown language as English rather than failing the request', async () => {
    const result = await generateWalkthrough({ directory: '/repo', source: SOURCE, language: 'kl' });

    expect(result.language).toBe('en');
    expect(generateText.mock.calls[0]?.[0].system).not.toMatch(/Write all prose/);
  });
});
