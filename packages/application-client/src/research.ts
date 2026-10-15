import type {
  ExperimentArtifactReadParams, ExperimentArtifactReadResult, ExperimentCancelResult,
  ExperimentCollectResult, ExperimentGetResult, ExperimentListParams, ExperimentListResult,
  ExperimentLogsParams, ExperimentLogsResult, ExperimentSubmitParams, ExperimentSubmitResult,
  LaunchSource, ResourceListResult, SourceListParams, SourceListResult,
} from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';

/** A real retained source selection. Old jobs remain discoverable when a later Run changes source. */
export interface ThreadResearchScope {
  sourceRunId: string;
  workspaceId: string;
  executionWorkspaceId: string;
  source: LaunchSource;
  /** Reading/control of an older branch's jobs does not grant a new source admission. */
  canSubmit: boolean;
}

/** The source Run is an attribution/source reference, never a request to resume that Run. */
export type ThreadResearchSelection = ThreadIdentity & { sourceRunId: string };

/** User management of the original research owners. No caller, permission or workspace grant
 * can be supplied by the client; the authenticated Host resolves these from Catalog identities. */
export interface ThreadResearchAPI {
  scopes(identity: ThreadIdentity, signal?: AbortSignal): Promise<ThreadResearchScope[]>;
  list(selection: ThreadResearchSelection, request?: ExperimentListParams, signal?: AbortSignal): Promise<ExperimentListResult>;
  get(selection: ThreadResearchSelection, attemptId: string, signal?: AbortSignal): Promise<ExperimentGetResult>;
  logs(selection: ThreadResearchSelection, request: ExperimentLogsParams, signal?: AbortSignal): Promise<ExperimentLogsResult>;
  artifact(selection: ThreadResearchSelection, request: ExperimentArtifactReadParams, signal?: AbortSignal): Promise<ExperimentArtifactReadResult>;
  cancel(selection: ThreadResearchSelection, attemptId: string): Promise<ExperimentCancelResult>;
  collect(selection: ThreadResearchSelection, attemptId: string): Promise<ExperimentCollectResult>;
  /** Retrying an uncertain admission preserves this exact key and intent. */
  submit(selection: ThreadResearchSelection, request: ExperimentSubmitParams & { requestId: string }): Promise<ExperimentSubmitResult>;
  resources(selection: ThreadResearchSelection, signal?: AbortSignal): Promise<ResourceListResult>;
  sources(selection: ThreadResearchSelection, request?: SourceListParams, signal?: AbortSignal): Promise<SourceListResult>;
}
