export const clampPercent = (value: number | null): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null
);

export const resolveUsageTone = (percent: number | null): 'safe' | 'warn' | 'critical' => (
  percent !== null && percent >= 80 ? 'critical' : percent !== null && percent >= 50 ? 'warn' : 'safe'
);
