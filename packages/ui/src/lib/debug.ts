import { copyTextToClipboard } from '@/lib/clipboard';
import { buildVarinDiagnosticsReport, collectVarinDiagnostics } from '@/lib/varinDiagnostics';
import { useThreadStore } from '@/stores/useThreadStore';

/** Explicit diagnostics contain identities/status only, never prompts or credential bytes. */
const varinDebug = {
  getCurrentThread() {
    const state = useThreadStore.getState();
    const thread = state.threads.find(value => value.thread_id === state.selectedIdentity?.threadId);
    return { identity: state.selectedIdentity, revision: thread?.revision ?? null,
      branches: thread?.branches.map(branch => ({ branchId: branch.branch_id, activeRunId: branch.active_run_id,
        latestRunId: branch.latest_run?.id ?? null, state: branch.latest_run?.state ?? null })) ?? [] };
  },
  getRuntimeState() {
    const state = useThreadStore.getState();
    return { catalogLoaded: state.catalogLoaded, catalogLoading: state.catalogLoading,
      catalogError: state.catalogError, threadCount: state.threads.length, selectedIdentity: state.selectedIdentity };
  },
  getAppStatus: collectVarinDiagnostics,
  buildDiagnosticsReport: buildVarinDiagnosticsReport,
  copyTextToClipboard,
  async copyDiagnosticsReport() {
    const report = await buildVarinDiagnosticsReport();
    return { ...await copyTextToClipboard(report), report };
  },
};
export type VarinDebug = typeof varinDebug;
if (typeof window !== 'undefined') window.__varinDebug = varinDebug;
