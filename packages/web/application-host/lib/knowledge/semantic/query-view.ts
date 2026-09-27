/**
 * Pins the semantic document view for one Host query: surface drafts and
 * WorkingState baseline+delta. Disk vectors for those paths are masked
 * immediately.
 */

import type { AgentInputContext } from "@varin/protocol";
import type { SemanticQueryOverlay } from "./runtime.js";

export type SemanticQueryView = {
  overlays: SemanticQueryOverlay[];
  view: "disk" | "working-state";
};

export type SemanticDraftReadResult =
  | { status: "ready"; content: string; revision: string; source?: "surface-draft" | "working-branch" }
  | { status: "unavailable"; message?: string }
  | { status: "disk"; superseded?: true }
  | { status: "deleted" };

export async function pinSemanticQueryView(input: {
  inputContext: AgentInputContext;
  workspaceId?: string;
  draftPaths?: readonly string[];
  readDraft?: (path: string) => SemanticDraftReadResult | Promise<SemanticDraftReadResult>;
  threadDocuments?: Array<{
    path: string;
    content: string | null;
    revision: string;
    gap?: SemanticQueryOverlay["gap"];
  }>;
}): Promise<SemanticQueryView> {
  const overlays: SemanticQueryOverlay[] = [];
  if (input.threadDocuments) {
    for (const document of input.threadDocuments) {
      overlays.push({
        path: document.path,
        content: document.content,
        revision: document.revision,
        origin: "thread",
        ...(document.gap ? { gap: document.gap } : {}),
      });
    }
    return { overlays, view: "working-state" };
  }
  if (input.inputContext.source !== "surface") {
    return { overlays, view: "disk" };
  }
  const roots = input.inputContext.roots;
  const matchingRoot = input.workspaceId
    ? roots.find((root) => root.workspaceId === input.workspaceId)
    : roots.length === 1 ? roots[0] : undefined;
  for (const path of input.draftPaths ?? matchingRoot?.dirtyPaths ?? []) {
    const draft = await input.readDraft?.(path);
    if (draft?.status === "disk" && draft.superseded) continue;
    if (draft?.status === "ready") {
      overlays.push({
        path,
        content: draft.content,
        revision: draft.revision,
        origin: "surface-draft",
      });
      continue;
    }
    if (!draft || draft.status === "unavailable") {
      overlays.push({
        path,
        content: null,
        revision: `surface-unavailable:${path}`,
        origin: "surface-draft",
        gap: "draft-unavailable",
      });
      continue;
    }
    if (draft.status === "disk") continue;
    overlays.push({
      path,
      content: null,
      revision: `surface-deleted:${path}`,
      origin: "surface-draft",
    });
  }
  return { overlays, view: "disk" };
}
