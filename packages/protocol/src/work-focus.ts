export const WORK_FOCUS_IDS = ["code", "research"] as const;

export type WorkFocusId = (typeof WORK_FOCUS_IDS)[number];

export const WORK_FOCUS_SOURCES = [
  "explicit",
  "project-default",
  "product-default",
] as const;

export type WorkFocusSource = (typeof WORK_FOCUS_SOURCES)[number];

export interface WorkFocusSelection {
  id: WorkFocusId;
  source: WorkFocusSource;
}

export interface WorkFocusFailure {
  at: number;
  message: string;
}

/**
 * The applied execution profile and the user's durable selection are separate.
 * A pending or failed selection never changes the currently running Pi turn.
 */
export interface SessionWorkFocusSnapshot {
  active: WorkFocusSelection & { generation: number };
  selected: WorkFocusSelection;
  status: "applied" | "pending" | "failed";
  failure?: WorkFocusFailure;
}

export const isWorkFocusId = (value: unknown): value is WorkFocusId => (
  typeof value === "string" && WORK_FOCUS_IDS.includes(value as WorkFocusId)
);

export const isWorkFocusSource = (value: unknown): value is WorkFocusSource => (
  typeof value === "string" && WORK_FOCUS_SOURCES.includes(value as WorkFocusSource)
);

export const productDefaultWorkFocus = (): SessionWorkFocusSnapshot => ({
  active: { generation: 1, id: "code", source: "product-default" },
  selected: { id: "code", source: "product-default" },
  status: "applied",
});
