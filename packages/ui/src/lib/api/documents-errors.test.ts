import { describe, expect, test } from 'vitest';

import {
  DocumentsError,
  isDocumentsError,
  parseDocumentsFailureReason,
} from '@varin/application-client';

describe('DocumentsError', () => {
  test('retains the maintenance reason and HTTP status', () => {
    const error = new DocumentsError('Workspace is in maintenance mode', {
      reason: 'maintenance',
      status: 409,
    });

    expect(isDocumentsError(error)).toBe(true);
    expect(error.reason).toBe('maintenance');
    expect(error.status).toBe(409);
  });

  test('parses maintenance responses without falling back to failed', () => {
    expect(parseDocumentsFailureReason('maintenance')).toBe('maintenance');
    expect(parseDocumentsFailureReason('unknown-reason')).toBe('failed');
  });
});
