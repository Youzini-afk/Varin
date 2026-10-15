export const WORK_FOCUS_IDS = ["code", "research"] as const;

export type WorkFocusId = (typeof WORK_FOCUS_IDS)[number];

export const isWorkFocusId = (value: unknown): value is WorkFocusId => (
  typeof value === "string" && WORK_FOCUS_IDS.includes(value as WorkFocusId)
);
