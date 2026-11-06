//! Model-batch preparation and admission stages. Waiting reservations are data owned by the
//! Run worker; only preparation, actual execution and receipt settlement use child threads.
use super::*;
use crate::execution_capacity::ExecutionClass;
use crate::resource_admission::ResourceReservation;
use invocation::{InvocationAdmission, InvocationRunner};
use std::collections::VecDeque;
use std::task::Poll;

pub(super) struct PlannedCall {
    pub index: usize,
    pub bound: Box<dyn PreparedToolCall>,
    pub preparation: ToolPreparation,
    pub reservation: ResourceReservation,
    pub class: ExecutionClass,
    pub cancel: CancellationToken,
}
struct PreparedCall {
    index: usize,
    bound: Box<dyn PreparedToolCall>,
    context: ToolExecutionContext,
    tool: AdmittedTool,
    cancel: CancellationToken,
    durable: bool,
    admission: InvocationAdmission,
}
enum StageResult {
    Prepared(PreparedCall),
    Completed(ToolResult),
}

impl<
    P: Persistence + ?Sized,
    M: ModelProvider + ?Sized,
    T: ToolExecutor + ?Sized,
    A: AgentPolicy + ?Sized,
> ExecutionEngine<P, M, T, A>
{
    pub(super) fn execute_planned_batch(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        calls: &[ToolCall],
        planned: Vec<PlannedCall>,
        operation_tokens: &[CancellationToken],
        results: &mut [Option<ToolResult>],
        frozen: &FrozenToolContext,
        tools: Option<Arc<dyn ToolExecutor>>,
        cancel: &CancellationToken,
    ) -> Result<(), ExecutionError> {
        // Use a separate worker budget with the hardware-derived foreground default, independent of
        // compute occupancy. This is a per-batch worker budget, never a tool-count rejection or
        // a permit held by an executing coordinator/nested call. Resolve and Ready have separate
        // lanes so a stalled owner lookup cannot occupy Ready's preparation workers.
        let budget = crate::execution_capacity::default_compute_capacity().get();
        let mut preparation = [VecDeque::new(), VecDeque::new()];
        let mut remaining = planned.len();
        for call in planned {
            let lane = usize::from(matches!(call.preparation, ToolPreparation::Resolve { .. }));
            preparation[lane].push_back(call);
        }
        let runner = InvocationRunner {
            persistence: self.persistence.clone(),
            run_id: input.run_id.clone(),
            epoch: input.owner_generation,
        };
        let nested = crate::nested_tools::NestedExecutionScope {
            frozen: Arc::new(frozen.clone()),
            directory: crate::nested_tools::directory(tools, self.tools.clone()),
            run_cancel: cancel.clone(),
        };
        let mut failure = None;
        let mut waiting: Vec<PreparedCall> = Vec::new();
        let mut settlement = VecDeque::new();
        // 0/1 prepare Ready/Resolve; 2 settles undispatched results; 3 executes admitted work.
        // Only the first three lanes are bounded. Executing callbacks retain their original
        // resource/capacity policy, including the ability to invoke nested work.
        let mut running = [0usize; 4];
        let (wake, changed) = mpsc::sync_channel(1);
        let _cancellation = cancel.wake_on_cancel(wake.clone());
        // An exact Operation Stop must also retire an unstarted preparation while all
        // preparation workers are blocked. Reservation observers are installed only later.
        let _operation_cancellations: Vec<_> = operation_tokens
            .iter()
            .map(|token| token.wake_on_cancel(wake.clone()))
            .collect();
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel::<(usize, usize, Result<StageResult, ExecutionError>)>();
            let mut workers = BTreeMap::new();
            while remaining > 0 {
                for (lane, index, result) in rx.try_iter() {
                    // A completion message can precede the OS thread's final unwind. Join
                    // before reusing its preparation slot so the budget bounds real threads.
                    let worker: std::thread::ScopedJoinHandle<'_, ()> = workers
                        .remove(&(lane, index))
                        .expect("completion belongs to a batch worker");
                    worker.join().expect("batch worker catches callback panics");
                    running[lane] -= 1;
                    match result {
                        Ok(StageResult::Prepared(mut call)) => {
                            call.admission.notify_on_change(wake.clone());
                            waiting.push(call);
                        }
                        Ok(StageResult::Completed(result)) => {
                            results[index] = Some(result);
                            remaining -= 1;
                        }
                        Err(error) => {
                            remaining -= 1;
                            if failure.is_none() {
                                failure = Some(error);
                                for token in operation_tokens {
                                    token.cancel();
                                }
                            }
                        }
                    }
                }
                for (lane, queue) in preparation.iter_mut().enumerate() {
                    // Unstarted cancelled preparations own no durable operation. They must not
                    // perform new owner I/O merely to obtain a cancellation result.
                    let mut retained = VecDeque::new();
                    for call in queue.drain(..) {
                        if call.cancel.is_cancelled() {
                            results[call.index] = Some(self.unprepared_result(
                                input,
                                snapshot,
                                &calls[call.index],
                                ToolCompletion::cancelled(),
                            ));
                            remaining -= 1;
                        } else {
                            retained.push_back(call);
                        }
                    }
                    *queue = retained;
                    while running[lane] < budget {
                        let Some(call) = queue.pop_front() else {
                            break;
                        };
                        let index = call.index;
                        let tx = tx.clone();
                        let wake = wake.clone();
                        let runner = &runner;
                        running[lane] += 1;
                        let worker = scope.spawn(move || {
                            let result = guarded("tool_worker_panicked", || {
                                self.prepare_batch_call(
                                    input,
                                    snapshot,
                                    &calls[index],
                                    call,
                                    runner,
                                )
                            });
                            let _ = tx.send((lane, index, result));
                            let _ = wake.try_send(());
                        });
                        workers.insert((lane, index), worker);
                    }
                }
                let mut position = 0;
                while position < waiting.len() {
                    let call = &mut waiting[position];
                    let outcome = call.admission.try_acquire(&call.cancel);
                    match outcome {
                        Poll::Pending => position += 1,
                        Poll::Ready(Err(error)) => {
                            waiting.remove(position);
                            remaining -= 1;
                            if failure.is_none() {
                                failure = Some(error);
                                for token in operation_tokens {
                                    token.cancel();
                                }
                            }
                        }
                        Poll::Ready(Ok(())) => {
                            let call = waiting.remove(position);
                            if !call.admission.needs_executor() {
                                settlement.push_back(call);
                            } else {
                                let tx = tx.clone();
                                let wake = wake.clone();
                                let runner = &runner;
                                let nested = &nested;
                                running[3] += 1;
                                let index = call.index;
                                let worker = scope.spawn(move || {
                                    let result = guarded("tool_worker_panicked", || {
                                        self.finish_batch_call(
                                            input, snapshot, call, runner, nested,
                                        )
                                    });
                                    let _ = tx.send((3, index, result));
                                    let _ = wake.try_send(());
                                });
                                workers.insert((3, index), worker);
                            }
                        }
                    }
                }
                while running[2] < budget {
                    let Some(call) = settlement.pop_front() else {
                        break;
                    };
                    let tx = tx.clone();
                    let wake = wake.clone();
                    let runner = &runner;
                    let nested = &nested;
                    running[2] += 1;
                    let index = call.index;
                    let worker = scope.spawn(move || {
                        let result = guarded("tool_worker_panicked", || {
                            self.finish_batch_call(input, snapshot, call, runner, nested)
                        });
                        let _ = tx.send((2, index, result));
                        let _ = wake.try_send(());
                    });
                    workers.insert((2, index), worker);
                }
                if remaining > 0 {
                    // Registration precedes polling; worker messages precede their wake. A
                    // single event is sufficient even when several changes coalesce.
                    changed
                        .recv()
                        .expect("batch retains its notification sender");
                }
            }
        });
        failure.map_or(Ok(()), Err)
    }

    fn prepare_batch_call(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        call: &ToolCall,
        planned: PlannedCall,
        runner: &InvocationRunner<P>,
    ) -> Result<StageResult, ExecutionError> {
        let PlannedCall {
            index,
            bound,
            preparation,
            mut reservation,
            class,
            cancel,
        } = planned;
        let contract = guarded("tool_prepare_panicked", || {
            let contract = match preparation {
                ToolPreparation::Ready(contract) => contract,
                ToolPreparation::Resolve { .. } => bound.prepare(&cancel)?,
            };
            if contract.name != call.name || contract.schema_version != call.schema_version {
                return Err(ExecutionError::new(
                    "contract_mismatch",
                    "resolved tool differs from frozen schema",
                ));
            }
            if bound.execution_class(&contract) != class {
                return Err(ExecutionError::new(
                    "execution_class_mismatch",
                    "resolved execution class differs from preplanning",
                ));
            }
            reservation.resolve(&contract.resources)?;
            Ok(contract)
        });
        let contract = match contract {
            Ok(contract) => contract,
            Err(error) => {
                return Ok(StageResult::Completed(self.unprepared_result(
                    input,
                    snapshot,
                    call,
                    if cancel.is_cancelled() {
                        ToolCompletion::cancelled()
                    } else {
                        ToolCompletion::failed(&error, Effect::None)
                    },
                )));
            }
        };
        let tool = AdmittedTool {
            call: call.clone(),
            contract,
        };
        let context = ToolExecutionContext {
            run_id: input.run_id.clone(),
            origin: ToolOrigin::ModelStep {
                request_id: snapshot.view.request_id.clone(),
            },
            operation_id: format!("{}:tool:{}", snapshot.view.request_id, call.call_id),
        };
        let durable = bound.requires_operation()
            || !tool.contract.read_only
            || tool.contract.completion == CompletionKind::Job;
        if durable {
            self.commit(
                input,
                ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: tool.clone(),
                },
            )?;
        }
        let admission =
            runner.prepare_admission(&context, &tool, bound.as_ref(), &cancel, reservation)?;
        Ok(StageResult::Prepared(PreparedCall {
            index,
            bound,
            context,
            tool,
            cancel,
            durable,
            admission,
        }))
    }

    fn finish_batch_call(
        &self,
        input: &ExecutionInput,
        snapshot: &RequestSnapshot,
        call: PreparedCall,
        runner: &InvocationRunner<P>,
        nested: &crate::nested_tools::NestedExecutionScope,
    ) -> Result<StageResult, ExecutionError> {
        let receipt = runner.execute_admitted(
            &call.context,
            &call.tool,
            call.bound.as_ref(),
            &call.cancel,
            call.admission,
            call.durable,
            Some(nested.clone()),
        )?;
        Ok(StageResult::Completed(self.unprepared_result(
            input,
            snapshot,
            &call.tool.call,
            receipt.completion,
        )))
    }
}
