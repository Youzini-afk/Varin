import type {
  ExploreProgressActivity, ExploreProgressPhase, ExploreQuerySourceState, ExploreQueryView, ExploreToolProgress,
} from "@varin/protocol";

/** Observe existing RPC results without starting work, reading more files, or
 * copying candidate bodies into native history. Each emitted snapshot is frozen
 * from the receiver's perspective, including across later source transitions.
 */
export function createExploreProgress(emit?: (progress: ExploreToolProgress) => void) {
  const started = Date.now();
  const sources = new Map<string, ExploreQuerySourceState>();
  const views = new Set<string>();
  const files = new Set<string>();
  const activities: ExploreProgressActivity[] = [];
  let phase: ExploreProgressPhase = "starting";
  const elapsed = () => Math.max(0, Date.now() - started);
  const snapshot = (): ExploreToolProgress => ({
    phase, elapsedMs: elapsed(), receivedSnippets: views.size, receivedFiles: files.size,
    sources: [...sources.values()], activities: [...activities],
  });
  const add = (activity: Omit<Extract<ExploreProgressActivity, { kind: "phase" }>, "sequence" | "elapsedMs">
    | Omit<Extract<ExploreProgressActivity, { kind: "source" }>, "sequence" | "elapsedMs">
    | Omit<Extract<ExploreProgressActivity, { kind: "read" }>, "sequence" | "elapsedMs">) => {
    activities.push({ ...activity, sequence: activities.length, elapsedMs: elapsed() });
  };
  const publish = () => { const value = snapshot(); emit?.(value); return value; };
  return {
    phase(next: ExploreProgressPhase) {
      if (next === phase && activities.length > 0) return snapshot();
      phase = next;
      add({ kind: "phase", phase });
      return publish();
    },
    observe(value: { sources?: ExploreQuerySourceState[]; views?: ExploreQueryView[] }) {
      let changed = false;
      for (const source of value.sources ?? []) {
        if (sources.get(source.id)?.status === source.status) continue;
        const receipt = { ...source };
        sources.set(source.id, receipt);
        add({ kind: "source", source: receipt });
        changed = true;
      }
      for (const view of value.views ?? []) {
        if (!view.viewId || !view.path || !view.revision || views.has(view.viewId)) continue;
        views.add(view.viewId);
        files.add(view.path);
        add({ kind: "read", viewId: view.viewId, path: view.path, startLine: view.startLine, endLine: view.endLine,
          revision: view.revision, source: view.source });
        changed = true;
      }
      if (changed) publish();
    },
  };
}
