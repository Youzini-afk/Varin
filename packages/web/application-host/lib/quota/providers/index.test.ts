import { describe, expect, it } from 'vitest';

import { listConfiguredQuotaProviders } from './index.js';

describe('quota provider registry', () => {

  it('can list configured providers without missing provider exports', () => {
    expect(() => listConfiguredQuotaProviders()).not.toThrow();
  });
});
