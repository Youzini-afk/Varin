import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-jobs-'));
process.env.VARIN_DATA_DIR = TEMP_DATA_DIR;

// Mocking git rather than this module's own source loading: fewer of our own
// seams faked means the test exercises the real digest and prompt path.
vi.mock('../git/service.js', () => ({
  resolveWorktreeTopLevel: vi.fn(async () => ({ root: '/repo' })),
  getDiff: vi.fn(),
  getRangeDiff: vi.fn(),
  getUntrackedDiffs: vi.fn(async () => []),
  listUntrackedPaths: vi.fn(async () => []),
}));

const {
  generateWalkthrough: nativeGenerateWalkthrough,
  cancelWalkthroughGeneration,
  isGenerating,
  getGenerationStage,
  __testing: walkthroughTesting,
} = await import('./index.js');
const describeModel = vi.fn<import('../model-text/service.js').ModelTextService['describe']>();
const generateText = vi.fn<import('../model-text/service.js').ModelTextService['generate']>();
const modelText = {describe:describeModel,generate:generateText};
const generateWalkthrough = (input: Parameters<typeof nativeGenerateWalkthrough>[0]) => nativeGenerateWalkthrough(input, {modelText});
const gitService = await import('../git/service.js');
const getDiff = vi.mocked(gitService.getDiff);

// bun's vitest shim has no `vi.waitFor`.
const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  { timeout = 2_000, interval = 5 }: { interval?: number; timeout?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

const SOURCE = { kind: 'working-tree', scope: 'all' };

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

const MODEL_DESCRIPTION = {
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
};

const modelResponse = () => ({
  requestId: 'model-text:test',
  text: RESPONSE,
  providerId: 'anthropic',
  modelId: 'claude-haiku-4-5',
  source: 'default' as const,
});

describe('generation jobs', () => {
  beforeEach(() => {
    fs.rmSync(path.join(TEMP_DATA_DIR, 'walkthroughs'), { recursive: true, force: true });
    describeModel.mockResolvedValue(MODEL_DESCRIPTION);
    getDiff.mockImplementation(async (directory: unknown = undefined, options: { contextLines?: number | undefined; staged?: boolean | undefined } = {}) => {
      void directory;
      return options.staged ? '' : PATCH;
    });
    generateText.mockReset();
  });

  afterEach(async () => {
    if (isGenerating('/repo', 'working-tree:all')) {
      await cancelWalkthroughGeneration({ directory: '/repo', source: SOURCE }).catch(() => {});
    }
  });

  afterAll(() => {
    fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
  });

  it('runs a second request against the same job instead of paying twice', async () => {
    let release: (() => void) | undefined;
    generateText.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(modelResponse());
    }));

    const first = generateWalkthrough({ directory: '/repo', source: SOURCE });
    // Let the first call reach the model before the second arrives, which is
    // what a refresh-then-press-again actually looks like.
    await waitFor(() => generateText.mock.calls.length === 1);
    const second = generateWalkthrough({ directory: '/repo', source: SOURCE });

    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(a.walkthrough.title).toBe('Change');
    expect(b).toBe(a);
  });

  it('reports a running job so a returning client can show progress', async () => {
    let release: (() => void) | undefined;
    generateText.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(modelResponse());
    }));

    const running = generateWalkthrough({ directory: '/repo', source: SOURCE });
    await waitFor(() => isGenerating('/repo', 'working-tree:all'));

    release?.();
    await running;

    expect(isGenerating('/repo', 'working-tree:all')).toBe(false);
  });

  it('stops only on an explicit cancel', async () => {
    generateText.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));

    const running = generateWalkthrough({ directory: '/repo', source: SOURCE });
    await waitFor(() => isGenerating('/repo', 'working-tree:all'));

    expect(await cancelWalkthroughGeneration({ directory: '/repo', source: SOURCE }))
      .toEqual({ cancelled: true });
    await expect(running).rejects.toThrow();
    expect(isGenerating('/repo', 'working-tree:all')).toBe(false);
  });

  it('reports nothing to cancel when no job is running', async () => {
    expect(await cancelWalkthroughGeneration({ directory: '/repo', source: SOURCE }))
      .toEqual({ cancelled: false });
  });

  // The reserve and the request must be the same number: asking for more than
  // was subtracted from the input allowance overruns the context mid-answer.
  it('requests exactly the budget the model resolution reserved', async () => {
    describeModel.mockResolvedValue({
      providerID: 'varin-test',
      modelID: 'deepseek-v4-flash',
      source: 'default' as const,
      hasLogin: true,
      inputCharBudget: 1_000_000,
      contextTokens: 1_000_000,
      contextKnown: true,
      structuredOutput: true,
      outputTokens: 32_000,
      outputTokenLimit: 384_000,
    });
    generateText.mockResolvedValue(modelResponse());

    await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(generateText.mock.calls.at(-1)?.[0].maxOutputTokens).toBe(32_000);
  });

  it('serves the cache once the job has finished, without calling the model again', async () => {
    generateText.mockResolvedValue(modelResponse());

    await generateWalkthrough({ directory: '/repo', source: SOURCE });
    generateText.mockClear();

    const second = await generateWalkthrough({ directory: '/repo', source: SOURCE });

    expect(second.fromCache).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });
});

