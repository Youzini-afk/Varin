import { describe, expect, test } from 'vitest';

import { getMultiRunSessionTitle } from './title';

describe('multi-run titles', () => {
  test('builds duplicate titles without empty group segments', () => {
    expect(getMultiRunSessionTitle({ groupSlug: 'bench', providerID: 'anthropic', modelID: 'claude', index: 1 })).toBe('bench/anthropic/claude/1');
    expect(getMultiRunSessionTitle({ groupSlug: 'bench', runGroup: 'g1', providerID: 'anthropic', modelID: 'claude', index: 1 })).toBe('bench/g1/anthropic/claude/1');
  });

  test('encodes Unicode group names and model ids containing slashes', () => {
    const title = getMultiRunSessionTitle({
      groupSlug: '修复登录',
      providerID: 'openrouter',
      modelID: 'anthropic/claude-sonnet',
      index: 2,
    });
    expect(title).toBe('%E4%BF%AE%E5%A4%8D%E7%99%BB%E5%BD%95/openrouter/anthropic%2Fclaude-sonnet/2');
  });
});
