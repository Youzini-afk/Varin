// Generated from kernel/protocol/schema.json. Do not hand-edit.
#![allow(dead_code)]

use crate::model::PathState;
use serde::Deserialize;
use serde_json::Value;

pub(crate) const KERNEL_REQUEST_WINDOW: usize = 2;

#[derive(Clone, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelEmptyParams {}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeThreadCreateParams {
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeInputSubmitParams {
    pub(crate) key: String,
    pub(crate) thread_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_head: RequiredNullable<String>,
    pub(crate) input: Value,
    pub(crate) configuration: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeRunParams {
    pub(crate) run_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeOperationParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeHistoryParams {
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeEventsParams {
    pub(crate) cursor: i64,
    pub(crate) limit: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessSpawnParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) root_id: String,
    pub(crate) cwd: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) windows_raw_arguments: Option<String>,
    pub(crate) env: Vec<KernelProcessEnvironmentEntry>,
    pub(crate) mode: String,
    pub(crate) cols: Option<i64>,
    pub(crate) rows: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessReadParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) cursor: i64,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessWriteParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) sequence: i64,
    pub(crate) bytes_base64: String,
    pub(crate) eof: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessResizeParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) cols: i64,
    pub(crate) rows: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessKillParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
    pub(crate) force: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessHandleParams {
    pub(crate) workspace_id: String,
    pub(crate) process_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessListParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHandshakeParams {
    pub(crate) protocol_version: i64,
    pub(crate) build_version: String,
    pub(crate) host_id: String,
    pub(crate) host_generation: String,
    pub(crate) storage_root: String,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelHealthParams {
    pub(crate) deep: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantIssueParams {
    pub(crate) grant_id: String,
    pub(crate) host_generation: String,
    pub(crate) authority_instance_id: Option<RequiredNullable<String>>,
    pub(crate) worker_id: Option<RequiredNullable<String>>,
    pub(crate) worker_generation: Option<RequiredNullable<i64>>,
    pub(crate) session_id: RequiredNullable<String>,
    pub(crate) thread_id: RequiredNullable<String>,
    pub(crate) run_id: RequiredNullable<String>,
    pub(crate) owning_workspace: RequiredNullable<String>,
    pub(crate) execution_workspace: RequiredNullable<String>,
    pub(crate) storage_identity: String,
    pub(crate) capabilities: Vec<String>,
    pub(crate) path_scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGrantRevokeParams {
    pub(crate) grant_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelSnapshotParams {
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobBeginParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) byte_length: i64,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobChunkParams {
    pub(crate) stream_id: String,
    pub(crate) sequence: i64,
    pub(crate) bytes_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobFinishParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) expected_hash: Option<String>,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPutBlobAbortParams {
    pub(crate) operation_id: String,
    pub(crate) stream_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBlobReleaseParams {
    pub(crate) owner_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGetBlobParams {
    pub(crate) hash: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) pin_id: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) record_id: Option<String>,
    pub(crate) slot: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) offset: Option<i64>,
    pub(crate) length: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelObjectOwnerRebindParams {
    pub(crate) workspace_id: String,
    pub(crate) owner_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRootRegisterParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_workspace_id: String,
    pub(crate) canonical_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileOperationListParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileOperationReconcileParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseAcquireParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) lease_id: String,
    pub(crate) resources: Vec<KernelFileLeaseResource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseReleaseParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) lease_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileCaptureParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) store: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileApplyParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) target_json: String,
    pub(crate) expected_json: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMkdirParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) recursive: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRemoveParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) recursive: bool,
    pub(crate) force: bool,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileRenameParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) from_path: String,
    pub(crate) to_path: String,
    pub(crate) target_must_be_missing: Option<bool>,
    pub(crate) expected_from_json: Option<String>,
    pub(crate) expected_to_json: Option<String>,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileScanParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) scopes: Option<Vec<String>>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
    pub(crate) expected_fingerprint: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMeasureParams {
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileMaterializeParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) root_id: String,
    pub(crate) path: String,
    pub(crate) source_root: String,
    pub(crate) lease_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_type: String,
    pub(crate) state: String,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) revision: Option<i64>,
    pub(crate) result_revision: Option<i64>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) payload_json: String,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordListParams {
    pub(crate) workspace_id: String,
    pub(crate) record_type: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordWorkspacesParams {
    pub(crate) record_type: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) document: KernelWorkingResultDocument,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultListParams {
    pub(crate) workspace_id: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) document: KernelWorkingDraftDocument,
    pub(crate) branch_id: String,
    pub(crate) revision: i64,
    pub(crate) root: String,
    pub(crate) created_at: String,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftGetParams {
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingVerificationDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewPutParams {
    pub(crate) operation_id: String,
    pub(crate) record_id: String,
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) branch_id: String,
    pub(crate) result_revision: i64,
    pub(crate) root: String,
    pub(crate) document: KernelWorkingReviewDocument,
    pub(crate) expected_record_revision: Option<i64>,
    pub(crate) owner_ids: Vec<String>,
    pub(crate) references: Vec<KernelRecordReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewListParams {
    pub(crate) workspace_id: String,
    pub(crate) thread_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) workspace_id: String,
    pub(crate) base_ref: Option<String>,
    pub(crate) parent_ref: Option<String>,
    pub(crate) draft_base_paths: Vec<String>,
    pub(crate) capture_scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) entries: Vec<KernelCreateEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateBranchAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchReadParams {
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) roots: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteBeginParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAppendParams {
    pub(crate) builder_id: String,
    pub(crate) sequence: i64,
    pub(crate) changes: Vec<KernelBranchChange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteFinishParams {
    pub(crate) operation_id: String,
    pub(crate) builder_id: String,
    pub(crate) base_ref: Option<String>,
    pub(crate) parent_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchWriteAbortParams {
    pub(crate) builder_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPublishParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) expected_write_revision: i64,
    pub(crate) expected_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchPinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: Option<i64>,
    pub(crate) expected_write_revision: Option<i64>,
    pub(crate) expected_root: Option<String>,
    pub(crate) pin_id: Option<String>,
    pub(crate) persistent: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchUnpinParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
    pub(crate) pin_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDiffParams {
    pub(crate) left_root: String,
    pub(crate) right_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchObjectsParams {
    pub(crate) branch_id: String,
    pub(crate) include_revisions: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchDeleteParams {
    pub(crate) operation_id: String,
    pub(crate) branch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelPinReadParams {
    pub(crate) pin_id: String,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) roots: Option<Vec<String>>,
    pub(crate) include_entries: Option<bool>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationGetParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnStartParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: String,
    pub(crate) user_entry_id: String,
    pub(crate) worker_id: String,
    pub(crate) runtime_generation: i64,
    pub(crate) active_writer_scopes: Vec<String>,
    pub(crate) provenance: String,
    pub(crate) failure: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnGetParams {
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryTurnSettleParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) execution_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) status: String,
    pub(crate) observed_resource_ids: Vec<String>,
    pub(crate) unrecorded_resource_ids: Vec<String>,
    pub(crate) observation_complete: bool,
    pub(crate) active_writer_scopes: Vec<String>,
    pub(crate) provenance: String,
    pub(crate) assistant_entry_id: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) label: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryCheckpointListParams {
    pub(crate) workspace_id: String,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryEntryResolveParams {
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) entry_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeBeforeParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) tool_name: String,
    pub(crate) mutation_id: String,
    pub(crate) before_json: String,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeGetParams {
    pub(crate) workspace_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeListParams {
    pub(crate) workspace_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) execution_id: Option<String>,
    pub(crate) entry_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryChangeAfterParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_id: String,
    pub(crate) execution_id: String,
    pub(crate) checkpoint_id: String,
    pub(crate) path: String,
    pub(crate) after_json: String,
    pub(crate) succeeded: bool,
    pub(crate) expected_revision: i64,
    pub(crate) references: Vec<KernelRecoveryReference>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCreateParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) kind: String,
    pub(crate) state: String,
    pub(crate) data_json: String,
    pub(crate) files: Vec<KernelRecoveryOperationFile>,
    pub(crate) session_id: Option<String>,
    pub(crate) thread_id: Option<String>,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFileCasParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) path: String,
    pub(crate) expected_revision: i64,
    pub(crate) expected_phase: String,
    pub(crate) phase: String,
    pub(crate) observed_fingerprint: Option<String>,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationCompleteParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) result_json: Option<String>,
    pub(crate) failure_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationListParams {
    pub(crate) workspace_id: String,
    pub(crate) kind: Option<String>,
    pub(crate) cursor: Option<i64>,
    pub(crate) page_size: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationReleaseParams {
    pub(crate) transition_id: String,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationGetParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelOperationReleaseParams {
    pub(crate) operation_id: String,
    pub(crate) workspace_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelGcParams {
    pub(crate) operation_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeStartParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
    pub(crate) lane: String,
    pub(crate) operation: String,
    pub(crate) pin_id: Option<String>,
    pub(crate) root_id: Option<String>,
    pub(crate) objects: Option<Vec<KernelComputeObject>>,
    pub(crate) paths: Option<Vec<String>>,
    pub(crate) globs: Option<Vec<String>>,
    pub(crate) exclude_paths: Option<Vec<String>>,
    pub(crate) exclude_directories: Option<Vec<String>>,
    pub(crate) respect_gitignore: Option<bool>,
    pub(crate) include_hidden: Option<bool>,
    pub(crate) query: Option<String>,
    pub(crate) ignore_case: Option<bool>,
    pub(crate) fixed_strings: Option<bool>,
    pub(crate) max_results: Option<i64>,
    pub(crate) before: Option<i64>,
    pub(crate) after: Option<i64>,
    pub(crate) start_line: Option<i64>,
    pub(crate) end_line: Option<i64>,
    pub(crate) byte_offset: Option<i64>,
    pub(crate) byte_length: Option<i64>,
    pub(crate) immediate: Option<bool>,
    pub(crate) files: Option<Vec<KernelComputeFile>>,
    pub(crate) parse_budget_ms: Option<i64>,
    pub(crate) chunk_lines: Option<i64>,
    pub(crate) include_text: Option<bool>,
    pub(crate) include_tracked: Option<bool>,
    pub(crate) include_revisions: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeReadParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
    pub(crate) cursor: i64,
    pub(crate) max_bytes: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeHandleParams {
    pub(crate) workspace_id: String,
    pub(crate) job_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeGrammarParams {
    pub(crate) recipe_id: String,
    pub(crate) grammar_path: String,
    pub(crate) grammar_name: String,
    pub(crate) style: String,
    pub(crate) definition_query: String,
    pub(crate) import_query: Option<String>,
    pub(crate) literal_call_query: Option<String>,
    pub(crate) max_depth: Option<i64>,
    pub(crate) max_symbols: Option<i64>,
    pub(crate) grammar_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelProcessEnvironmentEntry {
    pub(crate) name: String,
    pub(crate) value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelFileLeaseResource {
    pub(crate) path: String,
    pub(crate) scope: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecordReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDiffStats {
    pub(crate) files: i64,
    pub(crate) insertions: i64,
    pub(crate) deletions: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingResultDocument {
    pub(crate) result_revision: i64,
    pub(crate) branch_id: String,
    pub(crate) parent_ref: Option<String>,
    pub(crate) changed_paths: Vec<String>,
    pub(crate) diff_stats: KernelWorkingDiffStats,
    pub(crate) created_at: String,
    pub(crate) root: String,
    pub(crate) base_root: String,
    pub(crate) base_states: Value,
    pub(crate) path_states: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingDraftDocument {
    pub(crate) id: String,
    pub(crate) workspace_id: String,
    pub(crate) branch_id: String,
    pub(crate) revision: i64,
    pub(crate) created_at: String,
    pub(crate) root: String,
    pub(crate) provenance: Vec<KernelDraftProvenance>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingVerificationDocument {
    pub(crate) result_revision: Option<i64>,
    pub(crate) merged_result_revision: Option<i64>,
    pub(crate) merge_operation_id: Option<String>,
    pub(crate) branch_id: Option<String>,
    pub(crate) result_tree_hash: Option<String>,
    pub(crate) parent_tree_hash: Option<String>,
    pub(crate) recorded_at: i64,
    pub(crate) window_opened_at: Option<i64>,
    pub(crate) draft_unsaved: Option<bool>,
    pub(crate) note: Option<String>,
    pub(crate) binding: String,
    pub(crate) binding_reason: Option<String>,
    pub(crate) checks: Vec<KernelCommandVerificationRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelWorkingReviewDocument {
    pub(crate) result_revision: i64,
    pub(crate) status: String,
    pub(crate) recorded_at: i64,
    pub(crate) review_thread_id: Option<String>,
    pub(crate) review_run_id: Option<String>,
    pub(crate) gate: Option<bool>,
    pub(crate) conclusion: Option<String>,
    pub(crate) findings: Option<Vec<KernelReviewFinding>>,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCreateEntry {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelBranchChange {
    pub(crate) path: String,
    pub(crate) state: PathState,
    pub(crate) owner_id: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) source_record_id: Option<String>,
    pub(crate) source_slot: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryReference {
    pub(crate) slot: String,
    pub(crate) object_hash: String,
    pub(crate) owner_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelRecoveryOperationFile {
    pub(crate) path: String,
    pub(crate) expected_json: Option<String>,
    pub(crate) target_json: Option<String>,
    pub(crate) safety_json: Option<String>,
    pub(crate) phase: Option<String>,
    pub(crate) references: Option<Vec<KernelRecoveryReference>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeObject {
    pub(crate) path: String,
    pub(crate) revision: String,
    pub(crate) object_hash: Option<String>,
    pub(crate) owner_id: Option<String>,
    pub(crate) missing: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelComputeFile {
    pub(crate) path: String,
    pub(crate) recipe_id: Option<String>,
    pub(crate) revision: Option<String>,
    pub(crate) unchanged_revision: Option<String>,
    pub(crate) lines: Option<Vec<i64>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelDraftProvenance {
    pub(crate) path: String,
    pub(crate) base_revision: RequiredNullable<String>,
    pub(crate) encoding: String,
    pub(crate) bom: bool,
    pub(crate) local_edit_revision: i64,
    pub(crate) revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelCommandVerificationRecord {
    pub(crate) id: String,
    pub(crate) run_id: String,
    pub(crate) command: String,
    pub(crate) cwd: String,
    pub(crate) env_summary: Option<KernelVerificationEnvSummary>,
    pub(crate) command_run_id: Option<String>,
    pub(crate) started_at: i64,
    pub(crate) ended_at: i64,
    pub(crate) exit_code: RequiredNullable<i64>,
    pub(crate) cancelled: bool,
    pub(crate) output_handle: Option<String>,
    pub(crate) output_preview: Option<String>,
    pub(crate) actor: KernelVerificationActor,
    pub(crate) binding_generation: i64,
    pub(crate) input_identity: KernelVerificationInputIdentity,
    pub(crate) input_changed_during_run: RequiredNullable<bool>,
    pub(crate) relation_to_published: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelReviewFinding {
    pub(crate) severity: String,
    pub(crate) file: Option<String>,
    pub(crate) line: Option<i64>,
    pub(crate) message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationEnvSummary {
    pub(crate) path: Option<bool>,
    pub(crate) virtual_env: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationActor {
    pub(crate) authority_instance_id: String,
    pub(crate) session_id: String,
    pub(crate) worker_id: String,
    pub(crate) worker_generation: i64,
    pub(crate) run_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KernelVerificationInputIdentity {
    pub(crate) kind: String,
    pub(crate) branch_id: Option<String>,
    pub(crate) root: Option<String>,
    pub(crate) start_tree_hash: Option<String>,
    pub(crate) end_tree_hash: Option<String>,
    pub(crate) reason: Option<String>,
}

pub(crate) fn validate_generated_method_params(method: &str, params: &Value) -> Result<(), String> {
    match method {
        "runtime.status" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.thread.create" => {
            serde_json::from_value::<NativeThreadCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.input.submit" => serde_json::from_value::<NativeInputSubmitParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.inspect" => serde_json::from_value::<NativeRunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.run.cancel" => serde_json::from_value::<NativeRunParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.operation.inspect" => {
            serde_json::from_value::<NativeOperationParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.operation.cancel" => {
            serde_json::from_value::<NativeOperationParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "runtime.history.read" => serde_json::from_value::<NativeHistoryParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "runtime.events.read" => serde_json::from_value::<NativeEventsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.spawn" => serde_json::from_value::<KernelProcessSpawnParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.read" => serde_json::from_value::<KernelProcessReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.write" => serde_json::from_value::<KernelProcessWriteParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.resize" => serde_json::from_value::<KernelProcessResizeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.kill" => serde_json::from_value::<KernelProcessKillParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.inspect" => serde_json::from_value::<KernelProcessHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.list" => serde_json::from_value::<KernelProcessListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "process.release" => serde_json::from_value::<KernelProcessHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.handshake" => serde_json::from_value::<KernelHandshakeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.ping" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "kernel.shutdown" => serde_json::from_value::<KernelEmptyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.health" => serde_json::from_value::<KernelHealthParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "authority.grant.issue" => serde_json::from_value::<KernelGrantIssueParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "authority.grant.revoke" => {
            serde_json::from_value::<KernelGrantRevokeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.snapshot" => serde_json::from_value::<KernelSnapshotParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.putBlob.begin" => {
            serde_json::from_value::<KernelPutBlobBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.chunk" => {
            serde_json::from_value::<KernelPutBlobChunkParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.finish" => {
            serde_json::from_value::<KernelPutBlobFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.putBlob.abort" => {
            serde_json::from_value::<KernelPutBlobAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.blob.release" => serde_json::from_value::<KernelBlobReleaseParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.getBlob" => serde_json::from_value::<KernelGetBlobParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.object.rebindOwner" => {
            serde_json::from_value::<KernelObjectOwnerRebindParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.root.register" => {
            serde_json::from_value::<KernelFileRootRegisterParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.operation.list" => {
            serde_json::from_value::<KernelFileOperationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.operation.reconcile" => {
            serde_json::from_value::<KernelFileOperationReconcileParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.acquire" => {
            serde_json::from_value::<KernelFileLeaseAcquireParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.check" => {
            serde_json::from_value::<KernelFileLeaseAcquireParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.lease.release" => {
            serde_json::from_value::<KernelFileLeaseReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "file.capture" => serde_json::from_value::<KernelFileCaptureParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.apply" => serde_json::from_value::<KernelFileApplyParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.mkdir" => serde_json::from_value::<KernelFileMkdirParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.remove" => serde_json::from_value::<KernelFileRemoveParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.rename" => serde_json::from_value::<KernelFileRenameParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.scan" => serde_json::from_value::<KernelFileScanParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.measure" => serde_json::from_value::<KernelFileMeasureParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "file.materialize" => serde_json::from_value::<KernelFileMaterializeParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.put" => serde_json::from_value::<KernelRecordPutParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.get" => serde_json::from_value::<KernelRecordGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.list" => serde_json::from_value::<KernelRecordListParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "storage.record.workspaces" => {
            serde_json::from_value::<KernelRecordWorkspacesParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.record.release" => {
            serde_json::from_value::<KernelRecordReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.put" => {
            serde_json::from_value::<KernelWorkingResultPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.get" => {
            serde_json::from_value::<KernelWorkingResultGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.list" => {
            serde_json::from_value::<KernelWorkingResultListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.result.release" => {
            serde_json::from_value::<KernelWorkingResultReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.put" => {
            serde_json::from_value::<KernelWorkingDraftPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.get" => {
            serde_json::from_value::<KernelWorkingDraftGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.list" => {
            serde_json::from_value::<KernelWorkingDraftListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.draft.release" => {
            serde_json::from_value::<KernelWorkingDraftReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.put" => {
            serde_json::from_value::<KernelWorkingVerificationPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.list" => {
            serde_json::from_value::<KernelWorkingVerificationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.release" => {
            serde_json::from_value::<KernelWorkingVerificationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.put" => {
            serde_json::from_value::<KernelWorkingReviewPutParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.list" => {
            serde_json::from_value::<KernelWorkingReviewListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review.release" => {
            serde_json::from_value::<KernelWorkingReviewReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.begin" => {
            serde_json::from_value::<KernelCreateBranchBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.append" => {
            serde_json::from_value::<KernelCreateBranchAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.finish" => {
            serde_json::from_value::<KernelCreateBranchFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.create.abort" => {
            serde_json::from_value::<KernelCreateBranchAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.read" => serde_json::from_value::<KernelBranchReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.write.begin" => {
            serde_json::from_value::<KernelBranchWriteBeginParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.append" => {
            serde_json::from_value::<KernelBranchWriteAppendParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.finish" => {
            serde_json::from_value::<KernelBranchWriteFinishParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.write.abort" => {
            serde_json::from_value::<KernelBranchWriteAbortParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "branch.publish" => serde_json::from_value::<KernelBranchPublishParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.pin" => serde_json::from_value::<KernelBranchPinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.unpin" => serde_json::from_value::<KernelBranchUnpinParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.diff" => serde_json::from_value::<KernelBranchDiffParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.objects" => serde_json::from_value::<KernelBranchObjectsParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "branch.delete" => serde_json::from_value::<KernelBranchDeleteParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "pin.read" => serde_json::from_value::<KernelPinReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "recovery.operation.get" => {
            serde_json::from_value::<KernelRecoveryOperationGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.start" => {
            serde_json::from_value::<KernelRecoveryTurnStartParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.get" => {
            serde_json::from_value::<KernelRecoveryTurnGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.turn.settle" => {
            serde_json::from_value::<KernelRecoveryTurnSettleParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.create" => {
            serde_json::from_value::<KernelRecoveryCheckpointCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.checkpoint.list" => {
            serde_json::from_value::<KernelRecoveryCheckpointListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.entry.resolve" => {
            serde_json::from_value::<KernelRecoveryEntryResolveParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.before" => {
            serde_json::from_value::<KernelRecoveryChangeBeforeParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.get" => {
            serde_json::from_value::<KernelRecoveryChangeGetParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.list" => {
            serde_json::from_value::<KernelRecoveryChangeListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.change.after" => {
            serde_json::from_value::<KernelRecoveryChangeAfterParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.create" => {
            serde_json::from_value::<KernelRecoveryOperationCreateParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.file.cas" => {
            serde_json::from_value::<KernelRecoveryOperationFileCasParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.complete" => {
            serde_json::from_value::<KernelRecoveryOperationCompleteParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.list" => {
            serde_json::from_value::<KernelRecoveryOperationListParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "recovery.operation.release" => {
            serde_json::from_value::<KernelRecoveryOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "operation.get" => serde_json::from_value::<KernelOperationGetParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "operation.release" => {
            serde_json::from_value::<KernelOperationReleaseParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "storage.gc" => serde_json::from_value::<KernelGcParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.start" => serde_json::from_value::<KernelComputeStartParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.read" => serde_json::from_value::<KernelComputeReadParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.cancel" => serde_json::from_value::<KernelComputeHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.release" => serde_json::from_value::<KernelComputeHandleParams>(params.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "compute.grammar.register" => {
            serde_json::from_value::<KernelComputeGrammarParams>(params.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        _ => Ok(()),
    }
}

pub(crate) fn validate_generated_working_document(
    record_type: &str,
    document: &Value,
) -> Result<(), String> {
    match record_type {
        "working.result" => serde_json::from_value::<KernelWorkingResultDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.draft" => serde_json::from_value::<KernelWorkingDraftDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        "working.verification.child" => {
            serde_json::from_value::<KernelWorkingVerificationDocument>(document.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.verification.parent" => {
            serde_json::from_value::<KernelWorkingVerificationDocument>(document.clone())
                .map(|_| ())
                .map_err(|error| error.to_string())
        }
        "working.review" => serde_json::from_value::<KernelWorkingReviewDocument>(document.clone())
            .map(|_| ())
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}
