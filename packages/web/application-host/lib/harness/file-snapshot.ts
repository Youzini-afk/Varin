/** Exact source text selected by the native source-query owner. */
export type ExploreFileSnapshot =
  | { status: "ready"; content: string; revision: string; source: "disk" | "surface-draft" | "working-branch" }
  | { status: "unavailable" | "failed" | "stale" | "forbidden"; message: string };