// A fixed deadline made a three-hunk edit and a 500-hunk pull request wait the
// same, so the small case guarded nothing and the big case died just short of
// the finish line.
describe('generation timeout', () => {
  const { generationTimeoutMs } = walkthroughTesting;

  it('gives a small diff a floor rather than a proportional sliver', () => {
    expect(generationTimeoutMs(0)).toBe(120_000);
    expect(generationTimeoutMs(3)).toBe(123_000);
  });

  it('grows with the work', () => {
    expect(generationTimeoutMs(515)).toBeGreaterThan(generationTimeoutMs(138));
    expect(generationTimeoutMs(515)).toBe(635_000);
  });

  it('stays bounded so a hung connection cannot hold a job forever', () => {
    expect(generationTimeoutMs(100_000)).toBe(900_000);
  });
});

// The request scales with the selected model but remains proportional to the
// context it removes from the diff input allowance.
describe('output budget', () => {
  const { walkthroughOutputTokens } = walkthroughTesting;

  it('uses the walkthrough ceiling for an exceptionally roomy model', () => {
    expect(walkthroughOutputTokens({ contextTokens: 1_000_000, outputTokenLimit: 384_000 })).toBe(32_000);
  });

  it('never asks for more than the model says it can emit', () => {
    expect(walkthroughOutputTokens({ contextTokens: 202_752, outputTokenLimit: 32_768 })).toBe(25_344);
  });

  it('keeps the reserve to a share of the context', () => {
    expect(walkthroughOutputTokens({ contextTokens: 200_000, outputTokenLimit: 64_000 })).toBe(25_000);
  });

  it('keeps enough output room for a small or uncatalogued model', () => {
    expect(walkthroughOutputTokens({ contextTokens: 64_000, outputTokenLimit: null })).toBe(8_000);
    expect(walkthroughOutputTokens({ contextTokens: 0, outputTokenLimit: null })).toBe(4_000);
  });

  it('yields to a model whose own limit is below the floor', () => {
    expect(walkthroughOutputTokens({ contextTokens: 128_000, outputTokenLimit: 8_192 })).toBe(8_192);
  });
});

describe('generation stages', () => {
  beforeEach(() => {
    // Without this the previous suite's cache entry is a hit for the same
    // content and the model is never called.
    fs.rmSync(path.join(TEMP_DATA_DIR, 'walkthroughs'), { recursive: true, force: true });
    describeModel.mockResolvedValue(MODEL_DESCRIPTION);
    getDiff.mockImplementation(async (directory: unknown = undefined, options: { contextLines?: number | undefined; staged?: boolean | undefined } = {}) => {
      void directory;
      return options.staged ? '' : PATCH;
    });
    generateText.mockReset();
  });

  it('reports asking while the model runs and clears when the job ends', async () => {
    let release: (() => void) | undefined;
    generateText.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(modelResponse());
    }));

    const running = generateWalkthrough({ directory: '/repo', source: SOURCE });
    await waitFor(() => getGenerationStage('/repo', 'working-tree:all') === 'asking');

    release?.();
    await running;

    expect(getGenerationStage('/repo', 'working-tree:all')).toBeNull();
  });

  it('does not retry an original provider failure with a new request', async () => {
    generateText.mockRejectedValue(Object.assign(new Error('Original request failed'), { code:'model-text-indeterminate',requestId:'model-text:original' }));
    await expect(generateWalkthrough({directory:'/repo',source:SOURCE})).rejects.toMatchObject({requestId:'model-text:original'});
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(getGenerationStage('/repo','working-tree:all')).toBeNull();
  });
});
