import type { ThreadUsageRow, UsageTokenCount } from "@varin/protocol";

export const usageMetrics = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["cachedInputTokens", "cacheRead"],
  ["cacheWriteTokens", "cacheWrite"],
  ["reasoningTokens", "reasoning"],
] as const;
export type UsageMetric = (typeof usageMetrics)[number][0];

export function sumUsage(
  rows: readonly ThreadUsageRow[],
  metric: UsageMetric,
): UsageTokenCount {
  let known: bigint | null = null;
  let missing = 0;
  for (const row of rows) {
    const value = row[metric];
    if (value.known !== null) known = (known ?? 0n) + BigInt(value.known);
    missing += value.missing;
  }
  return { known: known?.toString() ?? null, missing };
}

export function exactUsage(value: UsageTokenCount): string {
  return value.known === null
    ? "—"
    : `${BigInt(value.known).toLocaleString()}${value.missing ? " + ?" : ""}`;
}

export function compactUsage(value: UsageTokenCount): string {
  if (value.known === null) return "—";
  const count = BigInt(value.known);
  for (const [divisor, suffix] of [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const) {
    if (count < divisor) continue;
    // Round only the presentation; original counters remain decimal strings/BigInts.
    const hundredths = (count * 100n + divisor / 2n) / divisor;
    const fraction = (hundredths % 100n)
      .toString()
      .padStart(2, "0")
      .replace(/0+$/, "");
    return `${(hundredths / 100n).toLocaleString()}${fraction ? `.${fraction}` : ""}${suffix}${value.missing ? "+" : ""}`;
  }
  return `${count.toLocaleString()}${value.missing ? "+" : ""}`;
}

export function groupUsage(rows: readonly ThreadUsageRow[]) {
  const groups = new Map<
    string,
    {
      key: string;
      providerId: string | null;
      modelId: string;
      rows: ThreadUsageRow[];
    }
  >();
  for (const row of rows) {
    const key = JSON.stringify([
      row.providerId ?? ["unattributed", row.providerFamily],
      row.modelId,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        providerId: row.providerId,
        modelId: row.modelId,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}
