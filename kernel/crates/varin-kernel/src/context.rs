//! Context policy and compaction wait on the requesting Run worker, outside shared owners.
use crate::host_query::OwnerChannel;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use varin_runtime::{
    context_capacity::{
        budget_candidates, estimate_request, native_candidate, native_mode, BudgetDecision,
        ContextPolicy, PreparationTiming,
    },
    context_job::{ContextBudgetStrategy, ContextCompactionMode, ContextSummaryRecipe},
    execution::*,
    Catalog, ModelSessionConfiguration,
};

pub(crate) struct CapacityPreparation {
    inner: Arc<dyn ContextPreparation>,
    catalog: Arc<Mutex<Catalog>>,
    bridge: OwnerChannel,
}
fn failed(error: impl ToString) -> ExecutionError {
    ExecutionError::new("context_capacity", error.to_string())
}
fn response(reply: &Value) -> Result<(), ExecutionError> {
    if reply["status"] == "ready" {
        return Ok(());
    }
    Err(ExecutionError::new(
        reply["code"]
            .as_str()
            .unwrap_or("context_policy_unavailable"),
        "Context budget preparation is unavailable",
    ))
}
fn policy(reply: &Value) -> Result<ContextPolicy, ExecutionError> {
    response(reply)?;
    let policy: ContextPolicy = serde_json::from_value(reply["policy"].clone()).map_err(failed)?;
    if !(policy.preparation_waterline > 0.0 && policy.preparation_waterline < 1.0) {
        return Err(failed("Invalid context preparation waterline"));
    }
    Ok(policy)
}
impl CapacityPreparation {
    pub fn new(
        inner: Arc<dyn ContextPreparation>,
        catalog: Arc<Mutex<Catalog>>,
        bridge: OwnerChannel,
    ) -> Self {
        Self {
            inner,
            catalog,
            bridge,
        }
    }
}
impl ContextPreparation for CapacityPreparation {
    fn prepare_binding(
        &self,
        run_id: &str,
        epoch: u64,
        binding: &mut RequestBinding,
        cancel: &CancellationToken,
    ) -> Result<varin_runtime::execution::ConversationHistory, ExecutionError> {
        self.inner.prepare_binding(run_id, epoch, binding, cancel)
    }
    fn prepare(
        &self,
        run_id: &str,
        epoch: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner.prepare(run_id, epoch, cancel)
    }
    fn prepare_request(
        &self,
        epoch: u64,
        view: &RequestView,
        serialized: &varin_runtime::execution::RequestBody,
        budget_protocol: Option<varin_runtime::context_capacity::RequestBudgetProtocol>,
        preview: &dyn Fn(
            ContextProjection,
        )
            -> Result<varin_runtime::context_capacity::InputEstimate, ExecutionError>,
        cancel: &CancellationToken,
    ) -> Result<ContextRequestPreparation, ExecutionError> {
        match self.inner.prepare_request(
            epoch,
            view,
            serialized,
            budget_protocol,
            preview,
            cancel,
        )? {
            ContextRequestPreparation::Ready => (),
            other => return Ok(other),
        }
        let (configuration, revision, existing, budget) = {
            let catalog = self.catalog.lock().map_err(failed)?;
            let run = catalog.run(&view.run_id).map_err(failed)?;
            if run.epoch != epoch || run.cancel_requested || run.state.terminal() {
                return Err(failed("Context request owner changed"));
            }
            let configuration: ModelSessionConfiguration =
                serde_json::from_value(run.configuration).map_err(failed)?;
            let revision = catalog
                .capture_active_checkpoint(&run.branch_id)
                .map_err(failed)?
                .map_or(0, |checkpoint| checkpoint.revision);
            let existing = if configuration.context_window_tokens.is_some() {
                catalog
                    .capture_context_job_for_request(&view.run_id, revision)
                    .map_err(failed)?
            } else {
                None
            };
            let budget = budget_protocol
                .map(|protocol| {
                    catalog
                        .capture_request_budget(&view.run_id, epoch)
                        .map(|read| (read, protocol))
                })
                .transpose()
                .map_err(failed)?;
            (configuration, revision, existing, budget)
        };
        // These are identities and local estimates, not a new measurement ledger. The Host
        // binds them to the Thread, full launch/configuration, credential and policy selection.
        let mut identity = serde_json::to_value(&view.binding).map_err(failed)?;
        if let Some(identity) = identity.as_object_mut() {
            for field in [
                "history_range",
                "environment_cursor",
                "memory_checkpoint",
                "resource_checkpoint_id",
                "attachment_refs",
                "resource_activations",
                "goal",
            ] {
                identity.remove(field);
            }
        }
        use sha2::{Digest, Sha256};
        let identity = hex::encode(Sha256::digest(
            serde_json::to_vec(&identity).map_err(failed)?,
        ));
        let prepared = self.bridge.query(json!({"action":"prepare","runId":view.run_id,"requestId":view.request_id,
            "expectedRevision":revision,
            "observation":{"estimatedTokens":estimate_request(view, serialized).estimated_tokens,"identity":identity}}), cancel)?;
        // Without a declared window this only publishes an observation; budget
        // preparation is not a dependency of the model request.
        let Some(capacity) = configuration.context_window_tokens else {
            return Ok(ContextRequestPreparation::Ready);
        };
        let mut settings = policy(&prepared)?;
        if !settings.enabled {
            return Ok(ContextRequestPreparation::Ready);
        }
        let estimate = match budget {
            Some((read, protocol)) => read
                .estimate(view, serialized, protocol, cancel)
                .map_err(failed)?,
            None => estimate_request(view, serialized),
        };
        let timing: PreparationTiming = prepared
            .get("timing")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(failed)?
            .unwrap_or_default();
        let existing = existing.map(|job| job.load().map_err(failed)).transpose()?;
        let external = prepared["external"].as_bool().unwrap_or(false)
            || existing.as_ref().is_some_and(|job| {
                matches!(
                    job.request.summary_recipe.strategy,
                    ContextBudgetStrategy::Extension { .. }
                )
            });
        let native = native_mode(&settings, capacity, &estimate, &timing);
        if !external && native.is_none() {
            return Ok(ContextRequestPreparation::Ready);
        }
        let legal = budget_candidates(view);
        if legal.is_empty() {
            return Ok(ContextRequestPreparation::Ready);
        }
        let (through, recipe, block) = if external {
            // A later decision may authorize only the accepted candidate. It cannot silently
            // replace its frozen source or instructions, nor schedule a second paid generation.
            let offered: Vec<_> = legal
                .iter()
                .filter(|candidate| {
                    existing
                        .as_ref()
                        .is_none_or(|job| candidate.through_id == job.request.through_id)
                })
                .cloned()
                .collect();
            let mut input = json!({"boundary":"before_model_dispatch","requestId":view.request_id,"estimate":estimate,
                "capacityTokens":capacity,"inputBudgetTokens":capacity.saturating_sub(settings.reserve_tokens),
                "settings":{"reserveTokens":settings.reserve_tokens,"keepRecentTokens":settings.keep_recent_tokens,
                    "backgroundPreparation":settings.background_preparation,"preparationWaterline":settings.preparation_waterline},
                "candidates":offered});
            if let Some(job) = &existing {
                let mut accepted = json!({"throughId":job.request.through_id,"mode":job.request.summary_recipe.mode});
                if let Some(instructions) = &job.request.summary_recipe.additional_instructions {
                    accepted["summaryInstructions"] = json!(instructions);
                }
                input["acceptedCandidate"] = accepted;
            }
            let reply = self.bridge.query(
                json!({"action":"decide","runId":view.run_id,"input":input}),
                cancel,
            )?;
            settings = policy(&reply)?;
            if !settings.enabled {
                return Ok(ContextRequestPreparation::Ready);
            }
            if reply["external"].as_bool() != Some(true) {
                if existing.is_some() {
                    return if estimate.estimated_tokens
                        <= capacity.saturating_sub(settings.reserve_tokens)
                    {
                        Ok(ContextRequestPreparation::Ready)
                    } else {
                        Err(failed("Accepted context strategy is no longer selected"))
                    };
                }
                return Ok(ContextRequestPreparation::Recompile);
            }
            let decision: BudgetDecision =
                serde_json::from_value(reply["decision"].clone()).map_err(failed)?;
            match decision {
                BudgetDecision::Continue => return Ok(ContextRequestPreparation::Ready),
                BudgetDecision::Compact {
                    through_id,
                    mode,
                    summary_instructions,
                } => {
                    if mode == ContextCompactionMode::Manual {
                        return Err(failed(
                            "Automatic decision cannot request manual compaction",
                        ));
                    }
                    if mode == ContextCompactionMode::Background && !settings.background_preparation
                    {
                        return Err(ExecutionError::new(
                            "context_background_disabled",
                            "Selected budget requested disabled background preparation",
                        ));
                    }
                    let selected: ContextSummaryRecipe =
                        serde_json::from_value(reply["summaryRecipe"].clone()).map_err(failed)?;
                    selected.validate(true).map_err(failed)?;
                    if !matches!(selected.strategy, ContextBudgetStrategy::Extension { .. })
                        || selected.mode != mode
                        || selected.additional_instructions != summary_instructions
                        || selected.configuration_identity.as_deref()
                            != Some(&settings.configuration_identity)
                    {
                        return Err(failed("Context decision and frozen recipe differ"));
                    }
                    let recipe = if let Some(job) = &existing {
                        let original = &job.request.summary_recipe;
                        if through_id != job.request.through_id
                            || selected.strategy != original.strategy
                            || summary_instructions != original.additional_instructions
                        {
                            return Err(failed(
                                "Context decision does not authorize the accepted candidate",
                            ));
                        }
                        original.clone()
                    } else {
                        selected
                    };
                    (through_id, recipe, mode == ContextCompactionMode::Blocking)
                }
            }
        } else {
            let Some(mode) = native else {
                return Ok(ContextRequestPreparation::Ready);
            };
            if let Some(job) = &existing {
                (
                    job.request.through_id.clone(),
                    job.request.summary_recipe.clone(),
                    mode == ContextCompactionMode::Blocking,
                )
            } else {
                let Some(candidate) = native_candidate(&legal) else {
                    return Ok(ContextRequestPreparation::Ready);
                };
                let mut recipe = ContextSummaryRecipe::automatic(settings.configuration_identity.clone(), mode);
                recipe.continuation_budget_tokens = Some(varin_runtime::context_capacity::continuation_budget(
                    view, &settings, capacity, configuration.max_output_tokens, &estimate, &timing));
                (
                    candidate.through_id.clone(),
                    recipe,
                    mode == ContextCompactionMode::Blocking,
                )
            }
        };
        if !legal
            .iter()
            .any(|candidate| candidate.through_id == through)
        {
            return Err(failed(
                "Context decision is not a legal ancestor of this request",
            ));
        }
        if cancel.is_cancelled() {
            return Err(failed("Context decision owner cancelled"));
        }
        let reply = self.bridge.query(
            json!({"action":"compact","runId":view.run_id,"requestId":view.request_id,
            "throughId":through,"expectedRevision":revision,"block":block,"summaryRecipe":recipe}),
            cancel,
        )?;
        if let Some(accepted) = reply.get("accepted") {
            let original_through = accepted["throughId"]
                .as_str()
                .ok_or_else(|| failed("Accepted context boundary missing"))?;
            let original: ContextSummaryRecipe =
                serde_json::from_value(accepted["summaryRecipe"].clone()).map_err(failed)?;
            original.validate(true).map_err(failed)?;
            if !legal
                .iter()
                .any(|candidate| candidate.through_id == original_through)
                || accepted["block"].as_bool() != Some(block)
                || matches!(recipe.strategy, ContextBudgetStrategy::Extension { .. })
                    && (original_through != through || original != recipe)
            {
                return Err(failed(
                    "Accepted context job differs from the selected decision",
                ));
            }
        } else if reply["status"] == "ready" {
            return Err(failed("Context job admission identity missing"));
        }
        if reply["status"] != "ready" {
            if !block {
                return Ok(ContextRequestPreparation::Ready);
            }
            return Err(ExecutionError::new(
                reply["code"]
                    .as_str()
                    .unwrap_or("context_compaction_failed"),
                "Context compaction could not publish a continuation",
            ));
        }
        if reply["published"].as_bool() == Some(true) {
            return Ok(ContextRequestPreparation::Recompile);
        }
        if !block {
            return Ok(ContextRequestPreparation::Ready);
        }
        let job_id = reply["jobRunId"]
            .as_str()
            .ok_or_else(|| failed("Context job admission is missing"))?;
        let publication = {
            let catalog = self.catalog.lock().map_err(failed)?;
            if catalog.run(job_id).map_err(failed)?.state == varin_runtime::RunState::Completed {
                let read = catalog
                    .prepare_context_read(
                        &view.run_id,
                        epoch,
                        view.binding.history_range.leaf_id.as_deref(),
                    )
                    .map_err(failed)?
                    .ok_or_else(|| failed("Context candidate has no source checkpoint"))?;
                Some((
                    catalog
                        .prepare_context_job_publication(job_id)
                        .map_err(failed)?,
                    read,
                ))
            } else {
                None
            }
        };
        if let Some((publication, read)) = publication {
            let publication = publication.load().map_err(failed)?;
            let estimate = preview(publication.preview(read).map_err(failed)?)?;
            if estimate.estimated_tokens > capacity.saturating_sub(settings.reserve_tokens) {
                return Err(ExecutionError::new("context_candidate_capacity", "The complete summary and retained original tail do not fit; the original history remains active"));
            }
            if cancel.is_cancelled() {
                return Err(failed("Context publication owner cancelled"));
            }
            let mut catalog = self.catalog.lock().map_err(failed)?;
            let run = catalog.run(&view.run_id).map_err(failed)?;
            if run.epoch != epoch
                || run.cancel_requested
                || run.state.terminal()
                || serde_json::from_value::<ModelSessionConfiguration>(run.configuration.clone())
                    .map_err(failed)?
                    != configuration
                || catalog.head(&run.branch_id).map_err(failed)?
                    != view.binding.history_range.leaf_id
            {
                return Err(failed("Context publication request boundary changed"));
            }
            catalog
                .publish_prepared_context_job(publication)
                .map_err(failed)?;
            return Ok(ContextRequestPreparation::Recompile);
        }
        let wait = self
            .catalog
            .lock()
            .map_err(failed)?
            .register_context_job_wait(&view.run_id, epoch, job_id, revision)
            .map_err(failed)?;
        Ok(match wait {
            Some(wait) => ContextRequestPreparation::Waiting { wait_id: wait.id },
            None => ContextRequestPreparation::Recompile,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};
    use varin_runtime::{catalog::context::ContextProposal, SubmitInput};

    #[test]
    fn external_background_decision_cannot_override_disabled_user_preparation() {
        let root =
            std::env::temp_dir().join(format!("varin-context-settings-{}", uuid::Uuid::new_v4()));
        let mut catalog = Catalog::open(&root).unwrap();
        catalog.create_thread("thread", "main").unwrap();
        let prepared = catalog.prepare_submission(SubmitInput {
            key: "source".into(), thread_id: "thread".into(), branch_id: "main".into(),
            expected_head: None, input: json!("Original source"),
            configuration: json!({"providerFamily":"openai-responses","model":"fixture",
                "endpoint":"https://controlled.invalid","allowAnonymous":true,
                "credentialEnvironment":null,"configurationGeneration":1,"contextWindowTokens":1000}),
        }, Some(ContextProposal {
            key:"original".into(),branch_id:"main".into(),through_id:None,expected_revision:0,
            summary:String::new(),effective_system_prompt:"Original instructions".into(),
            instruction_sources:vec![],memory_checkpoint:None,
        }), None).unwrap().load(None, false).unwrap();
        let receipt = catalog.admit_submission(prepared).unwrap();
        let checkpoint = catalog
            .capture_active_checkpoint("main")
            .unwrap()
            .unwrap()
            .id;
        let epoch = catalog.epoch();
        let range = HistoryRange {
            branch_id: "main".into(),
            ancestor_id: None,
            leaf_id: Some(receipt.input_id.clone()),
        };
        let view = RequestView {
            request_id: "request".into(),
            run_id: receipt.run_id,
            origin: RequestOrigin::Conversation {
                compaction: None, step: 0,
                history_range: range.clone(),
            },
            binding: RequestBinding {
                direct_tools: None,
                provider_id: None,
                tokenizer: None,
                request_context: None,
                child_dispatch: None,
                goal: None,
                resource_activations: vec![],
                resource_checkpoint_id: None,
                connection_identity: "fixture".into(),
                provider_family: "openai-responses".into(),
                model: "fixture".into(),
                credential_ref: None,
                configuration_generation: 1,
                tool_schema_generation: 0,
                tools: vec![],
                instruction_sources: vec![],
                memory_checkpoint: None,
                attachment_refs: vec![],
                environment_cursor: 0,
                history_range: range,
            },
            history: vec![ConversationItem {
                id: receipt.input_id.clone(),
                resource_activation: None,
                provenance: Provenance::UserInstruction {
                    input_id: receipt.input_id.clone(),
                },
                content: Content::Text {
                    text: "Original source".into(),
                },
                opaque: None,
            }.into()],
        };
        let catalog = Arc::new(Mutex::new(catalog));
        let (output, requests) = mpsc::sync_channel(8);
        let bridge = OwnerChannel::new("context", output.clone());
        bridge.initialize("fixture");
        let preparation = CapacityPreparation::new(
            Arc::new(NoopContextPreparation),
            catalog.clone(),
            bridge.clone(),
        );
        let worker = std::thread::spawn(move || {
            let result = preparation.prepare_request(
                epoch,
                &view,
                &json!({"input":"Original source"}).into(),
                None,
                &|_| panic!("No candidate may be previewed"),
                &CancellationToken::default(),
            );
            output.send(json!({"kind":"preparation-finished"})).unwrap();
            result
        });
        let policy = json!({"configurationIdentity":"user-settings","enabled":true,"reserveTokens":100,
            "keepRecentTokens":100,"backgroundPreparation":false,"preparationWaterline":0.7});
        let prepare = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(prepare["query"]["action"], "prepare");
        bridge.receive(
            json!({"v":1,"kind":"context-response","id":prepare["id"],"kernelEpoch":"fixture",
            "result":{"status":"ready","policy":policy,"external":true}}),
        );
        let decide = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(decide["query"]["action"], "decide");
        assert_eq!(
            decide["query"]["input"]["settings"]["backgroundPreparation"],
            false
        );
        let recipe = json!({"strategy":{"kind":"extension","providerKey":"fixture:host:varin.context.budget@1",
            "extensionId":"fixture","extensionVersion":"1.0.0","artifactIntegrity":"artifact",
            "serviceVersion":1,"configurationIdentity":"extension-config","name":"fixture","version":"1"},
            "mode":"background","configurationIdentity":"user-settings","additionalInstructions":null});
        bridge.receive(
            json!({"v":1,"kind":"context-response","id":decide["id"],"kernelEpoch":"fixture",
            "result":{"status":"ready","policy":policy,"external":true,"summaryRecipe":recipe,
                "decision":{"kind":"compact","throughId":receipt.input_id,"mode":"background"}}}),
        );
        let next = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        // Unblock a regression before asserting: the forbidden next frame would be compact.
        bridge.close();
        let result = worker.join().unwrap();
        assert_eq!(
            next["kind"], "preparation-finished",
            "Unexpected admission request: {next}"
        );
        assert_eq!(
            result.err().expect("Decision must be rejected").code,
            "context_background_disabled"
        );
        let owner = catalog.lock().unwrap();
        assert!(owner.capture_context_jobs("main").unwrap().is_empty());
        assert_eq!(
            owner.capture_active_checkpoint("main").unwrap().unwrap().id,
            checkpoint
        );
        drop(owner);
        drop(catalog);
        std::fs::remove_dir_all(root).unwrap();
    }
}
