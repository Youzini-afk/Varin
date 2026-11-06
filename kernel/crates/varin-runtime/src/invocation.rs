//! The single prepared-invocation lifecycle shared by model batches, policy graphs and nested calls.
use super::*;
use crate::nested_tools::NestedExecutionScope;
use crate::resource_admission::{ResourceLease, ResourceReservation};
use std::task::Poll;

/// Suspension owns the original watch and reservation. No callback or partial resource lease
/// stays running while the batch waits. Dispatch and settlement still use InvocationRunner.
pub(super) struct InvocationAdmission {
    reservation: Option<ResourceReservation>,
    lease: Option<ResourceLease>,
    completion: Option<ToolCompletion>,
    _control: Option<crate::execution_capacity::AdmissionControlGuard>,
}
impl InvocationAdmission {
    pub(super) fn notify_on_change(&mut self, wake: mpsc::SyncSender<()>) {
        self.reservation
            .as_mut()
            .expect("undispatched reservation")
            .notify_on_change(wake);
    }
    pub(super) fn needs_executor(&self) -> bool {
        self.completion.is_none()
    }
    pub(super) fn try_acquire(
        &mut self,
        cancel: &CancellationToken,
    ) -> Poll<Result<(), ExecutionError>> {
        if self.completion.is_some() {
            return Poll::Ready(Ok(()));
        }
        let result = if cancel.is_cancelled() {
            Ok(None)
        } else {
            match self
                .reservation
                .as_mut()
                .expect("one admission per call")
                .try_acquire()
            {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(result) => result,
            }
        };
        // Cancellation after admission still releases an undispatched lease and settles the
        // original no-send result, including errors caused by revocation while registering.
        match result {
            Ok(lease) => self.lease = lease,
            Err(error) if !cancel.is_cancelled() => return Poll::Ready(Err(error)),
            Err(_) => {}
        }
        if self.lease.is_none() || cancel.is_cancelled() {
            self.completion = Some(ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
                error: None,
            });
        }
        Poll::Ready(Ok(()))
    }
    fn acquire(&mut self, cancel: &CancellationToken) -> Result<(), ExecutionError> {
        if self.completion.is_some() {
            return Ok(());
        }
        let ready = prepare_dispatch(cancel, || {
            self.lease = self
                .reservation
                .take()
                .expect("one admission per call")
                .acquire()?;
            Ok(self.lease.is_some())
        })?;
        if !ready {
            self.completion = Some(ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
                error: None,
            });
        }
        Ok(())
    }
}

