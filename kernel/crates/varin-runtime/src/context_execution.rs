//! One supervised ContextJob worker schedules independent frozen model nodes.
//! Each request retains the ordinary ModelStep dispatch, output and usage records.
use crate::catalog::context_jobs::{ContextJobCompiler, ContextNodeOutput};
use crate::catalog::goals::GoalBoundary;
use crate::context_job::ContextCompactionInput;
use crate::execution::*;
use crate::supervisor::RunStart;
use crate::{Catalog, RunState};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{mpsc, Arc, Mutex};

type Result<T> = std::result::Result<T, ExecutionError>;
type Engine = ExecutionEngine<Mutex<Catalog>, dyn ModelProvider, dyn ToolExecutor, dyn AgentPolicy>;
fn error(value: impl ToString) -> ExecutionError {
    ExecutionError::new("context_execution", value.to_string())
}

pub(crate) fn run(
    owner: Arc<Mutex<Catalog>>,
    id: &str,
    start: RunStart,
    cancel: CancellationToken,
) -> Result<ExecutionReport> {
    let preparation = owner
        .lock()
        .map_err(error)?
        .capture_context_execution(id, start.binding)
        .map_err(error)?;
    let (input, compiler) = preparation.load().map_err(error)?;
    let engine = Engine {
        persistence: owner.clone(),
        context_preparation: start.context_preparation,
        provider: start.provider,
        tools: start.tools,
        policy: start.policy,
        progress: start.progress,
    };
    let plan_cancel = cancel.child("context-plan");
    let (send, receive) = mpsc::channel();
    let mut active = BTreeSet::new();
    let mut failure: Option<ExecutionError> = None;
    let mut generating = false;
    let progress = owner
        .lock()
        .map_err(error)?
        .context_job_outputs(id)
        .map_err(error)?;
    let mut completed = compiler.completed(&progress).map_err(error)?;
    let nodes: BTreeMap<_, _> = compiler
        .plan()
        .nodes()
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut remaining = BTreeMap::new();
    let mut successors: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut ready = VecDeque::new();
    for node in compiler.plan().nodes() {
        if completed.contains_key(&node.id) {
            continue;
        }
        let dependencies: BTreeSet<_> = node
            .inputs
            .iter()
            .filter_map(|source| match source {
                ContextCompactionInput::NodeOutput { node_id }
                    if !completed.contains_key(node_id) =>
                {
                    Some(node_id.as_str())
                }
                _ => None,
            })
            .collect();
        remaining.insert(node.id.as_str(), dependencies.len());
        if dependencies.is_empty() {
            ready.push_back(node.id.clone());
        }
        for dependency in dependencies {
            successors
                .entry(dependency)
                .or_default()
                .push(node.id.as_str());
        }
    }
    let (state, waiting_on) = std::thread::scope(|scope| -> Result<(RunState, Option<String>)> {
        let result = (|| {
            let mut workers = BTreeMap::new();
            loop {
                let stopped = cancel.is_cancelled();
                let gate = engine
                    .persistence
                    .goal_boundary(id, input.owner_generation)?;
                let may_start =
                    !stopped && failure.is_none() && matches!(gate, GoalBoundary::Continue);
                if may_start {
                    while let Some(node_id) = ready.pop_front() {
                        let node = nodes[node_id.as_str()];
                        if !generating {
                            engine.persistence.commit(
                                id,
                                input.owner_generation,
                                &ExecutionRecord::StateChanged {
                                    state: RunState::Generating,
                                    waiting_on: None,
                                },
                            )?;
                            generating = true;
                        }
                        active.insert(node.id.clone());
                        let send = send.clone();
                        let engine = &engine;
                        let compiler = &compiler;
                        let input = &input;
                        let progress: Vec<_> = node
                            .inputs
                            .iter()
                            .filter_map(|source| match source {
                                ContextCompactionInput::NodeOutput { node_id } => {
                                    Some((node_id, completed[node_id].clone()))
                                }
                                _ => None,
                            })
                            .collect::<BTreeMap<_, _>>()
                            .into_values()
                            .collect();
                        let node_cancel = plan_cancel.child(&node_id);
                        let key = node_id.clone();
                        let worker = scope.spawn(move || {
                            let result =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    execute_node(
                                        engine,
                                        input,
                                        compiler,
                                        &node_id,
                                        &progress,
                                        &node_cancel,
                                    )
                                }))
                                .unwrap_or_else(|_| {
                                    Err(ExecutionError::new(
                                        "context_worker_panicked",
                                        "summary node worker stopped unexpectedly",
                                    ))
                                });
                            let _ = send.send((node_id, result));
                        });
                        workers.insert(key, worker);
                    }
                }
                if active.is_empty() {
                    if stopped {
                        return Ok((RunState::Cancelled, None));
                    }
                    if failure.is_some() {
                        return Ok((RunState::Failed, None));
                    }
                    return match gate {
                        GoalBoundary::Wait { wait_id } => Ok((RunState::Waiting, Some(wait_id))),
                        GoalBoundary::Finish { state } => Ok((state, None)),
                        GoalBoundary::Continue
                            if completed.len() == compiler.plan().nodes().len() =>
                        {
                            Ok((RunState::Completed, None))
                        }
                        GoalBoundary::Continue => Err(error("summary plan has no runnable node")),
                    };
                }
                let (node, result) = receive.recv().map_err(error)?;
                workers
                    .remove(&node)
                    .expect("original summary worker")
                    .join()
                    .map_err(|_| error("summary worker failed during cleanup"))?;
                active.remove(&node);
                match result {
                    Ok(output) => {
                        completed.insert(node.clone(), output);
                        for successor in successors.get(node.as_str()).into_iter().flatten() {
                            let count = remaining.get_mut(successor).expect("original dependency");
                            *count -= 1;
                            if *count == 0 {
                                ready.push_back((*successor).into());
                            }
                        }
                    }
                    Err(problem) if problem.code == "goal_changed" => ready.push_back(node),
                    Err(problem) if failure.is_none() => {
                        failure = Some(problem);
                        plan_cancel.cancel();
                    }
                    Err(_) => {}
                }
            }
        })();
        if result.is_err() {
            plan_cancel.cancel();
        }
        result
    })?;
    let (state, waiting_on) = if cancel.is_cancelled()
        && matches!(
            engine.persistence.stop_reason(id, input.owner_generation)?,
            crate::catalog::bot::RunStopReason::BotSuspension(_)
        ) {
        let parked = engine
            .persistence
            .park_suspension(id, input.owner_generation)?;
        failure = None;
        (parked.state, parked.waiting_on)
    } else {
        engine.persistence.commit(
            id,
            input.owner_generation,
            &ExecutionRecord::StateChanged {
                state,
                waiting_on: waiting_on.clone(),
            },
        )?;
        (state, waiting_on)
    };
    let (model_steps, history) = {
        let catalog = owner.lock().map_err(error)?;
        (
            catalog.context_job_outputs(id).map_err(error)?.len() as u64,
            catalog.context_job_history(id).map_err(error)?,
        )
    };
    Ok(ExecutionReport {
        state,
        waiting_on,
        history: compiler.history(history).map_err(error)?,
        policy_state: Value::Null,
        model_steps,
        failure,
    })
}

