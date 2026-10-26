//! Original Host Tool receipt recovery from the existing Integration journal, on a request worker.
use crate::{
    error::KernelError,
    tools::{KernelResourceClient, ToolBinding},
};
use serde_json::{Value, json};
use varin_runtime::execution::{ToolExecutionContext, ToolInvocation};
use varin_runtime::{Effect, ExecutorOwner, ExternalReceipt, Outcome, supervisor::RunSupervisor};
fn error(value: impl std::fmt::Display) -> KernelError {
    KernelError::Operation(value.to_string())
}

pub(crate) fn reconcile(
    runtime: &RunSupervisor,
    resources: &KernelResourceClient,
    binding: Option<&ToolBinding>,
    operation_id: &str,
    expected_owner: Option<&ExecutorOwner>,
) -> Result<bool, KernelError> {
    let owner = runtime.catalog();
    let (read, run, source) = {
        let catalog = owner.lock().map_err(error)?;
        let operation = catalog.operation(operation_id).map_err(error)?;
        let run = catalog.run(&operation.run_id).map_err(error)?;
        let source = catalog
            .launch_metadata(&run.id)
            .map_err(error)?
            .and_then(|launch| launch.selection.source)
            .ok_or_else(|| error("original Integration source is unavailable"))?;
        if !matches!(operation.executor.as_deref(),Some("integrate_child"|"submit_code"|"update"))
            || operation
                .execution_owner
                .as_ref()
                .is_none_or(|value| !matches!(value, ExecutorOwner::External { .. }))
            || expected_owner
                .is_some_and(|expected| operation.execution_owner.as_ref() != Some(expected))
        {
            return Err(KernelError::Authorization(
                "Integration reconciliation changed its original Tool owner or source".into(),
            ));
        }
        if let Some(binding) = binding {
            if run.id != binding.run_id
                || run.thread_id != binding.thread_id
                || source != binding.source_selection()?
            {
                return Err(KernelError::Authorization(
                    "Integration current binding differs from original source".into(),
                ));
            }
        }
        (catalog.capture_operation_read(operation), run, source)
    };
    let (operation, original_receipt) = read.load_with_external_receipt().map_err(error)?;
    let invocation: ToolInvocation = serde_json::from_value(operation.intent.clone())?;
    let exchange=matches!(invocation.call.name.as_str(),"submit_code"|"update");
    // Host tool versions are fingerprints of the frozen declaration, not the
    // service's numeric version. Compare the original admitted contract.
    if (!exchange && invocation.call.name != "integrate_child")
        || invocation.contract.name != invocation.call.name
        || invocation.contract.schema_version != invocation.call.schema_version
        || invocation.origin.operation_id(&invocation.call.call_id) != operation.id
    {
        return Err(KernelError::Authorization(
            "Integration Tool origin differs from its admitted intent".into(),
        ));
    }
    let id = format!("integration:{}", operation.id);
    let journal = resources.integration_receipt(source.clone(),run.id.clone(),run.thread_id.clone(),operation.id.clone())?;
    if journal.is_null() {return Ok(false)}
    let mut data=journal["data"].as_object().ok_or_else(||error("Integration journal data is malformed"))?.clone();
    if let Some(result)=journal["result"].as_object(){data.extend(result.clone());}
    let data=Value::Object(data);
    let mut expected=if exchange {
        let saved=&data["operationBinding"];
        let db=owner.lock().map_err(error)?;
        if saved["kind"]=="external_code_exchange" {
            let child=db.external_message_target(&run.id,saved["externalOperationId"].as_str().ok_or_else(||error("external exchange source missing"))?).map_err(error)?
                .ok_or_else(||error("external exchange belongs to an unavailable Agent"))?;
            let original=child.handoff.as_ref().ok_or_else(||error("external exchange has no retained source"))?;
            let physical=child.source.as_ref().ok_or_else(||error("external file source is unprepared"))?;
            let receiving=invocation.call.name=="update";
            let peer=invocation.call.arguments[if receiving{"source"}else{"target"}].as_str();
            let target:varin_runtime::catalog::launches::SourceSelection=serde_json::from_value(saved["target"].clone())?;
            let valid_target=if receiving{target==source}else{
                let mut original_target:varin_runtime::catalog::launches::SourceSelection=serde_json::from_value(physical["baseline"]["source"].clone())?;
                original_target.mode=varin_runtime::SourceMode::Materialized;
                original_target.environment_run_id=Some(child.conversation_id.clone());
                target==original_target && target.mode==varin_runtime::SourceMode::Materialized
            };
            if saved["operationId"]!=operation.id || saved["parentRunId"]!=run.id || saved["parentThreadId"]!=run.thread_id || saved["parentBranchId"]!=run.branch_id
                || saved["callId"]!=invocation.call.call_id || saved["origin"]!=serde_json::to_value(&invocation.origin)?
                || saved["direction"]!=if receiving{"receive"}else{"send"} || !valid_target
                || saved["childThreadId"]!=if receiving{child.conversation_id.as_str()}else{run.thread_id.as_str()}
                || saved["targetThreadId"]!=if receiving{run.thread_id.as_str()}else{child.conversation_id.as_str()}
                || saved["result"]["workspaceId"]!=source.workspace_id
                || !peer.is_some_and(|id|id==child.conversation_id||id==child.operation_id)
                || original.source.workspace_id!=source.workspace_id || original.source.resource_owner!=source.resource_owner {
                return Err(KernelError::Authorization("external exchange journal differs from its original invocation or source".into()));
            }
            saved.clone()
        } else {
        let source_run=db.run(saved["sourceRunId"].as_str().ok_or_else(||error("exchange source Run missing"))?).map_err(error)?;
        let target_run=db.run(saved["targetRunId"].as_str().ok_or_else(||error("exchange target Run missing"))?).map_err(error)?;
        for related in [&source_run,&target_run] {
            db.capture_family_read(&run.thread_id,Some(&related.thread_id),Some(&related.branch_id)).map_err(error)?;
        }
        let target_launch=db.launch_metadata(&target_run.id).map_err(error)?.and_then(|l|l.selection.source).ok_or_else(||error("exchange target source missing"))?;
        let supplied=if invocation.call.name=="submit_code" {invocation.call.arguments["target"].as_str()}else{invocation.call.arguments["source"].as_str()};
        let other=if invocation.call.name=="submit_code" {&target_run}else{&source_run};
        let peer=if let Some(supplied)=supplied {db.agent_identity(supplied).map_err(error)?["threadId"].as_str().map(str::to_owned)}else{db.child_task_for_thread(&run.thread_id).map_err(error)?.map(|c|c.parent_thread_id)};
        if saved["kind"]!="code_exchange" || saved["operationId"]!=operation.id || saved["parentRunId"]!=run.id || saved["parentThreadId"]!=run.thread_id || saved["parentBranchId"]!=run.branch_id
            || saved["callId"]!=invocation.call.call_id || saved["origin"]!=serde_json::to_value(&invocation.origin)?
            || saved["target"]!=serde_json::to_value(target_launch)? || saved["childThreadId"]!=source_run.thread_id || saved["targetThreadId"]!=target_run.thread_id
            || saved["result"]["workspaceId"]!=source.workspace_id || peer.as_deref()!=Some(&other.thread_id)
            || (invocation.call.name=="submit_code" && source_run.id!=run.id) || (invocation.call.name=="update" && target_run.id!=run.id) {
            return Err(KernelError::Authorization("exchange journal differs from its original invocation or family".into()));
        }
        saved.clone()
        }
    } else {
    let child_id = invocation.call.arguments["childOperationId"]
        .as_str()
        .ok_or_else(|| error("Integration child identity missing"))?;
    let execution_id = invocation.call.arguments["executionId"]
        .as_str()
        .ok_or_else(|| error("Integration execution identity missing"))?;
    let publication = invocation.call.arguments["publicationId"]
        .as_str()
        .ok_or_else(|| error("Integration publication missing"))?;
    let child = owner
        .lock()
        .map_err(error)?
        .execution_task(execution_id)
        .map_err(error)?;
    let varin_runtime::catalog::collaboration::ChildCodeResult::Published { result, .. } =
        child.code_result
    else {
        return Err(error("Integration child result is not fixed"));
    };
    if child.operation_id != child_id
        || child.parent_thread_id != run.thread_id
        || child.parent_branch_id != run.branch_id
        || result.publication_id != publication
        || result.workspace_id != source.workspace_id
    {
        return Err(KernelError::Authorization(
            "Integration result belongs to another parent branch".into(),
        ));
    }
    json!({"kind":"runtime_operation","operationId":operation.id,"parentRunId":run.id,"parentThreadId":run.thread_id,"parentBranchId":run.branch_id,
        "origin":invocation.origin,"callId":invocation.call.call_id,"childOperationId":child_id,"childExecutionId":execution_id,"childThreadId":child.child_thread_id,
        "result":{"workspaceId":result.workspace_id,"branchId":result.branch_id,"resultRevision":result.result_revision,"root":result.root,"publicationId":publication},"target":source})
    };
    if !exchange {
        if let Some(saved)=data["operationBinding"].get("journal") {
            let read=owner.lock().map_err(error)?.capture_journal_anchor(&ToolExecutionContext {
                run_id:run.id.clone(),origin:invocation.origin.clone(),operation_id:operation.id.clone(),
            }).map_err(error)?;
            let mut original=serde_json::to_value(read.load().map_err(error)?)?;
            let mut supplied=saved.clone();
            original.as_object_mut().unwrap().remove("epoch");
            supplied.as_object_mut().ok_or_else(||error("Integration recovery anchor is malformed"))?.remove("epoch");
            if original!=supplied {return Err(KernelError::Authorization("Integration recovery anchor differs from its original input".into()));}
            expected["journal"]=saved.clone();
        }
    }
    if data["operationBinding"] != expected
        || journal["threadId"] != run.thread_id
        || journal["runId"] != run.id
    {
        return Err(KernelError::Authorization(
            "Integration journal does not identify this original Tool invocation".into(),
        ));
    }
    // Business uncertainty and executor stop are independent. No stop evidence means no recovery
    // completion, and this path never compensates or retries the journal's effects.
    if data["executorStopped"] != true {
        return Ok(false);
    }
    let state = journal["state"]
        .as_str()
        .ok_or_else(|| error("Integration journal state missing"))?;
    let files = journal["files"]
        .as_array()
        .ok_or_else(|| error("Integration file phases missing"))?;
    let terminal = matches!(
        state,
        "complete" | "conflict" | "compensated" | "aborted" | "undone"
    );
    let strings = |field: &str| -> Result<Vec<String>, KernelError> {
        data[field]
            .as_array()
            .ok_or_else(|| error(format!("Integration {field} missing")))?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or_else(|| error("invalid Integration path"))
            })
            .collect()
    };
    let applied = strings("appliedPaths")?;
    let compensated = strings("compensatedPaths")?;
    let conflicts = strings("conflictPaths")?;
    let attention = strings("needsAttentionPaths")?;
    if applied
        .iter()
        .chain(&compensated)
        .any(|path| !files.iter().any(|file| file["path"].as_str() == Some(path)))
    {
        return Err(error("Integration outcome has no original file phase"));
    }
    for file in files {
        let path = file["path"]
            .as_str()
            .ok_or_else(|| error("Integration file path missing"))?;
        let phase = file["phase"]
            .as_str()
            .ok_or_else(|| error("Integration file phase missing"))?;
        if terminal
            && applied.iter().any(|value| value == path)
            && !compensated.iter().any(|value| value == path)
            && !matches!(
                phase,
                "target-observed"
                    | "external-target-observed"
                    | "surface-applied"
                    | "disk-applied"
                    | "branch-applied"
            )
        {
            return Ok(false);
        }
        if terminal
            && compensated.iter().any(|value| value == path)
            && !matches!(
                phase,
                "safety-observed"
                    | "external-safety-observed"
                    | "compensated"
                    | "surface-compensated"
            )
        {
            return Ok(false);
        }
        // An external intent is only an unissued plan. With the original stop receipt above,
        // it is safe only when it claims neither an applied nor a compensated file effect.
        if terminal
            && phase == "external-intent"
            && (applied.iter().any(|value| value == path)
                || compensated.iter().any(|value| value == path))
        {
            return Ok(false);
        }
        if terminal
            && matches!(
                phase,
                "apply-intent" | "external-dispatched" | "compensate-intent" | "undo-intent"
            )
        {
            return Ok(false);
        }
    }
    let remaining = applied
        .iter()
        .filter(|path| !compensated.contains(path))
        .count();
    let effect = if !terminal {
        Effect::Unknown
    } else if remaining == 0 {
        if compensated.is_empty() {
            Effect::None
        } else {
            Effect::Confirmed
        }
    } else if state == "complete" {
        Effect::Confirmed
    } else {
        Effect::Partial
    };
    let status = match state {
        "complete" => "applied",
        "conflict" => "conflict",
        "compensated" | "undone" => "compensated",
        _ => "needs-attention",
    };
    let outcome = if effect == Effect::Unknown || status == "needs-attention" {
        Outcome::Indeterminate
    } else if status == "applied" {
        Outcome::Succeeded
    } else {
        Outcome::Failed
    };
    let changed = data["retryBinding"]["childStates"]
        .as_object()
        .ok_or_else(|| error("native Integration child states missing"))?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let stats = data["diffStats"]
        .as_object()
        .ok_or_else(|| error("native Integration diff stats missing"))?;
    if ["files", "insertions", "deletions"]
        .iter()
        .any(|key| stats.get(*key).and_then(Value::as_u64).is_none())
    {
        return Err(error("native Integration diff stats malformed"));
    }
    let mut projection = json!({"operationId":id,"status":status,"appliedPaths":applied,"conflictPaths":conflicts,"compensatedPaths":compensated,
        "needsAttentionPaths":attention,"diffStats":data["diffStats"],"changedFiles":changed,"text":format!("Recorded integration {id}: {state}"),
        "receipt":{"kind":"integration","workspaceId":source.workspace_id,"operationId":id,"revision":journal["revision"],"state":state},
        "effect":effect,"executorStopped":true,"recoveryCoverage":"files-only"});
    if data["operationBinding"].get("journal").is_some() { projection["fileJournal"]=json!(true); }
    let preserved = if let Some(previous) = &original_receipt {
        if previous.effect != Effect::Unknown {
            if previous.effect != effect || previous.outcome != outcome {
                return Err(error("confirmed Integration receipt changed"));
            }
            Some(previous.clone())
        } else if effect == Effect::Unknown {
            Some(previous.clone())
        } else {
            None
        }
    } else {
        None
    };
    let execution_owner = operation.execution_owner.as_ref().unwrap();
    if exchange && terminal && expected["kind"]!="external_code_exchange" {
        use varin_runtime::catalog::messages::MessageInput;
        let preparation = {
            let catalog = owner.lock().map_err(error)?;
            let source_thread=expected["childThreadId"].as_str().ok_or_else(||error("exchange sender missing"))?;
            let target_thread=expected["targetThreadId"].as_str().ok_or_else(||error("exchange receiver missing"))?;
            projection["source"]=catalog.agent_identity(source_thread).map_err(error)?;
            projection["target"]=catalog.agent_identity(target_thread).map_err(error)?;
            projection["result"]=expected["result"].clone();
            if catalog.has_code_notice(&operation.id).map_err(error)? {None} else {
                let peer_run=catalog.run(if source_thread==run.thread_id {expected["targetRunId"].as_str()}else{expected["sourceRunId"].as_str()}.ok_or_else(||error("exchange peer Run missing"))?).map_err(error)?;
                Some(catalog.prepare_code_notice(format!("code-exchange:{}",operation.id),run.thread_id.clone(),run.branch_id.clone(),&operation.id,execution_owner,
                    MessageInput { source_agent:None,name:None,wait:None,target_thread_id:Some(peer_run.thread_id),target_branch_id:Some(peer_run.branch_id),reply_to:None,
                        kind:varin_runtime::MessageKind::Inform,text:serde_json::to_string(&projection)? }).map_err(error)?)
            }
        };
        if let Some(preparation)=preparation {
            let prepared=preparation.load().map_err(error)?;
            owner.lock().map_err(error)?.admit_message(prepared).map_err(error)?;
        }
    }
    let ExecutorOwner::External { epoch, .. } = execution_owner else {
        unreachable!()
    };
    let preparation = owner.lock().map_err(error)?.prepare_result_content();
    let prepared = preparation
        .write_external_receipt(preserved.unwrap_or_else(|| ExternalReceipt {
            executor: invocation.call.name.clone(),
            identity: operation.id.clone(),
            epoch: epoch.clone(),
            outcome,
            effect,
            result: projection.into(),
        }))
        .map_err(error)?;
    owner
        .lock()
        .map_err(error)?
        .record_external_tool_receipt_prepared(&operation.id, execution_owner, prepared, true)
        .map_err(error)?;
    Ok(effect != Effect::Unknown)
}

#[cfg(test)]
#[path = "integration_reconciliation_review.rs"]
mod review;