pub(crate) struct InvocationRunner<P: ?Sized> {
    pub persistence: Arc<P>,
    pub run_id: String,
    pub epoch: u64,
}
impl<P: ?Sized> Clone for InvocationRunner<P> {
    fn clone(&self) -> Self {
        Self {
            persistence: self.persistence.clone(),
            run_id: self.run_id.clone(),
            epoch: self.epoch,
        }
    }
}
impl<P: Persistence + ?Sized + 'static> InvocationRunner<P> {
    pub fn execute(
        &self,
        context: &ToolExecutionContext,
        tool: &AdmittedTool,
        bound: &dyn PreparedToolCall,
        cancel: &CancellationToken,
        reservation: crate::resource_admission::ResourceReservation,
        durable: bool,
        nested: Option<NestedExecutionScope>,
    ) -> Result<ToolExecutionReceipt, ExecutionError> {
        let mut admission = self.prepare_admission(context, tool, bound, cancel, reservation)?;
        admission.acquire(cancel)?;
        self.execute_admitted(context, tool, bound, cancel, admission, durable, nested)
    }

    pub(super) fn prepare_admission(
        &self,
        context: &ToolExecutionContext,
        tool: &AdmittedTool,
        bound: &dyn PreparedToolCall,
        cancel: &CancellationToken,
        reservation: ResourceReservation,
    ) -> Result<InvocationAdmission, ExecutionError> {
        let mut control = None;
        let completion = if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
            Some(ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
                error: None,
            })
        } else if let Err(error) = guarded("tool_admission_watch_panicked", || {
            control = bound.watch_admission(context, &tool.contract, cancel)?;
            Ok(())
        }) {
            Some(ToolCompletion::not_dispatched(error))
        } else if let Err(error) = guarded("tool_authorize_panicked", || {
            bound.authorize(context, &tool.contract, cancel)
        }) {
            Some(ToolCompletion::not_dispatched(error))
        } else {
            None
        };
        Ok(InvocationAdmission {
            reservation: Some(reservation),
            lease: None,
            completion,
            _control: control,
        })
    }

    pub(super) fn execute_admitted(
        &self,
        context: &ToolExecutionContext,
        tool: &AdmittedTool,
        bound: &dyn PreparedToolCall,
        cancel: &CancellationToken,
        admission: InvocationAdmission,
        durable: bool,
        nested: Option<NestedExecutionScope>,
    ) -> Result<ToolExecutionReceipt, ExecutionError> {
        let InvocationAdmission {
            mut lease,
            completion,
            reservation: _reservation,
            _control,
        } = admission;
        if lease.is_none() && completion.is_none() {
            return Err(ExecutionError::new(
                "resource_admission_pending",
                "invocation cannot dispatch before atomic resource admission",
            ));
        }
        let mut executor_stopped = true;
        let completion = if let Some(completion) = completion {
            completion
        } else if let Err(error) = self
            .persistence
            .task_family(&self.run_id, self.epoch)
            .and_then(|_| {
                guarded("tool_authorize_panicked", || {
                    bound.authorize(context, &tool.contract, cancel)
                })
            })
        {
            ToolCompletion::not_dispatched(error)
        } else if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
            ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
                error: None,
            }
        } else {
            let dispatch_cancelled = if durable {
                match self.persistence.commit(
                    &self.run_id,
                    self.epoch,
                    &ExecutionRecord::ToolDispatched {
                        context: context.clone(),
                        executor_owner: bound.executor_owner(),
                    },
                ) {
                    Ok(()) => {
                        if let Some(lease) = lease.as_mut() {
                            lease.dispatched();
                        }
                        false
                    }
                    Err(error) if error.code == "dispatch_cancelled" => true,
                    Err(error) => return Err(error),
                }
            } else {
                false
            };
            let result = if dispatch_cancelled || cancel.is_cancelled() {
                Ok(Ok(ToolExecutionReceipt::not_dispatched("cancelled")))
            } else {
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if let Some(kind) = bound.managed_process() {
                        self.persistence.bind_managed_process(context, kind)?;
                    }
                    let nested_guard = if let (Some(registry), Some(scope)) =
                        (self.persistence.nested_tools(), nested.clone())
                    {
                        let runner = self.clone();
                        let child_scope = scope.clone();
                        let parent_cancel = cancel.child("nested-calls");
                        Some(registry.register(
                            context.clone(),
                            bound.executor_owner(),
                            scope.frozen.clone(),
                            parent_cancel.clone(),
                            Arc::new(move |context, call| {
                                runner.execute_nested(context, call, &child_scope, &parent_cancel)
                            }),
                        )?)
                    } else {
                        None
                    };
                    let receipt = bound.execute(context, &tool.contract, cancel);
                    if let Some(scope) = nested_guard {
                        scope.close();
                    }
                    // Nested Operations retain their own exact effect/stop receipts. Callback
                    // success describes only this executor, never a copied aggregate barrier.
                    Ok::<_, ExecutionError>(receipt)
                }))
            };
            match result {
                Ok(Ok(receipt)) => {
                    executor_stopped = receipt.executor_stopped;
                    let completion = receipt.completion;
                    let confirmed_no_effect = !tool.contract.read_only
                        && matches!(
                            &completion,
                            ToolCompletion::Result {
                                effect: Effect::None,
                                ..
                            }
                        )
                        && guarded("receipt_evidence_panicked", || {
                            self.persistence
                                .confirms_no_effect(context, self.epoch, &completion)
                        })
                        .unwrap_or(false);
                    normalize_completion(completion, &tool.contract, confirmed_no_effect)
                }
                Ok(Err(error)) => ToolCompletion::not_dispatched(error),
                Err(_) => {
                    executor_stopped = matches!(bound.executor_owner(), ExecutorOwner::Kernel)
                        && tool.contract.completion != CompletionKind::Job;
                    ToolCompletion::failure(
                        "tool_panicked",
                        "tool worker stopped without a receipt",
                        if tool.contract.read_only {
                            Effect::None
                        } else {
                            Effect::Unknown
                        },
                    )
                }
            }
        };
        let settled = if durable {
            self.persistence
                .settle_tool(
                    context,
                    self.epoch,
                    ToolExecutionReceipt {
                        completion,
                        executor_stopped,
                    },
                )
                .map(|receipt| {
                    executor_stopped = receipt.executor_stopped;
                    receipt.completion
                })
        } else {
            Ok(completion)
        };
        if durable && settled.is_ok() {
            let _ = guarded("receipt_cleanup_panicked", || {
                bound.receipt_persisted(context);
                Ok(())
            });
        }
        // Only original executor completion/stop evidence releases dispatched occupancy.
        if let Some(lease) = lease {
            if settled.is_err() || !executor_stopped {
                lease.handoff();
            } else {
                lease.release();
            }
        }
        settled.map(|completion| ToolExecutionReceipt {
            completion,
            executor_stopped,
        })
    }
    fn execute_nested(
        &self,
        context: ToolExecutionContext,
        call: Arc<ToolCall>,
        scope: &NestedExecutionScope,
        parent_cancel: &CancellationToken,
    ) -> Result<ToolExecutionReceipt, ExecutionError> {
        self.execute_call(context, call, scope, parent_cancel, false)
    }
    /// Driver calls and nested calls share the exact permission, resource, dispatch and
    /// receipt lifecycle. Only their already-admitted caller authority differs.
    pub(crate) fn execute_call(
        &self, context: ToolExecutionContext, call: Arc<ToolCall>, scope: &NestedExecutionScope,
        parent_cancel: &CancellationToken, force_durable: bool,
    ) -> Result<ToolExecutionReceipt, ExecutionError> {
        let cancel = parent_cancel.child(&context.operation_id);
        scope.run_cancel.alias_child(&context.operation_id, &cancel);
        let mut frozen = scope.frozen.as_ref().clone();
        frozen.origin = context.origin.clone();
        // Binding and planning run before executor dispatch. Their rejection is a
        // tool result, just as it is for a direct model call; it must not abort
        // the surrounding script. Identity/transport/persistence failures below
        // still propagate rather than inventing an execution receipt.
        let rejected = |error| Ok(ToolExecutionReceipt {
            completion: ToolCompletion::not_dispatched(error), executor_stopped: true,
        });
        let bound = match (scope.directory)(&call, &frozen, &cancel) {
            Ok(bound) => bound, Err(error) => return rejected(error),
        };
        let preparation = match bound.plan(&cancel) {
            Ok(plan) => plan, Err(error) => return rejected(error),
        };
        let (intents, class) = match &preparation {
            ToolPreparation::Ready(contract) => (
                contract
                    .resources
                    .iter()
                    .cloned()
                    .map(ResourceIntent::Exact)
                    .collect(),
                bound.execution_class(contract),
            ),
            ToolPreparation::Resolve { resources, class } => (resources.clone(), *class),
        };
        let identity = crate::execution_capacity::AdmissionIdentity {
            run_id: self.run_id.clone(),
            owner_generation: self.epoch,
            origin: context.origin.clone(),
            family_id: self.persistence.task_family(&self.run_id, self.epoch)?,
        };
        let mut reservation = self.persistence.resource_admission().reserve(
            &context.operation_id,
            intents,
            &identity,
            class,
            &cancel,
        )?;
        let contract = match preparation {
            ToolPreparation::Ready(contract) => contract,
            ToolPreparation::Resolve { .. } => match bound.prepare(&cancel) {
                Ok(contract) => contract, Err(error) => return rejected(error),
            },
        };
        if contract.name != call.name
            || contract.schema_version != call.schema_version
            || bound.execution_class(&contract) != class
        {
            return Err(ExecutionError::new(
                "contract_mismatch",
                "nested contract differs from frozen declaration",
            ));
        }
        reservation.resolve(&contract.resources)?;
        let durable = force_durable || bound.requires_operation() || !contract.read_only
            || contract.completion == CompletionKind::Job
            || !matches!(bound.executor_owner(), ExecutorOwner::Kernel);
        let tool = AdmittedTool {
            call: call.as_ref().clone(),
            contract,
        };
        if durable {
            self.persistence.commit(
                &self.run_id,
                self.epoch,
                &ExecutionRecord::ToolAdmitted {
                    context: context.clone(),
                    tool: tool.clone(),
                },
            )?;
        }
        self.execute(
            &context,
            &tool,
            bound.as_ref(),
            &cancel,
            reservation,
            durable,
            Some(NestedExecutionScope {
                frozen: Arc::new(frozen),
                directory: scope.directory.clone(),
                run_cancel: scope.run_cancel.clone(),
            }),
        )
    }
}
