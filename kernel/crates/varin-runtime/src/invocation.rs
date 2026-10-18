//! The single prepared-invocation lifecycle shared by model batches, policy graphs and nested calls.
use super::*;
use crate::nested_tools::NestedExecutionScope;

pub(super) struct InvocationRunner<P: ?Sized> {
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
        let mut lease = None;
        let mut reservation = Some(reservation);
        let mut _admission_control = None;
        let mut executor_stopped = true;
        let completion = if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
            ToolCompletion::NotDispatched {
                reason: "cancelled".into(),
            }
        } else if let Err(error) = guarded("tool_admission_watch_panicked", || {
            _admission_control = bound.watch_admission(context, &tool.contract, cancel)?;
            Ok(())
        }) {
            ToolCompletion::NotDispatched {
                reason: format!("{}: {}", error.code, error.message),
            }
        } else if let Err(error) = guarded("tool_authorize_panicked", || {
            bound.authorize(context, &tool.contract, cancel)
        }) {
            ToolCompletion::NotDispatched {
                reason: format!("{}: {}", error.code, error.message),
            }
        } else {
            let ready = prepare_dispatch(cancel, || {
                lease = reservation
                    .take()
                    .expect("one admission per call")
                    .acquire()?;
                Ok(lease.is_some())
            })?;
            if !ready {
                ToolCompletion::NotDispatched {
                    reason: "cancelled".into(),
                }
            } else if let Err(error) = self
                .persistence
                .task_family(&self.run_id, self.epoch)
                .and_then(|_| {
                    guarded("tool_authorize_panicked", || {
                        bound.authorize(context, &tool.contract, cancel)
                    })
                })
            {
                ToolCompletion::NotDispatched {
                    reason: format!("{}: {}", error.code, error.message),
                }
            } else if cancel.is_cancelled() || !self.persistence.goal_tool_allowed(context)? {
                ToolCompletion::NotDispatched {
                    reason: "cancelled".into(),
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
                                    runner.execute_nested(
                                        context,
                                        call,
                                        &child_scope,
                                        &parent_cancel,
                                    )
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
                                self.persistence.confirms_no_effect(
                                    context,
                                    self.epoch,
                                    &completion,
                                )
                            })
                            .unwrap_or(false);
                        normalize_completion(completion, &tool.contract, confirmed_no_effect)
                    }
                    Ok(Err(error)) => ToolCompletion::NotDispatched {
                        reason: format!("{}: {}", error.code, error.message),
                    },
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
        let cancel = parent_cancel.child(&context.operation_id);
        scope.run_cancel.alias_child(&context.operation_id, &cancel);
        let mut frozen = scope.frozen.as_ref().clone();
        frozen.origin = context.origin.clone();
        let bound = (scope.directory)(&call, &frozen, &cancel)?;
        let preparation = bound.plan(&cancel)?;
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
            ToolPreparation::Resolve { .. } => bound.prepare(&cancel)?,
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
        let durable = bound.requires_operation() || !contract.read_only
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