fn execute_node(
    engine: &Engine,
    input: &ExecutionInput,
    compiler: &ContextJobCompiler,
    node: &str,
    outputs: &[ContextNodeOutput],
    cancel: &CancellationToken,
) -> Result<ContextNodeOutput> {
    if cancel.is_cancelled() {
        return Err(error("summary cancelled before preparation"));
    }
    let context = compiler.compile_node(node, outputs).map_err(error)?;
    let mut binding = input.binding.clone();
    binding.goal = engine
        .persistence
        .goal_context(&input.run_id, input.owner_generation)?
        .map(|goal| goal.binding);
    binding.instruction_sources = context.instruction_sources;
    binding.memory_checkpoint = context.memory_checkpoint;
    binding.resource_checkpoint_id = context.resource_checkpoint_id;
    let id = format!("{}:node:{}:{}", input.run_id, node, uuid::Uuid::new_v4());
    let view = RequestView {
        request_id: id.clone(),
        run_id: input.run_id.clone(),
        origin: RequestOrigin::Conversation {
            compaction: context.compaction,
            step: compiler
                .plan()
                .nodes()
                .iter()
                .position(|item| item.id == node)
                .expect("original node") as u64
                + 1,
            history_range: binding.history_range.clone(),
        },
        binding,
        history: context.history,
    };
    let serialized = engine.provider.serialize_cancellable(&view, None, cancel)?;
    let preview =
        |_: ContextProjection| Err(error("summary requests cannot launch recursive compaction"));
    if !matches!(
        engine.context_preparation.prepare_request(
            input.owner_generation,
            &view,
            &serialized,
            engine.provider.request_budget_protocol(),
            &preview,
            cancel
        )?,
        ContextRequestPreparation::Ready
    ) {
        return Err(error("summary request is not ready"));
    }
    let _ = serialized.wire_bytes();
    let snapshot = Arc::new(RequestSnapshot { view, serialized });
    engine.persistence.commit(
        &input.run_id,
        input.owner_generation,
        &ExecutionRecord::RequestPrepared {
            snapshot: snapshot.clone(),
        },
    )?;
    let dispatch = if cancel.is_cancelled() {
        Err(error("summary cancelled before dispatch"))
    } else {
        engine.persistence.commit(
            &input.run_id,
            input.owner_generation,
            &ExecutionRecord::ModelDispatched {
                request_id: id.clone(),
            },
        )
    };
    if let Err(failure) = dispatch {
        engine.persistence.commit(
            &input.run_id,
            input.owner_generation,
            &ExecutionRecord::RequestNotDispatched {
                request_id: id,
                reason: engine
                    .persistence
                    .non_dispatch_stop_reason(&input.run_id, input.owner_generation)?,
            },
        )?;
        return Err(failure);
    }
    let (items, deltas, usage, mut result) =
        engine.generate(&input.run_id, &snapshot, cancel, None);
    if result.is_ok() {
        if let Err(error) = validate_model_items(&items, &snapshot) {
            result = Err(ModelFailure {
                code: error.code,
                message: error.message,
                retry_after_ms: None,
                provider_request_id: None,
            });
        }
    }
    let suspended = cancel.is_cancelled()
        && matches!(
            engine
                .persistence
                .stop_reason(&input.run_id, input.owner_generation)?,
            crate::catalog::bot::RunStopReason::BotSuspension(_)
        );
    let interrupted = cancel.is_cancelled() && !(suspended && result.is_ok());
    let outcome = if cancel.is_cancelled() && !suspended {
        ModelOutcome::Cancelled
    } else if interrupted {
        ModelOutcome::Interrupted
    } else if result.is_ok() {
        ModelOutcome::Completed
    } else if items.is_empty() && deltas.is_empty() {
        ModelOutcome::Failed
    } else {
        ModelOutcome::Interrupted
    };
    engine.persistence.commit(
        &input.run_id,
        input.owner_generation,
        &ExecutionRecord::ModelFinished {
            request_id: id.clone(),
            outcome,
            finish_reason: result.as_ref().ok().copied(),
            items,
            interrupted_deltas: if result.is_err() || interrupted {
                deltas
            } else {
                Vec::new()
            },
            usage,
            failure: result.as_ref().err().cloned(),
        },
    )?;
    result.map_err(|failure| ExecutionError::new(failure.code, failure.message))?;
    let output = engine
        .persistence
        .lock()
        .map_err(error)?
        .context_job_output(&input.run_id, &id)
        .map_err(error)?;
    if output.node_id != node || output.state != "completed" {
        return Err(error("summary node did not complete"));
    }
    Ok(output)
}
