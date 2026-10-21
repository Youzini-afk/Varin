/** Host-wide model request retry settings. Matching is executed by the native runtime. */
export interface ModelRetryRule {
  field: 'status' | 'code' | 'message';
  match: 'exact' | 'contains' | 'regex';
  pattern: string;
  action: 'retry' | 'stop';
}
export interface ModelRetrySettings {
  enabled: boolean;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  rules: ModelRetryRule[];
}
export interface ModelRetryFailure {
  status?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
  shouldRetry?: boolean;
}
export interface ModelRetryDecision { retry: boolean; reason: string; ruleIndex: number | null; delayMs: number }
export const defaultModelRetrySettings: Readonly<ModelRetrySettings> = Object.freeze({
  enabled: true, maxRetries: 2, initialDelayMs: 1000, maxDelayMs: 30000, rules: [],
});
export function parseModelRetrySettings(value?: unknown): ModelRetrySettings {
  if (value === undefined) return { ...defaultModelRetrySettings, rules: [] };
  const fail = (): never => { throw new Error('Invalid automatic retry settings'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !Object.hasOwn(defaultModelRetrySettings, key))) return fail();
  const settings = { ...defaultModelRetrySettings, ...raw } as ModelRetrySettings;
  if (typeof settings.enabled !== 'boolean' || ![settings.maxRetries, settings.initialDelayMs, settings.maxDelayMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || settings.maxDelayMs < settings.initialDelayMs || !Array.isArray(settings.rules)) return fail();
  for (const rule of settings.rules) {
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some(key => !['field', 'match', 'pattern', 'action'].includes(key))
      || !['status', 'code', 'message'].includes(rule.field) || !['exact', 'contains', 'regex'].includes(rule.match)
      || typeof rule.pattern !== 'string' || !rule.pattern.length || !['retry', 'stop'].includes(rule.action)) return fail();
  }
  // Regex syntax is validated by the same native linear-time engine used at dispatch.
  return { ...settings, rules: settings.rules.map(rule => ({ ...rule })) };
}
