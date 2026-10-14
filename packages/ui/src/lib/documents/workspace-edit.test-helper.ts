import type { DocumentsWorkspaceEditAPI } from '@varin/application-client';

const unexpected = async (): Promise<never> => {
  throw new Error('This test did not configure the workspace edit owner');
};
/** Narrow fakes for tests of unrelated Documents methods. Resource edit tests use the real Host. */
export const unconfiguredWorkspaceEdits: DocumentsWorkspaceEditAPI = {
  prepareWorkspaceEdit: unexpected,
  discardWorkspaceEdit: unexpected,
  applyWorkspaceEdit: unexpected,
  readWorkspaceEdit: unexpected,
  readWorkspaceEditRecovery: unexpected,
  undoWorkspaceEdit: unexpected,
  listWorkspaceEdits: unexpected,
};
