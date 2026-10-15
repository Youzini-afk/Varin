import { ThreadRequestError } from '@varin/application-client';
import type { I18nKey, I18nParams } from '@/lib/i18n';

const computerErrors: Record<string, I18nKey> = {
  'computer-work-not-found': 'computer.automation.error.workMissing',
  'computer-execution-stale': 'computer.automation.error.executionStale',
  'computer-input-release-unconfirmed': 'computer.automation.error.releaseUnconfirmed',
  'computer-runtime-format-unsupported': 'computer.automation.error.formatUnsupported',
  'computer-runtime-record-invalid': 'computer.automation.error.recordInvalid',
  'computer-owner-unavailable': 'computer.automation.error.ownerUnavailable',
  'computer-request-invalid': 'computer.automation.error.requestInvalid',
};

/** The Computer owner exposes a bounded code; internal exception bodies are not UI instructions. */
export function computerErrorText(error: unknown, t: (key: I18nKey, params?: I18nParams) => string): string {
  const key = error instanceof ThreadRequestError ? computerErrors[error.code] : undefined;
  return key ? t(key) : error instanceof Error ? error.message : String(error);
}
