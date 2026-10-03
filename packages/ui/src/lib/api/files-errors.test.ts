import { describe, expect, test } from 'vitest';

import {
  FilesystemError,
  isFilesystemError,
  parseFilesystemErrorReason,
} from '@varin/application-client';

describe('FilesystemError', () => {
  test('retains a stable reason and HTTP status', () => {
    const error = new FilesystemError('Access denied', {
      reason: 'os-permission',
      status: 403,
    });

    expect(isFilesystemError(error)).toBe(true);
    expect(error.reason).toBe('os-permission');
    expect(error.status).toBe(403);
  });

  test('normalizes unsupported response reasons', () => {
    expect(parseFilesystemErrorReason('not-directory')).toBe('not-directory');
    expect(parseFilesystemErrorReason('made-up')).toBe('unknown');
  });
});
