/** Fraction of the selected model's context window reserved before switching context. */
export const DEFAULT_COMPACTION_RESERVE_RATIO = 0.1;

export interface CompactionBudgetSettings {
  reserveRatio?: number;
  /** Original-content allowance used with the summary reserve to derive the continuation target. */
  keepRecentTokens?: number;
}

export interface CompactionSettings extends CompactionBudgetSettings {
  enabled?: boolean;
  modelOverrides?: Record<string, CompactionBudgetSettings>;
}
