//! Durable product records and their object references.
use super::*;
use sha2::{Digest, Sha256};

impl Storage {
    fn working_reference_map(params: &Value) -> Result<BTreeMap<String, String>, KernelError> {
        let references = params
            .get("references")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Operation("working record references are required".to_string())
            })?;
        let mut mapped = BTreeMap::new();
        for reference in references {
            let slot = reference
                .get("slot")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("working record reference slot is malformed".to_string())
                })?;
            let hash = reference
                .get("objectHash")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("sha256-"))
                .ok_or_else(|| {
                    KernelError::Operation("working record reference hash is malformed".to_string())
                })?;
            if mapped.insert(slot.to_string(), hash.to_string()).is_some() {
                return Err(KernelError::Operation(
                    "working record reference slots must be unique".to_string(),
                ));
            }
        }
        Ok(mapped)
    }

    fn require_no_working_owner_ids(params: &Value) -> Result<(), KernelError> {
        let owners = params
            .get("ownerIds")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                KernelError::Operation("working record ownerIds are required".to_string())
            })?;
        if !owners.is_empty() {
            return Err(KernelError::Operation(
                "working records reference published roots and cannot consume temporary owners"
                    .to_string(),
            ));
        }
        Ok(())
    }

    pub(super) fn validate_domain_record_identity(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<String, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        for key in ["sessionId", "threadId", "runId"] {
            if let Some(value) = params_value.get(key).and_then(Value::as_str) {
                let expected = match key {
                    "sessionId" => grant.session_id.as_deref(),
                    "threadId" => grant.thread_id.as_deref(),
                    _ => grant.run_id.as_deref(),
                };
                if let Some(expected) = expected {
                    if expected != value {
                        return Err(KernelError::Authorization(format!(
                            "record {key} does not match actor grant"
                        )));
                    }
                } else if !grant.capabilities.contains("recovery.maintenance")
                    && !grant.capabilities.contains("storage.maintenance")
                    && !grant.capabilities.contains("storage.admin")
                {
                    return Err(KernelError::Authorization(format!(
                        "record {key} requires an actor-bound grant"
                    )));
                }
            }
        }
        Ok(workspace_id.to_string())
    }

    pub(super) fn validate_domain_record_payload(
        record_type: &str,
        record_id: &str,
        workspace_id: &str,
        state: &str,
        envelope_session_id: Option<&str>,
        payload: &Value,
    ) -> Result<(), KernelError> {
        let object = payload.as_object().ok_or_else(|| {
            KernelError::Operation("typed record payload must be an object".to_string())
        })?;
        let same = |field: &str, expected: &str| -> Result<(), KernelError> {
            if let Some(value) = object.get(field).and_then(Value::as_str) {
                if value != expected {
                    return Err(KernelError::Operation(format!(
                        "typed record {field} does not match its identity"
                    )));
                }
            }
            Ok(())
        };
        let required = |field: &str| -> Result<&str, KernelError> {
            object
                .get(field)
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation(format!("typed record {field} is required"))
                })
        };
        let derived = |prefix: &str| -> Result<(), KernelError> {
            let id = required("id")?;
            if record_id != format!("{prefix}:{id}") {
                return Err(KernelError::Operation(format!(
                    "typed record recordId is not derived from its {prefix} id"
                )));
            }
            Ok(())
        };
        let state_in = |states: &[&str]| -> Result<(), KernelError> {
            if !states.contains(&state) {
                return Err(KernelError::Operation(format!(
                    "typed record state is invalid: {state}"
                )));
            }
            Ok(())
        };
        match record_type {
            "recovery.checkpoint" => {
                same("id", record_id)?;
                same("workspaceId", workspace_id)?;
                if !matches!(state, "pending" | "ready" | "incomplete" | "failed") {
                    return Err(KernelError::Operation(
                        "checkpoint state is invalid".to_string(),
                    ));
                }
                if let Some(sequence) = object.get("sequence") {
                    if sequence.as_i64().is_none_or(|value| value < 0) {
                        return Err(KernelError::Operation(
                            "checkpoint sequence is invalid".to_string(),
                        ));
                    }
                }
            }
            "recovery.turn" => {
                let execution = object
                    .get("executionId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        KernelError::Operation("turn executionId is required".to_string())
                    })?;
                if record_id != format!("recovery.turn:{execution}") {
                    return Err(KernelError::Operation(
                        "turn recordId is not derived from executionId".to_string(),
                    ));
                }
                same("workspaceId", workspace_id)?;
                if object.get("sessionId").and_then(Value::as_str).is_none()
                    || object.get("checkpointId").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "turn identity is incomplete".to_string(),
                    ));
                }
                if !matches!(state, "pending" | "ready" | "incomplete" | "failed") {
                    return Err(KernelError::Operation("turn state is invalid".to_string()));
                }
            }
            "recovery.change" => {
                if object.get("checkpointId").and_then(Value::as_str).is_none()
                    || object.get("path").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "change identity is incomplete".to_string(),
                    ));
                }
                if object.get("before").is_none() && object.get("beforeJson").is_none() {
                    return Err(KernelError::Operation(
                        "change before state is required".to_string(),
                    ));
                }
            }
            "recovery.operation" => {
                same("id", record_id)?;
                same("workspaceId", workspace_id)?;
                if object.get("kind").and_then(Value::as_str).is_none() {
                    return Err(KernelError::Operation(
                        "operation kind is required".to_string(),
                    ));
                }
            }
            "research.source" => {
                derived("research.source")?;
                same("workspaceId", workspace_id)?;
                required("kind")?;
                if object.get("uri").and_then(Value::as_str).is_none()
                    && object.get("path").and_then(Value::as_str).is_none()
                    && object.get("objectHash").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "research source requires a uri, path or objectHash locator".to_string(),
                    ));
                }
                state_in(&["available", "retired"])?;
            }
            "experiment.spec" => {
                derived("experiment.spec")?;
                same("workspaceId", workspace_id)?;
                required("command")?;
                if let Some(args) = object.get("args") {
                    if !args.is_array()
                        || !args
                            .as_array()
                            .is_some_and(|items| items.iter().all(|item| item.is_string()))
                    {
                        return Err(KernelError::Operation(
                            "experiment spec args must be a string array".to_string(),
                        ));
                    }
                }
                state_in(&["active", "retired"])?;
            }
            "experiment.attempt" => {
                derived("experiment.attempt")?;
                required("specId")?;
                required("backend")?;
                state_in(&[
                    "submitted",
                    "queued",
                    "running",
                    "stopping",
                    "completed",
                    "failed",
                    "cancelled",
                    "lost",
                ])?;
            }
            "experiment.job" => {
                derived("experiment.job")?;
                required("attemptId")?;
                required("backend")?;
                state_in(&[
                    "starting",
                    "running",
                    "exited",
                    "failed",
                    "cancelled",
                    "unknown",
                    "released",
                ])?;
            }
            "experiment.artifact" => {
                derived("experiment.artifact")?;
                required("attemptId")?;
                required("name")?;
                state_in(&["pending", "available", "failed", "expired"])?;
            }
            "followup.definition" => {
                derived("followup.definition")?;
                if required("workspaceId")? != workspace_id {
                    return Err(KernelError::Operation(
                        "followup definition workspaceId does not match its envelope".to_string(),
                    ));
                }
                let session_id = required("sessionId")?;
                if envelope_session_id != Some(session_id) {
                    return Err(KernelError::Operation(
                        "followup definition sessionId does not match its envelope".to_string(),
                    ));
                }
                required("instruction")?;
                if object
                    .get("experimentCaller")
                    .is_none_or(|value| !value.is_object())
                {
                    return Err(KernelError::Operation(
                        "followup definition requires experimentCaller authority".to_string(),
                    ));
                }
                for field in ["createdAt", "updatedAt"] {
                    if object.get(field).and_then(Value::as_u64).is_none() {
                        return Err(KernelError::Operation(format!(
                            "followup definition {field} must be an epoch millisecond"
                        )));
                    }
                }
                let source = object
                    .get("source")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        KernelError::Operation(
                            "followup definition requires a source object".to_string(),
                        )
                    })?;
                let source_kind = source.get("kind").and_then(Value::as_str).unwrap_or("");
                let source_kinds = [
                    "time",
                    "experiment",
                    "artifact",
                    "file",
                    "log",
                    "metric",
                    "external",
                    "shell",
                    "manual",
                    "any",
                    "all",
                ];
                if !source_kinds.contains(&source_kind) {
                    return Err(KernelError::Operation(
                        "followup definition source.kind is invalid".to_string(),
                    ));
                }
                if matches!(source_kind, "any" | "all") {
                    let children = source
                        .get("sources")
                        .and_then(Value::as_array)
                        .filter(|v| !v.is_empty())
                        .ok_or_else(|| {
                            KernelError::Operation(
                                "followup composite source requires children".to_string(),
                            )
                        })?;
                    if children.iter().any(|child| {
                        child
                            .as_object()
                            .and_then(|item| item.get("kind"))
                            .and_then(Value::as_str)
                            .is_none_or(|kind| !source_kinds[..9].contains(&kind))
                    }) {
                        return Err(KernelError::Operation(
                            "followup composite child source is invalid".to_string(),
                        ));
                    }
                }
                state_in(&[
                    "waiting",
                    "triggered",
                    "delivering",
                    "delivered",
                    "cancelled",
                    "superseded",
                    "unavailable",
                ])?;
            }
            "followup.occurrence" => {
                derived("followup.occurrence")?;
                required("followUpId")?;
                required("reason")?;
                if object.get("facts").is_none_or(|value| !value.is_object())
                    || object.get("at").and_then(Value::as_u64).is_none()
                {
                    return Err(KernelError::Operation(
                        "followup occurrence requires object facts and epoch at".to_string(),
                    ));
                }
                state_in(&["recorded", "delivering", "delivered", "held", "dropped"])?;
            }
            "followup.observation" => {
                derived("followup.observation")?;
                if required("workspaceId")? != workspace_id {
                    return Err(KernelError::Operation(
                        "followup observation workspaceId does not match its envelope".to_string(),
                    ));
                }
                let source_kind = required("sourceKind")?;
                if !["file", "metric", "shell"].contains(&source_kind) {
                    return Err(KernelError::Operation(
                        "followup observation sourceKind is invalid".to_string(),
                    ));
                }
                let payload_session_id = object.get("sessionId").and_then(Value::as_str);
                let session_identity_matches = if source_kind == "shell" {
                    payload_session_id.is_some() && payload_session_id == envelope_session_id
                } else {
                    payload_session_id.is_none() && envelope_session_id.is_none()
                };
                if !session_identity_matches {
                    return Err(KernelError::Operation(
                        "followup observation session identity does not match its source/envelope"
                            .to_string(),
                    ));
                }
                required("sourceKey")?;
                required("eventId")?;
                if object.get("at").and_then(Value::as_u64).is_none()
                    || object.get("facts").is_none_or(|value| !value.is_object())
                {
                    return Err(KernelError::Operation(
                        "followup observation requires epoch at and object facts".to_string(),
                    ));
                }
                state_in(&["available", "expired"])?;
            }
            "settings.operation" => {
                let id = required("id")?;
                let entry_id = required("entryId")?;
                let session_id = required("sessionId")?;
                let envelope_session_id = envelope_session_id.ok_or_else(|| {
                    KernelError::Operation(
                        "settings operation envelope sessionId is required".to_string(),
                    )
                })?;
                if session_id != envelope_session_id {
                    return Err(KernelError::Operation(
                        "settings operation payload sessionId does not match its envelope"
                            .to_string(),
                    ));
                }
                let payload_state = required("state")?;
                if payload_state != state {
                    return Err(KernelError::Operation(
                        "settings operation payload state does not match its envelope".to_string(),
                    ));
                }
                required("verb")?;
                required("createdAt")?;
                required("updatedAt")?;
                same("workspaceId", workspace_id)?;
                let identity = format!("{session_id}\0{entry_id}\0{id}");
                let expected_record_id = format!(
                    "settings.operation:{}",
                    hex::encode(Sha256::digest(identity.as_bytes()))
                );
                if record_id != expected_record_id {
                    return Err(KernelError::Operation(
                        "settings operation recordId does not match its caller/entry/owner identity".to_string(),
                    ));
                }
                state_in(&["running", "succeeded", "failed", "cancelled", "unavailable"])?;
            }
            "resource.machine" => {
                derived("resource.machine")?;
                required("kind")?;
                state_in(&["available", "degraded", "offline", "retired"])?;
            }
            "resource.commitment" => {
                derived("resource.commitment")?;
                required("machineId")?;
                if !object.get("resources").is_some_and(Value::is_object) {
                    return Err(KernelError::Operation(
                        "resource commitment requires a resources object".to_string(),
                    ));
                }
                state_in(&["requested", "confirmed", "released", "revoked", "failed"])?;
            }
            "resource.sample" => {
                let machine = required("machineId")?;
                if record_id != format!("resource.sample:{machine}") {
                    return Err(KernelError::Operation(
                        "typed record recordId is not derived from its resource.sample machineId"
                            .to_string(),
                    ));
                }
                if object.get("observedAt").and_then(Value::as_i64).is_none() {
                    return Err(KernelError::Operation(
                        "resource sample observedAt is required".to_string(),
                    ));
                }
                required("source")?;
                state_in(&["observed", "stale"])?;
            }
            "managed.remote.object" => {
                derived("managed.remote.object")?;
                required("objectHash")?;
                if object.get("byteLength").and_then(Value::as_i64).is_none_or(|value| value < 0) {
                    return Err(KernelError::Operation(
                        "managed remote object byteLength is invalid".to_string(),
                    ));
                }
                state_in(&["available", "expired"])?;
            }
            "managed.remote.admission" => {
                derived("managed.remote.admission")?;
                required("principalId")?;
                required("coordinatorHostId")?;
                required("sourceWorkspaceId")?;
                required("machineId")?;
                required("attemptId")?;
                required("commitmentId")?;
                state_in(&["confirmed", "released", "revoked", "failed"])?;
            }
            "managed.remote.material" => {
                derived("managed.remote.material")?;
                required("materialId")?;
                required("root")?;
                required("rootId")?;
                required("canonicalRoot")?;
                state_in(&["ready", "expired"])?;
            }
            "managed.remote.job" => {
                derived("managed.remote.job")?;
                required("principalId")?;
                required("coordinatorHostId")?;
                required("attemptId")?;
                required("backendJobId")?;
                required("processId")?;
                state_in(&[
                    "accepted",
                    "running",
                    "stopping",
                    "exited",
                    "failed",
                    "cancelled",
                    "unknown",
                    "released",
                ])?;
            }
            "managed.remote.output" => {
                derived("managed.remote.output")?;
                required("principalId")?;
                required("jobId")?;
                required("path")?;
                required("objectHash")?;
                if object.get("byteLength").and_then(Value::as_i64).is_none_or(|value| value < 0) {
                    return Err(KernelError::Operation(
                        "managed remote output byteLength is invalid".to_string(),
                    ));
                }
                state_in(&["available", "expired"])?;
            }
            "managed.remote.shell" => {
                derived("managed.remote.shell")?;
                required("principalId")?;
                required("coordinatorHostId")?;
                required("toolCallId")?;
                required("processId")?;
                required("command")?;
                required("canonicalCwd")?;
                state_in(&["accepted", "released"])?;
            }
            "recovery.operation-file" => {
                if object.get("operationId").and_then(Value::as_str).is_none()
                    || object.get("path").and_then(Value::as_str).is_none()
                {
                    return Err(KernelError::Operation(
                        "operation-file identity is incomplete".to_string(),
                    ));
                }
                if !matches!(
                    state,
                    "pending"
                        | "apply-intent"
                        | "target-observed"
                        | "compensate-intent"
                        | "safety-observed"
                        | "needs-attention"
                        | "external-intent"
                        | "external-dispatched"
                        | "external-safety-observed"
                ) {
                    return Err(KernelError::Operation(
                        "operation-file phase is invalid".to_string(),
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn grant_can_access_domain_record(
        &self,
        value: &Value,
        grant_id: &str,
    ) -> Result<bool, KernelError> {
        let grant = self.load_grant(grant_id)?;
        if grant.capabilities.contains("recovery.maintenance")
            || grant.capabilities.contains("storage.maintenance")
            || grant.capabilities.contains("storage.admin")
        {
            return Ok(true);
        }
        for key in ["sessionId", "threadId", "runId"] {
            let record_value = value.get(key).and_then(Value::as_str);
            let grant_value = match key {
                "sessionId" => grant.session_id.as_deref(),
                "threadId" => grant.thread_id.as_deref(),
                _ => grant.run_id.as_deref(),
            };
            if record_value.is_some() && grant_value.is_some() && record_value != grant_value {
                return Ok(false);
            }
            if record_value.is_some()
                && grant_value.is_none()
                && !grant.capabilities.contains("storage.admin")
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(super) fn domain_record_value(
        &self,
        workspace_id: &str,
        record_id: &str,
    ) -> Result<Option<Value>, KernelError> {
        let row: Option<(
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<i64>,
            Option<i64>,
            i64,
            String,
            i64,
            i64,
        )> = self
            .conn
            .query_row(
                "SELECT record_id, workspace_id, record_type, state, session_id, thread_id, run_id, branch_id, revision, result_revision, record_revision, payload_json, created_at, updated_at FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                        row.get(13)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            record_id,
            workspace_id,
            record_type,
            state,
            session_id,
            thread_id,
            run_id,
            branch_id,
            revision,
            result_revision,
            record_revision,
            payload_json,
            created_at,
            updated_at,
        )) = row
        else {
            return Ok(None);
        };
        let references = self
            .conn
            .prepare("SELECT slot, object_hash FROM domain_record_refs WHERE record_id = ?1 AND workspace_id = ?2 ORDER BY slot")?
            .query_map(params![record_id, workspace_id], |row| {
                Ok(json!({"slot": row.get::<_, String>(0)?, "objectHash": row.get::<_, String>(1)?}))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let payload = serde_json::from_str::<Value>(&payload_json).map_err(|error| {
            KernelError::Storage(format!("domain record payload is corrupt: {error}"))
        })?;
        Ok(Some(json!({
            "recordId": record_id,
            "workspaceId": workspace_id,
            "recordType": record_type,
            "state": state,
            "sessionId": session_id,
            "threadId": thread_id,
            "runId": run_id,
            "branchId": branch_id,
            "revision": revision,
            "resultRevision": result_revision,
            "recordRevision": record_revision,
            "payloadJson": serde_json::to_string(&payload)?,
            "references": references,
            "createdAt": created_at,
            "updatedAt": updated_at,
        })))
    }

    pub(super) fn domain_record_put(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.domain_record_put_inner(params_value, grant_id, false)
    }

    fn domain_record_put_inner(
        &mut self,
        params_value: &Value,
        grant_id: &str,
        allow_working_record: bool,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.validate_domain_record_identity(params_value, grant_id)?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        let record_type = params_value
            .get("recordType")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordType is required".to_string()))?;
        const KNOWN_RECORD_TYPES: &[&str] = &[
            "working.draft",
            "working.result",
            "working.verification.child",
            "working.verification.parent",
            "working.review",
            "retrieval.artifact",
            "retrieval.receipt",
            "retrieval.evidence",
            "agent.source-view",
            "recovery.metadata",
            "recovery.checkpoint",
            "recovery.change",
            "recovery.turn",
            "recovery.operation",
            "recovery.operation-file",
            "research.source",
            "experiment.spec",
            "experiment.attempt",
            "experiment.job",
            "experiment.artifact",
            "resource.machine",
            "resource.commitment",
            "resource.sample",
            "managed.remote.object",
            "managed.remote.admission",
            "managed.remote.material",
            "managed.remote.job",
            "managed.remote.output",
            "managed.remote.shell",
            "followup.definition",
            "followup.occurrence",
            "followup.observation",
            "settings.operation",
        ];
        if !KNOWN_RECORD_TYPES.contains(&record_type)
            && !(record_type.starts_with("retrieval.evidence.")
                && record_type.len() > "retrieval.evidence.".len())
        {
            return Err(KernelError::Operation(format!(
                "recordType is not supported: {record_type}"
            )));
        }
        if !allow_working_record
            && matches!(
                record_type,
                "working.draft"
                    | "working.result"
                    | "working.verification.child"
                    | "working.verification.parent"
                    | "working.review"
            )
        {
            return Err(KernelError::Operation(format!(
                "{record_type} must use its typed working record method"
            )));
        }
        let state = params_value
            .get("state")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("record state is required".to_string()))?;
        let payload_json = params_value
            .get("payloadJson")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("payloadJson is required".to_string()))?;
        let payload: Value = serde_json::from_str(payload_json).map_err(|error| {
            KernelError::Operation(format!("payloadJson is malformed: {error}"))
        })?;
        if !payload.is_object() {
            return Err(KernelError::Operation(
                "payloadJson must contain an object".to_string(),
            ));
        }
        Self::validate_domain_record_payload(
            record_type,
            record_id,
            &workspace_id,
            state,
            params_value.get("sessionId").and_then(Value::as_str),
            &payload,
        )?;
        let references = params_value
            .get("references")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("record references are required".to_string()))?;
        let owner_ids = params_value
            .get("ownerIds")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Operation("record ownerIds are required".to_string()))?;
        let mut owner_hashes = BTreeMap::new();
        for owner in owner_ids {
            let owner_id = owner
                .as_str()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| KernelError::Operation("record ownerId is malformed".to_string()))?;
            let hash: String = self
                .conn
                .query_row(
                    "SELECT blob_hash FROM object_owners WHERE owner_id = ?1 AND workspace_id = ?2 AND grant_id = ?3",
                    params![owner_id, workspace_id, grant_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| KernelError::Authorization(format!("record owner is not valid: {owner_id}")))?;
            owner_hashes.insert(owner_id.to_string(), hash);
        }
        let mut normalized_refs = Vec::new();
        let mut slots = BTreeSet::new();
        for reference in references {
            let slot = reference
                .get("slot")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("record reference slot is malformed".to_string())
                })?;
            if !slots.insert(slot.to_string()) {
                return Err(KernelError::Operation(
                    "record reference slots must be unique".to_string(),
                ));
            }
            let hash = reference
                .get("objectHash")
                .and_then(Value::as_str)
                .filter(|value| value.starts_with("sha256-"))
                .ok_or_else(|| {
                    KernelError::Operation("record reference objectHash is malformed".to_string())
                })?;
            let owner_matches = owner_hashes.values().any(|owner_hash| owner_hash == hash);
            let durable = self
                .conn
                .query_row(
                    "SELECT 1 FROM blobs WHERE hash = ?1 AND (EXISTS (SELECT 1 FROM domain_record_refs WHERE object_hash = ?1 AND workspace_id = ?2) OR EXISTS (SELECT 1 FROM root_blobs WHERE blob_hash = ?1))",
                    params![hash, workspace_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            if !owner_matches && !durable {
                return Err(KernelError::Authorization(
                    "record reference must consume an owner or existing durable reference"
                        .to_string(),
                ));
            }
            normalized_refs.push((slot.to_string(), hash.to_string()));
        }
        let existing = self
            .conn
            .query_row(
                "SELECT workspace_id, record_type, record_revision, revision, session_id, thread_id, run_id, branch_id, result_revision FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<i64>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<String>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<i64>>(8)?)),
            )
            .optional()?;
        let expected_record_revision = params_value
            .get("expectedRecordRevision")
            .and_then(Value::as_i64);
        let record_revision = existing.as_ref().map_or(1, |row| row.2 + 1);
        if let Some((
            existing_workspace,
            existing_type,
            existing_record_revision,
            existing_revision,
            existing_session,
            existing_thread,
            existing_run,
            existing_branch,
            existing_result_revision,
        )) = existing
        {
            if existing_workspace != workspace_id || existing_type != record_type {
                return Err(KernelError::Authorization(
                    "record identity cannot be changed".to_string(),
                ));
            }
            for (label, old, new) in [
                (
                    "sessionId",
                    existing_session.as_deref(),
                    params_value.get("sessionId").and_then(Value::as_str),
                ),
                (
                    "threadId",
                    existing_thread.as_deref(),
                    params_value.get("threadId").and_then(Value::as_str),
                ),
                (
                    "runId",
                    existing_run.as_deref(),
                    params_value.get("runId").and_then(Value::as_str),
                ),
                (
                    "branchId",
                    existing_branch.as_deref(),
                    params_value.get("branchId").and_then(Value::as_str),
                ),
            ] {
                if old != new {
                    return Err(KernelError::Authorization(format!(
                        "record {label} identity cannot be changed"
                    )));
                }
            }
            if existing_result_revision
                != params_value.get("resultRevision").and_then(Value::as_i64)
            {
                return Err(KernelError::Authorization(
                    "record resultRevision identity cannot be changed".to_string(),
                ));
            }
            if existing_revision != params_value.get("revision").and_then(Value::as_i64) {
                return Err(KernelError::Authorization(
                    "record revision identity cannot be changed".to_string(),
                ));
            }
            let expected = expected_record_revision.ok_or_else(|| {
                KernelError::Operation("record update requires expectedRecordRevision".to_string())
            })?;
            if existing_record_revision != expected {
                return Err(KernelError::Operation(
                    "record revision conflict".to_string(),
                ));
            }
        } else if expected_record_revision.is_some() {
            return Err(KernelError::Operation(
                "record revision conflict: record does not exist".to_string(),
            ));
        }
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO domain_records(record_id, workspace_id, record_type, state, session_id, thread_id, run_id, branch_id, revision, result_revision, record_revision, payload_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, COALESCE((SELECT created_at FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2), ?13), ?13) ON CONFLICT(workspace_id, record_id) DO UPDATE SET state = excluded.state, record_revision = excluded.record_revision, payload_json = excluded.payload_json, updated_at = excluded.updated_at",
            params![record_id, workspace_id, record_type, state, params_value.get("sessionId").and_then(Value::as_str), params_value.get("threadId").and_then(Value::as_str), params_value.get("runId").and_then(Value::as_str), params_value.get("branchId").and_then(Value::as_str), params_value.get("revision").and_then(Value::as_i64), params_value.get("resultRevision").and_then(Value::as_i64), record_revision, serde_json::to_string(&payload)?, now],
        )?;
        self.conn.execute(
            "DELETE FROM domain_record_refs WHERE workspace_id = ?1 AND record_id = ?2",
            params![workspace_id, record_id],
        )?;
        for (slot, hash) in &normalized_refs {
            self.conn.execute("INSERT INTO domain_record_refs(workspace_id, record_id, slot, object_hash) VALUES (?1, ?2, ?3, ?4)", params![workspace_id, record_id, slot, hash])?;
        }
        let mut consumed = BTreeMap::new();
        for (owner_id, hash) in owner_hashes {
            if !normalized_refs
                .iter()
                .any(|(_, reference_hash)| reference_hash == &hash)
            {
                return Err(KernelError::Operation(format!(
                    "record owner is not referenced: {owner_id}"
                )));
            }
            consumed.insert(owner_id, hash);
        }
        self.consume_object_owners(&workspace_id, grant_id, &consumed)?;
        self.domain_record_value(&workspace_id, record_id)?
            .ok_or_else(|| KernelError::Storage("record disappeared after commit".to_string()))
    }

    pub(super) fn domain_record_get(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        match self.domain_record_value(workspace_id, record_id)? {
            Some(value)
                if value.get("workspaceId").and_then(Value::as_str) == Some(workspace_id)
                    && self.grant_can_access_domain_record(&value, grant_id)? =>
            {
                Ok(value)
            }
            Some(value)
                if value.get("workspaceId").and_then(Value::as_str) == Some(workspace_id) =>
            {
                Err(KernelError::Authorization(
                    "record belongs to another actor".to_string(),
                ))
            }
            Some(_) => Err(KernelError::Authorization(
                "record belongs to another workspace".to_string(),
            )),
            None => Ok(Value::Null),
        }
    }

    pub(super) fn domain_record_list(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("record workspaceId is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if grant.owning_workspace.as_deref() != Some(workspace_id)
            && !grant.capabilities.contains("storage.admin")
        {
            return Err(KernelError::Authorization(
                "record workspace does not match actor grant".to_string(),
            ));
        }
        let cursor = params_value
            .get("cursor")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize;
        let page_size = params_value
            .get("pageSize")
            .and_then(Value::as_u64)
            .unwrap_or(128) as usize;
        if page_size == 0 {
            return Err(KernelError::Operation(
                "pageSize must be positive when supplied".to_string(),
            ));
        }
        let record_type = params_value.get("recordType").and_then(Value::as_str);
        let mut sql = "SELECT record_id FROM domain_records WHERE workspace_id = ?1".to_string();
        if record_type.is_some() {
            sql.push_str(" AND record_type = ?2");
        }
        sql.push_str(" ORDER BY updated_at, record_id");
        let mut ids = Vec::new();
        if let Some(record_type) = record_type {
            for row in self
                .conn
                .prepare(&sql)?
                .query_map(params![workspace_id, record_type], |row| {
                    row.get::<_, String>(0)
                })?
            {
                ids.push(row?);
            }
        } else {
            for row in self
                .conn
                .prepare(&sql)?
                .query_map(params![workspace_id], |row| row.get::<_, String>(0))?
            {
                ids.push(row?);
            }
        }
        let session_filter = params_value.get("sessionId").and_then(Value::as_str);
        let thread_filter = params_value.get("threadId").and_then(Value::as_str);
        let run_filter = params_value.get("runId").and_then(Value::as_str);
        let branch_filter = params_value.get("branchId").and_then(Value::as_str);
        let mut filtered = Vec::new();
        for id in ids {
            let Some(value) = self.domain_record_value(workspace_id, &id)? else {
                continue;
            };
            if !self.grant_can_access_domain_record(&value, grant_id)? {
                continue;
            }
            if session_filter.is_some_and(|filter| {
                value.get("sessionId").and_then(Value::as_str) != Some(filter)
            }) || thread_filter
                .is_some_and(|filter| value.get("threadId").and_then(Value::as_str) != Some(filter))
                || run_filter.is_some_and(|filter| {
                    value.get("runId").and_then(Value::as_str) != Some(filter)
                })
                || branch_filter.is_some_and(|filter| {
                    value.get("branchId").and_then(Value::as_str) != Some(filter)
                })
            {
                continue;
            }
            filtered.push(value);
        }
        let start = cursor.min(filtered.len());
        let end = start.saturating_add(page_size).min(filtered.len());
        Ok(
            json!({"records": filtered[start..end].to_vec(), "nextCursor": if end < filtered.len() { Value::from(end as u64) } else { Value::Null }}),
        )
    }

    /// Enumerate the owning workspaces for a record type. Cross-workspace by
    /// design so a restarted Host can rediscover every durable wait/execution
    /// intent without relying on a Thread catalog or saved project list; the
    /// maintenance capability gate keeps actor-scoped grants out.
    pub(super) fn domain_record_workspaces(
        &self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let record_type = params_value
            .get("recordType")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordType is required".to_string()))?;
        let grant = self.load_grant(grant_id)?;
        if !grant.capabilities.contains("storage.maintenance")
            && !grant.capabilities.contains("storage.admin")
            && !grant.capabilities.contains("recovery.maintenance")
        {
            return Err(KernelError::Authorization(
                "record workspace enumeration requires a maintenance grant".to_string(),
            ));
        }
        let mut workspace_ids = Vec::new();
        for row in self
            .conn
            .prepare(
                "SELECT DISTINCT workspace_id FROM domain_records WHERE record_type = ?1 ORDER BY workspace_id",
            )?
            .query_map(params![record_type], |row| row.get::<_, String>(0))?
        {
            workspace_ids.push(row?);
        }
        Ok(json!({ "workspaceIds": workspace_ids }))
    }

    pub(super) fn domain_record_release(
        &mut self,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        self.domain_record_release_inner(params_value, grant_id, false)
    }

    fn domain_record_release_inner(
        &mut self,
        params_value: &Value,
        grant_id: &str,
        allow_working_record: bool,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.validate_domain_record_identity(params_value, grant_id)?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        if let Some(value) = self.domain_record_value(&workspace_id, record_id)? {
            if !self.grant_can_access_domain_record(&value, grant_id)? {
                return Err(KernelError::Authorization(
                    "record belongs to another actor".to_string(),
                ));
            }
            let record_type = value
                .get("recordType")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !allow_working_record
                && matches!(
                    record_type,
                    "working.draft"
                        | "working.result"
                        | "working.verification.child"
                        | "working.verification.parent"
                        | "working.review"
                )
            {
                return Err(KernelError::Operation(format!(
                    "{record_type} must use its typed working release method"
                )));
            }
        }
        let deleted = self.conn.execute(
            "DELETE FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
            params![record_id, workspace_id],
        )?;
        Ok(json!({"recordId": record_id, "released": deleted > 0}))
    }

    pub(super) fn working_record_release(
        &mut self,
        params_value: &Value,
        grant_id: &str,
        expected_type: &str,
    ) -> Result<Value, KernelError> {
        let workspace_id = self.validate_domain_record_identity(params_value, grant_id)?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KernelError::Operation("recordId is required".to_string()))?;
        let Some(value) = self.domain_record_value(&workspace_id, record_id)? else {
            return Ok(json!({"recordId": record_id, "released": false}));
        };
        let actual_type = value
            .get("recordType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let type_matches = actual_type == expected_type
            || (expected_type == "working.verification"
                && matches!(
                    actual_type,
                    "working.verification.child" | "working.verification.parent"
                ));
        if !type_matches {
            return Err(KernelError::Operation(
                "working record type mismatch".to_string(),
            ));
        }
        if !self.grant_can_access_domain_record(&value, grant_id)? {
            return Err(KernelError::Authorization(
                "record belongs to another actor".to_string(),
            ));
        }
        if expected_type == "working.result" {
            let branch_id = value
                .get("branchId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Storage("working result branch identity is missing".to_string())
                })?;
            let revision = value
                .get("resultRevision")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    KernelError::Storage("working result revision identity is missing".to_string())
                })?;
            let head_revision: i64 = self
                .conn
                .query_row(
                    "SELECT head_revision FROM branches WHERE branch_id = ?1 AND workspace_id = ?2",
                    params![branch_id, workspace_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    KernelError::Operation("working result branch is unavailable".to_string())
                })?;
            if head_revision == revision {
                return Err(KernelError::Operation(
                    "the branch head result cannot be released".to_string(),
                ));
            }
            let released_dependents = self.conn.execute(
                "DELETE FROM domain_records WHERE workspace_id = ?1 AND branch_id = ?2 AND result_revision = ?3 AND record_type IN ('working.verification.child', 'working.verification.parent', 'working.review')",
                params![workspace_id, branch_id, revision],
            )?;
            self.conn.execute(
                "DELETE FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
            )?;
            self.conn.execute(
                "DELETE FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                params![branch_id, revision],
            )?;
            return Ok(
                json!({"recordId": record_id, "released": true, "releasedDependents": released_dependents, "branchId": branch_id, "resultRevision": revision}),
            );
        }
        if expected_type == "working.draft" {
            let branch_id = value
                .get("branchId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Storage("working draft branch identity is missing".to_string())
                })?;
            if !branch_id.starts_with("working-draft:") {
                return Err(KernelError::Storage(
                    "working draft branch identity is invalid".to_string(),
                ));
            }
            self.conn.execute(
                "DELETE FROM domain_records WHERE record_id = ?1 AND workspace_id = ?2",
                params![record_id, workspace_id],
            )?;
            self.conn.execute(
                "DELETE FROM branches WHERE branch_id = ?1 AND workspace_id = ?2",
                params![branch_id, workspace_id],
            )?;
            self.conn.execute(
                "DELETE FROM revisions WHERE branch_id = ?1",
                params![branch_id],
            )?;
            return Ok(json!({"recordId": record_id, "released": true, "branchId": branch_id}));
        }
        self.domain_record_release_inner(params_value, grant_id, true)
    }

    fn published_revision_root(
        &self,
        workspace_id: &str,
        branch_id: &str,
        revision: i64,
    ) -> Result<String, KernelError> {
        self.conn
            .query_row(
                "SELECT r.root_hash FROM revisions r JOIN branches b ON b.branch_id = r.branch_id WHERE r.branch_id = ?1 AND r.revision = ?2 AND b.workspace_id = ?3",
                params![branch_id, revision, workspace_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| KernelError::Operation(format!(
                "published working revision is unavailable: {branch_id}@{revision}"
            )))
    }

    fn validate_result_binding(
        &self,
        workspace_id: &str,
        branch_id: &str,
        result_revision: i64,
        root: &str,
    ) -> Result<(), KernelError> {
        let revision_root =
            self.published_revision_root(workspace_id, branch_id, result_revision)?;
        if revision_root != root {
            return Err(KernelError::Operation(
                "working record root does not match its published revision".to_string(),
            ));
        }
        let result_record = format!("working-result:{branch_id}@{result_revision}");
        let retained: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM domain_records WHERE workspace_id = ?1 AND record_id = ?2 AND record_type = 'working.result' AND branch_id = ?3 AND result_revision = ?4 LIMIT 1",
                params![workspace_id, result_record, branch_id, result_revision],
                |row| row.get(0),
            )
            .optional()?;
        if retained.is_none() {
            return Err(KernelError::Operation(
                "working record must bind a retained result".to_string(),
            ));
        }
        Ok(())
    }

    /// Product-facing records deliberately use domain-shaped wire methods.  The catalog keeps a
    /// compact JSON envelope internally, but callers cannot select an arbitrary record type or
    /// submit an untyped payload through these methods.
    pub(super) fn working_record_put(
        &mut self,
        method: &str,
        record_type: &str,
        state: &str,
        document_field: &str,
        params_value: &Value,
        grant_id: &str,
    ) -> Result<Value, KernelError> {
        let document = params_value
            .get(document_field)
            .ok_or_else(|| KernelError::Operation(format!("{method} requires {document_field}")))?;
        let object = document
            .as_object()
            .ok_or_else(|| KernelError::Operation(format!("{document_field} must be an object")))?;
        if let Err(error) =
            crate::protocol_generated::validate_generated_working_document(record_type, document)
        {
            return Err(KernelError::Operation(format!(
                "{method} document is malformed: {error}"
            )));
        }
        let workspace_id = params_value
            .get("workspaceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("working record workspaceId is required".to_string())
            })?;
        let record_id = params_value
            .get("recordId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                KernelError::Operation("working record recordId is required".to_string())
            })?;
        let same = |field: &str| -> Result<(), KernelError> {
            if let Some(value) = object.get(field).and_then(Value::as_str) {
                if params_value.get(field).and_then(Value::as_str) != Some(value) {
                    return Err(KernelError::Operation(format!(
                        "{method} document {field} does not match its identity"
                    )));
                }
            }
            Ok(())
        };
        for field in ["workspaceId", "branchId", "root"] {
            if params_value.get(field).is_some() {
                same(field)?;
            }
        }
        if let Some(revision) = params_value.get("resultRevision").and_then(Value::as_i64) {
            if object
                .get("resultRevision")
                .and_then(Value::as_i64)
                .is_some_and(|value| value != revision)
            {
                return Err(KernelError::Operation(format!(
                    "{method} resultRevision does not match its identity"
                )));
            }
        }
        if matches!(record_type, "working.result" | "working.draft")
            && object.keys().any(|key| key == "payloadJson")
        {
            return Err(KernelError::Operation(format!(
                "{method} document cannot contain payloadJson"
            )));
        }
        if record_type == "working.result"
            && (object.contains_key("baseStates") || object.contains_key("pathStates"))
            && !object.contains_key("baseRoot")
        {
            return Err(KernelError::Operation(
                "working.result state maps require the publish-time baseRoot".to_string(),
            ));
        }
        if record_type == "working.result" {
            let branch_id = params_value
                .get("branchId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("working.result branchId is required".to_string())
                })?;
            let result_revision = params_value
                .get("resultRevision")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    KernelError::Operation("working.result resultRevision is required".to_string())
                })?;
            let expected_record_id = format!("working-result:{branch_id}@{result_revision}");
            if record_id != expected_record_id {
                return Err(KernelError::Operation(
                    "working.result recordId does not match branchId/resultRevision".to_string(),
                ));
            }
            let expected_root: Option<String> = self
                .conn
                .query_row(
                    "SELECT root_hash FROM revisions WHERE branch_id = ?1 AND revision = ?2",
                    params![branch_id, result_revision],
                    |row| row.get(0),
                )
                .optional()?;
            let expected_root = expected_root.ok_or_else(|| {
                KernelError::Operation("working.result revision is not published".to_string())
            })?;
            if params_value.get("root").and_then(Value::as_str) != Some(expected_root.as_str())
                || object.get("root").and_then(Value::as_str) != Some(expected_root.as_str())
            {
                return Err(KernelError::Operation(
                    "working.result root does not match published revision".to_string(),
                ));
            }
            let base_root: String = self
                .conn
                .query_row(
                    "SELECT base_root FROM branches WHERE branch_id = ?1 AND workspace_id = ?2",
                    params![branch_id, workspace_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| {
                    KernelError::Operation("working.result branch is not available".to_string())
                })?;
            let mut added = Vec::new();
            let mut removed = Vec::new();
            let mut changed = Vec::new();
            self.diff_nodes(
                &base_root,
                &expected_root,
                "",
                &mut added,
                &mut removed,
                &mut changed,
            )?;
            let mut expected_paths = added;
            expected_paths.extend(removed);
            expected_paths.extend(changed);
            expected_paths.sort();
            let mut supplied_paths = object
                .get("changedPaths")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    KernelError::Operation("working.result changedPaths is required".to_string())
                })?
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_string).ok_or_else(|| {
                        KernelError::Operation(
                            "working.result changedPaths contains a non-string".to_string(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            supplied_paths.sort();
            if supplied_paths != expected_paths {
                return Err(KernelError::Operation(
                    "working.result changedPaths do not match the published root diff".to_string(),
                ));
            }
            let files = object
                .get("diffStats")
                .and_then(Value::as_object)
                .and_then(|stats| stats.get("files"))
                .and_then(Value::as_i64);
            if files != Some(expected_paths.len() as i64) {
                return Err(KernelError::Operation(
                    "working.result diffStats.files does not match changedPaths".to_string(),
                ));
            }
            Self::require_no_working_owner_ids(params_value)?;
            let supplied_references = Self::working_reference_map(params_value)?;
            let mut expected_references = BTreeMap::new();
            for path in &expected_paths {
                if let Some(hash) = self
                    .root_get(&base_root, path)?
                    .as_ref()
                    .and_then(PathState::object_hash)
                {
                    expected_references.insert(format!("base:{path}"), hash.to_string());
                }
                if let Some(hash) = self
                    .root_get(&expected_root, path)?
                    .as_ref()
                    .and_then(PathState::object_hash)
                {
                    expected_references.insert(format!("result:{path}"), hash.to_string());
                }
            }
            if supplied_references != expected_references {
                return Err(KernelError::Operation(
                    "working.result references do not match the published base/result states"
                        .to_string(),
                ));
            }
            // Frozen provenance: the document's base/path state maps must
            // mirror the publish-time roots so a later baseline rebase cannot
            // silently rewrite this revision's provenance (3.18D). A put
            // replays alongside its publish, so `base_root` is still the base
            // the result was published on.
            let document_base_root = object
                .get("baseRoot")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    KernelError::Operation("working.result baseRoot is required".to_string())
                })?;
            if document_base_root != base_root {
                return Err(KernelError::Operation(
                    "working.result baseRoot does not match the publish-time baseline".to_string(),
                ));
            }
            let state_map = |key: &str| -> Result<&serde_json::Map<String, Value>, KernelError> {
                object
                    .get(key)
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        KernelError::Operation(format!("working.result {key} is required"))
                    })
            };
            let base_states = state_map("baseStates")?;
            let path_states = state_map("pathStates")?;
            if base_states.len() != expected_paths.len() || path_states.len() != expected_paths.len() {
                return Err(KernelError::Operation(
                    "working.result state maps must cover exactly the changed paths".to_string(),
                ));
            }
            let missing_state = json!({"kind": "missing"});
            for path in &expected_paths {
                let expected_base = self
                    .root_get(&base_root, path)?
                    .map(|state| serde_json::to_value(state))
                    .transpose()
                    .map_err(|error| {
                        KernelError::Operation(format!("working.result base state encode failed: {error}"))
                    })?
                    .unwrap_or_else(|| missing_state.clone());
                if base_states.get(path) != Some(&expected_base) {
                    return Err(KernelError::Operation(format!(
                        "working.result baseStates[{path}] does not match the publish-time baseline"
                    )));
                }
                let expected_result = self
                    .root_get(&expected_root, path)?
                    .map(|state| serde_json::to_value(state))
                    .transpose()
                    .map_err(|error| {
                        KernelError::Operation(format!("working.result result state encode failed: {error}"))
                    })?
                    .unwrap_or_else(|| missing_state.clone());
                if path_states.get(path) != Some(&expected_result) {
                    return Err(KernelError::Operation(format!(
                        "working.result pathStates[{path}] does not match the published result"
                    )));
                }
            }
        } else if record_type == "working.draft" {
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("working.draft id is required".to_string())
                })?;
            let branch_id = params_value
                .get("branchId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("working.draft branchId is required".to_string())
                })?;
            let revision = params_value
                .get("revision")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    KernelError::Operation("working.draft revision is required".to_string())
                })?;
            let root = params_value
                .get("root")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::Operation("working.draft root is required".to_string())
                })?;
            if record_id != id || branch_id != format!("working-draft:{id}") {
                return Err(KernelError::Operation(
                    "working.draft record and branch identities do not match its id".to_string(),
                ));
            }
            for (field, expected) in [
                ("workspaceId", workspace_id),
                ("branchId", branch_id),
                ("root", root),
            ] {
                if object.get(field).and_then(Value::as_str) != Some(expected) {
                    return Err(KernelError::Operation(format!(
                        "working.draft {field} does not match its identity"
                    )));
                }
            }
            if object.get("revision").and_then(Value::as_i64) != Some(revision) {
                return Err(KernelError::Operation(
                    "working.draft revision does not match its identity".to_string(),
                ));
            }
            if self.published_revision_root(workspace_id, branch_id, revision)? != root {
                return Err(KernelError::Operation(
                    "working.draft root does not match its published revision".to_string(),
                ));
            }
            Self::require_no_working_owner_ids(params_value)?;
            let provenance = object
                .get("provenance")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    KernelError::Operation("working.draft provenance is required".to_string())
                })?;
            let mut expected_references = BTreeMap::new();
            let mut paths = BTreeSet::new();
            for item in provenance {
                let path = item.get("path").and_then(Value::as_str).ok_or_else(|| {
                    KernelError::Operation("working.draft provenance path is malformed".to_string())
                })?;
                let canonical = Self::validate_path(path)?.join("/");
                if canonical != path || !paths.insert(canonical.clone()) {
                    return Err(KernelError::Operation(
                        "working.draft provenance paths must be canonical and unique".to_string(),
                    ));
                }
                let state = self.root_get(root, &canonical)?.ok_or_else(|| {
                    KernelError::Operation(format!(
                        "working.draft provenance path is absent from its root: {canonical}"
                    ))
                })?;
                let hash = state.object_hash().ok_or_else(|| {
                    KernelError::Operation(format!(
                        "working.draft provenance path is not a regular file: {canonical}"
                    ))
                })?;
                expected_references.insert(format!("draft:{canonical}"), hash.to_string());
            }
            for (path, state) in self.root_entries(root)? {
                if state.object_hash().is_some() && !paths.contains(&path) {
                    return Err(KernelError::Operation(format!(
                        "working.draft root contains a file without provenance: {path}"
                    )));
                }
            }
            if Self::working_reference_map(params_value)? != expected_references {
                return Err(KernelError::Operation(
                    "working.draft references do not match its fixed revision".to_string(),
                ));
            }
        } else if matches!(
            record_type,
            "working.verification.child" | "working.verification.parent" | "working.review"
        ) {
            let thread_id = params_value
                .get("threadId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| KernelError::Operation(format!("{method} threadId is required")))?;
            let branch_id = params_value
                .get("branchId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| KernelError::Operation(format!("{method} branchId is required")))?;
            let result_revision = params_value
                .get("resultRevision")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    KernelError::Operation(format!("{method} resultRevision is required"))
                })?;
            let root = params_value
                .get("root")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| KernelError::Operation(format!("{method} root is required")))?;
            self.validate_result_binding(workspace_id, branch_id, result_revision, root)?;
            Self::require_no_working_owner_ids(params_value)?;
            if !Self::working_reference_map(params_value)?.is_empty() {
                return Err(KernelError::Operation(
                    "verification and review records cannot attach unrelated content references"
                        .to_string(),
                ));
            }
            let expected_record_id = match record_type {
                "working.verification.child" => {
                    if object.get("resultRevision").and_then(Value::as_i64) != Some(result_revision)
                        || object.get("branchId").and_then(Value::as_str) != Some(branch_id)
                        || object.get("resultTreeHash").and_then(Value::as_str) != Some(root)
                    {
                        return Err(KernelError::Operation(
                            "child verification does not match its result identity".to_string(),
                        ));
                    }
                    format!("working-verification:child:{thread_id}:{result_revision}")
                }
                "working.verification.parent" => {
                    if object.get("mergedResultRevision").and_then(Value::as_i64)
                        != Some(result_revision)
                    {
                        return Err(KernelError::Operation(
                            "parent verification does not match its result identity".to_string(),
                        ));
                    }
                    format!("working-verification:parent:{thread_id}:{result_revision}")
                }
                _ => {
                    if object.get("resultRevision").and_then(Value::as_i64) != Some(result_revision)
                    {
                        return Err(KernelError::Operation(
                            "review does not match its result identity".to_string(),
                        ));
                    }
                    let status = object.get("status").and_then(Value::as_str).unwrap_or("");
                    if !matches!(status, "running" | "completed" | "failed" | "cancelled") {
                        return Err(KernelError::Operation(
                            "working review status is invalid".to_string(),
                        ));
                    }
                    format!("working-review:{thread_id}:{result_revision}")
                }
            };
            if record_id != expected_record_id {
                return Err(KernelError::Operation(format!(
                    "{method} recordId does not match its identity"
                )));
            }
        }
        let mut translated = params_value.clone();
        let translated_object = translated.as_object_mut().ok_or_else(|| {
            KernelError::Protocol("working record params must be an object".to_string())
        })?;
        translated_object.insert(
            "recordType".to_string(),
            Value::String(record_type.to_string()),
        );
        translated_object.insert("state".to_string(), Value::String(state.to_string()));
        translated_object.insert(
            "payloadJson".to_string(),
            Value::String(serde_json::to_string(document)?),
        );
        let value = self.domain_record_put_inner(&translated, grant_id, true)?;
        let payload = value
            .get("payloadJson")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Storage("working record payload disappeared".to_string())
            })?;
        let document = serde_json::from_str::<Value>(payload).map_err(|error| {
            KernelError::Storage(format!("working record payload is corrupt: {error}"))
        })?;
        Ok(
            json!({"record": document, "recordId": record_id, "workspaceId": workspace_id, "recordRevision": value.get("recordRevision"), "references": value.get("references")}),
        )
    }

    pub(super) fn working_record_get(
        &self,
        params_value: &Value,
        grant_id: &str,
        expected_type: &str,
    ) -> Result<Value, KernelError> {
        let value = self.domain_record_get(params_value, grant_id)?;
        if value.is_null() {
            return Ok(Value::Null);
        }
        if value.get("recordType").and_then(Value::as_str) != Some(expected_type) {
            return Err(KernelError::Operation(
                "working record type mismatch".to_string(),
            ));
        }
        let payload = value
            .get("payloadJson")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                KernelError::Storage("working record payload disappeared".to_string())
            })?;
        let document = serde_json::from_str::<Value>(payload).map_err(|error| {
            KernelError::Storage(format!("working record payload is corrupt: {error}"))
        })?;
        Ok(
            json!({"record": document, "recordId": value.get("recordId"), "workspaceId": value.get("workspaceId"), "recordRevision": value.get("recordRevision"), "references": value.get("references")}),
        )
    }

    pub(super) fn working_record_list(
        &self,
        params_value: &Value,
        grant_id: &str,
        expected_type: &str,
    ) -> Result<Value, KernelError> {
        let mut query = params_value.clone();
        query
            .as_object_mut()
            .expect("working list params object")
            .insert(
                "recordType".to_string(),
                Value::String(expected_type.to_string()),
            );
        let value = self.domain_record_list(&query, grant_id)?;
        let records = value
            .get("records")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Storage("working record list is malformed".to_string()))?
            .iter()
            .map(|record| {
                let payload = record.get("payloadJson").and_then(Value::as_str).ok_or_else(|| KernelError::Storage("working record payload disappeared".to_string()))?;
                let document = serde_json::from_str::<Value>(payload).map_err(|error| KernelError::Storage(format!("working record payload is corrupt: {error}")))?;
                Ok(json!({"record": document, "recordId": record.get("recordId"), "workspaceId": record.get("workspaceId"), "recordRevision": record.get("recordRevision"), "references": record.get("references")}))
            })
            .collect::<Result<Vec<_>, KernelError>>()?;
        Ok(json!({"records": records, "nextCursor": value.get("nextCursor")}))
    }
}
