import type { JsonValue } from "@varin/extension-contract";
import {
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@varin/extension-contract";
import {
  callWorkspaceRecoveryPrimitives,
  defineHostExtension,
} from "@varin/extension-sdk";

const missingArgument = (): never => { throw new Error("Recovery service argument is required"); };

export default defineHostExtension({
  activate(context) {
    const call = (method: string, params: JsonValue): Promise<JsonValue> => (
      callWorkspaceRecoveryPrimitives(context.capabilities, method, params)
    );
    context.services.provide({
      id: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
      multiple: true,
      version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
    }, {
      applyCombinedRecovery: ([input = missingArgument()]) => call("applyCombinedRecovery", input),
      cancelCombinedOperation: ([operationId = missingArgument()]) => call("cancelCombinedOperation", { operationId }),
      clearStorageLocationOverride: ([workspaceId = missingArgument()]) => call("clearStorageLocationOverride", { workspaceId }),
      cleanupStorage: ([input = missingArgument()]) => call("cleanupStorage", input),
      createCheckpoint: ([input = missingArgument()]) => call("createCheckpoint", input),
      deleteWorkspaceHistory: ([workspaceId = missingArgument()]) => call("deleteWorkspaceHistory", { workspaceId }),
      getCombinedOperation: ([operationId = missingArgument()]) => call("getCombinedOperation", { operationId }),
      getStorageMove: ([operationId = missingArgument()]) => call("getStorageMove", { operationId }),
      listCheckpoints: ([input = missingArgument()]) => call("listCheckpoints", input),
      listCombinedOperations: ([workspaceId = missingArgument()]) => call("listCombinedOperations", { workspaceId }),
      listStorageWorkspaces: () => call("listStorageWorkspaces", {}),
      prepareCombinedRecovery: ([input = missingArgument()]) => call("prepareCombinedRecovery", input),
      prepareCombinedUndo: ([operationId = missingArgument()]) => call("prepareCombinedUndo", { operationId }),
      recordMutationAfter: ([input = missingArgument()]) => call("recordMutationAfter", input),
      recordMutationBefore: ([input = missingArgument()]) => call("recordMutationBefore", input),
      recordTurnSettled: ([input = missingArgument()]) => call("recordTurnSettled", input),
      recordTurnStart: ([input = missingArgument()]) => call("recordTurnStart", input),
      retentionStatus: ([workspaceId = missingArgument()]) => call("retentionStatus", { workspaceId }),
      resolveEntry: ([input = missingArgument()]) => call("resolveEntry", input),
      setDefaultStorageLocation: ([location = missingArgument()]) => call("setDefaultStorageLocation", location),
      setRetentionPolicy: ([input = missingArgument()]) => call("setRetentionPolicy", input),
      setStorageLocation: ([input = missingArgument()]) => call("setStorageLocation", input),
      status: ([workspaceId = missingArgument()]) => call("status", { workspaceId }),
      storageStatus: ([workspaceId = missingArgument()]) => call("storageStatus", workspaceId === null ? {} : { workspaceId }),
    });
  },
  migrate: ({ data }) => data,
});
