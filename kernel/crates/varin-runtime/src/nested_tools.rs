//! Live retention for an executing invocation, never an independent operation/receipt store.
use crate::execution::*;
use crate::ExecutorOwner;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, Weak};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NestedToolInput {
    pub call_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NestedToolReceipt {
    pub operation_id: String,
    pub completion: ToolCompletion,
}
type Invoke = dyn Fn(ToolExecutionContext, Arc<ToolCall>) -> Result<ToolExecutionReceipt, ExecutionError>
    + Send
    + Sync;
struct Call {
    context: ToolExecutionContext,
    call: Arc<ToolCall>,
    metadata: crate::catalog::tool_content::ToolCallMetadata,
    result: Mutex<Option<Result<Arc<ToolExecutionReceipt>, ExecutionError>>>,
    ready: Condvar,
}
struct Scope {
    owner: ExecutorOwner,
    context: ToolExecutionContext,
    frozen: Arc<FrozenToolContext>,
    invoke: Arc<Invoke>,
    state: Mutex<ScopeState>,
    drained: Condvar,
    cancel: CancellationToken,
}
struct ScopeState {
    accepting: bool,
    active: usize,
    calls: HashMap<String, Arc<Call>>,
}
#[derive(Default)]
pub struct NestedTools {
    scopes: Mutex<HashMap<String, Arc<Scope>>>,
    calls: Mutex<HashMap<String, Weak<Call>>>,
}
pub struct NestedScopeGuard {
    owner: Arc<NestedTools>,
    operation_id: String,
    scope: Arc<Scope>,
}
impl NestedScopeGuard {
    /// Close admission atomically against new registrations, then drain actual calls.
    /// An Unknown receipt is a completed call; its separate Operation retains occupancy.
    pub(crate) fn close(&self) {
        let mut state = self.scope.state.lock().unwrap_or_else(|p| p.into_inner());
        state.accepting = false;
        while state.active != 0 {
            state = self
                .scope
                .drained
                .wait(state)
                .unwrap_or_else(|p| p.into_inner());
        }
    }
}
impl Drop for NestedScopeGuard {
    fn drop(&mut self) {
        self.close();
        let mut scopes = self.owner.scopes.lock().unwrap_or_else(|p| p.into_inner());
        if scopes
            .get(&self.operation_id)
            .is_some_and(|scope| Arc::ptr_eq(scope, &self.scope))
        {
            scopes.remove(&self.operation_id);
        }
    }
}
fn error(message: &str) -> ExecutionError {
    ExecutionError::new("nested_tool", message)
}
impl NestedTools {
    pub(crate) fn register(
        self: &Arc<Self>,
        context: ToolExecutionContext,
        owner: ExecutorOwner,
        frozen: Arc<FrozenToolContext>,
        cancel: CancellationToken,
        invoke: Arc<Invoke>,
    ) -> Result<NestedScopeGuard, ExecutionError> {
        let mut scopes = self
            .scopes
            .lock()
            .map_err(|_| error("invocation scopes unavailable"))?;
        if scopes.contains_key(&context.operation_id) {
            return Err(error("invocation scope already active"));
        }
        let operation_id = context.operation_id.clone();
        let scope = Arc::new(Scope {
            owner,
            context,
            frozen,
            invoke,
            cancel,
            state: Mutex::new(ScopeState {
                accepting: true,
                active: 0,
                calls: HashMap::new(),
            }),
            drained: Condvar::new(),
        });
        scopes.insert(operation_id.clone(), scope.clone());
        Ok(NestedScopeGuard {
            owner: self.clone(),
            operation_id,
            scope,
        })
    }
    pub fn invoke(
        &self,
        parent_operation_id: &str,
        owner: &ExecutorOwner,
        input: NestedToolInput,
    ) -> Result<NestedToolReceipt, ExecutionError> {
        self.invoke_owned(parent_operation_id, owner, input, || {})
    }
    /// `owned` runs only after the complete call is registered against an accepting scope.
    /// Transport may release body credit then; this actual invocation still owns its receipt.
    pub fn invoke_owned(
        &self,
        parent_operation_id: &str,
        owner: &ExecutorOwner,
        input: NestedToolInput,
        owned: impl FnOnce(),
    ) -> Result<NestedToolReceipt, ExecutionError> {
        let scope = self
            .scopes
            .lock()
            .map_err(|_| error("invocation scopes unavailable"))?
            .get(parent_operation_id)
            .cloned()
            .ok_or_else(|| error("parent invocation has ended"))?;
        if &scope.owner != owner || scope.cancel.is_cancelled() {
            return Err(error("parent invocation is unavailable"));
        }
        if input.call_id.trim().is_empty() || input.name.trim().is_empty() {
            return Err(error("callId and name are required"));
        }
        let schema = scope
            .frozen
            .tools
            .iter()
            .find(|schema| schema.name == input.name)
            .ok_or_else(|| error("tool is not selected in the original invocation"))?;
        let call = ToolCall {
            call_id: input.call_id,
            name: input.name,
            arguments: input.arguments,
            schema_version: schema.version.clone(),
        };
        // Body identity is prepared before either scope/Catalog lock. Pure reads need no fsync.
        let metadata = crate::catalog::tool_content::ToolCallMetadata {
            call_id: call.call_id.clone(),
            name: call.name.clone(),
            schema_version: call.schema_version.clone(),
            arguments_ref: crate::content::ContentStore::reference(&call.arguments)
                .map_err(|_| error("nested input identity unavailable"))?,
        };
        let call = Arc::new(call);
        let origin = ToolOrigin::NestedCall {
            parent_operation_id: parent_operation_id.into(),
        };
        let context = ToolExecutionContext {
            run_id: scope.context.run_id.clone(),
            operation_id: origin.operation_id(&call.call_id),
            origin,
        };
        let (entry, fresh) = {
            let mut state = scope
                .state
                .lock()
                .map_err(|_| error("invocation calls unavailable"))?;
            if !state.accepting || scope.cancel.is_cancelled() {
                return Err(error("parent invocation has ended"));
            }
            if let Some(entry) = state.calls.get(&call.call_id) {
                if entry.metadata != metadata {
                    return Err(error("nested call identity has different input"));
                }
                (entry.clone(), false)
            } else {
                let entry = Arc::new(Call {
                    context: context.clone(),
                    call: call.clone(),
                    metadata,
                    result: Mutex::new(None),
                    ready: Condvar::new(),
                });
                state.calls.insert(call.call_id.clone(), entry.clone());
                state.active += 1;
                let mut active = self.calls.lock().unwrap_or_else(|p| p.into_inner());
                active.retain(|_, call| call.strong_count() > 0);
                active.insert(context.operation_id.clone(), Arc::downgrade(&entry));
                (entry, true)
            }
        };
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(owned));
        if fresh {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                (scope.invoke)(context, call)
            }))
            .unwrap_or_else(|_| Err(error("nested invocation stopped without a receipt")));
            *entry.result.lock().unwrap_or_else(|p| p.into_inner()) = Some(result.map(Arc::new));
            entry.ready.notify_all();
            let mut state = scope.state.lock().unwrap_or_else(|p| p.into_inner());
            state.active -= 1;
            scope.drained.notify_all();
        }
        let mut result = entry
            .result
            .lock()
            .map_err(|_| error("invocation result unavailable"))?;
        while result.is_none() {
            result = entry
                .ready
                .wait(result)
                .map_err(|_| error("invocation result unavailable"))?;
        }
        let receipt = result.as_ref().expect("settled invocation").clone()?;
        drop(result);
        Ok(NestedToolReceipt {
            operation_id: entry.context.operation_id.clone(),
            completion: receipt.completion.clone(),
        })
    }
    pub(crate) fn metadata(
        &self,
        context: &ToolExecutionContext,
    ) -> Option<crate::catalog::tool_content::ToolCallMetadata> {
        let entry = self
            .calls
            .lock()
            .ok()?
            .get(&context.operation_id)?
            .upgrade()?;
        (entry.context == *context).then(|| entry.metadata.clone())
    }
    /// A live cheap read has no durable Operation. Its actual scoped call remains inspectable
    /// during domain authorization; it disappears with the invoking callback.
    pub(crate) fn call(&self, context: &ToolExecutionContext) -> Option<Arc<ToolCall>> {
        let entry = self
            .calls
            .lock()
            .ok()?
            .get(&context.operation_id)?
            .upgrade()?;
        (entry.context == *context).then(|| entry.call.clone())
    }
}

pub(crate) type BindCall = dyn Fn(
        &ToolCall,
        &FrozenToolContext,
        &CancellationToken,
    ) -> Result<Box<dyn PreparedToolCall>, ExecutionError>
    + Send
    + Sync;
/// Retain the same frozen directory; adapters with no mutable directory keep their original
/// immutable instance. The closure erases only the generic type, never the selection authority.
pub(crate) fn directory<T: ToolExecutor + ?Sized>(
    selected: Option<Arc<dyn ToolExecutor>>,
    original: Arc<T>,
) -> Arc<BindCall> {
    Arc::new(move |call, context, cancel| match &selected {
        Some(directory) => directory.clone().bind_call(call, context, cancel),
        None => original.clone().bind_call(call, context, cancel),
    })
}

#[derive(Clone)]
pub(crate) struct NestedExecutionScope {
    pub frozen: Arc<FrozenToolContext>,
    pub directory: Arc<BindCall>,
    pub run_cancel: CancellationToken,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Effect, Outcome};
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::Duration;

    fn scope(registry: &Arc<NestedTools>, invoke: Arc<Invoke>) -> NestedScopeGuard {
        let origin = ToolOrigin::ModelStep {
            request_id: "request".into(),
        };
        registry
            .register(
                ToolExecutionContext {
                    run_id: "run".into(),
                    operation_id: origin.operation_id("outer"),
                    origin: origin.clone(),
                },
                ExecutorOwner::Kernel,
                Arc::new(FrozenToolContext {
                    run_id: "run".into(),
                    origin,
                    child_dispatch: None,
                    resource_activations: vec![],
                    resource_checkpoint_id: None,
                    tool_schema_generation: 8,
                    source: None,
                    tools: Arc::new(vec![ToolSchema {
                        requirements: None,
                        name: "selected".into(),
                        version: "original".into(),
                        description: "".into(),
                        schema: json!({}),
                        output_schema: None,
                        metadata: None,
                    }]),
                }),
                CancellationToken::default(),
                invoke,
            )
            .unwrap()
    }
    fn input(call_id: &str) -> NestedToolInput {
        NestedToolInput {
            call_id: call_id.into(),
            name: "selected".into(),
            arguments: json!({"value":1}),
        }
    }
    #[test]
    fn close_fences_and_drains_original_calls_without_waiting_for_unknown_physical_stop() {
        let registry = Arc::new(NestedTools::default());
        let (entered, arrived) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let wait = Mutex::new(wait);
        let guard = scope(
            &registry,
            Arc::new(move |_, call| {
                assert_eq!(call.schema_version, "original");
                entered.send(()).unwrap();
                wait.lock().unwrap().recv().unwrap();
                Ok(ToolExecutionReceipt {
                    executor_stopped: false,
                    completion: ToolCompletion::Result {
                        outcome: Outcome::Indeterminate,
                        effect: Effect::Unknown,
                        content: json!("original"),
                    },
                })
            }),
        );
        let r = registry.clone();
        let child = std::thread::spawn(move || {
            r.invoke("request:tool:outer", &ExecutorOwner::Kernel, input("one"))
        });
        arrived.recv_timeout(Duration::from_secs(3)).unwrap();
        let (closed, closing) = mpsc::channel();
        let state = guard.scope.clone();
        let worker = std::thread::spawn(move || {
            guard.close();
            closed.send(()).unwrap();
        });
        // Observe the actual close fence, without timing the unrelated executor.
        while state.state.lock().unwrap().accepting {
            std::thread::yield_now();
        }
        assert!(closing.try_recv().is_err());
        assert!(registry
            .invoke("request:tool:outer", &ExecutorOwner::Kernel, input("late"))
            .is_err());
        release.send(()).unwrap();
        closing.recv_timeout(Duration::from_secs(3)).unwrap();
        worker.join().unwrap();
        let receipt = child.join().unwrap().unwrap();
        assert!(matches!(
            receipt.completion,
            ToolCompletion::Result {
                effect: Effect::Unknown,
                ..
            }
        ));
        assert!(registry
            .invoke("request:tool:outer", &ExecutorOwner::Kernel, input("one"))
            .is_err());
    }
    #[test]
    fn original_owner_selection_and_short_input_identity_are_required() {
        let registry = Arc::new(NestedTools::default());
        let count = Arc::new(AtomicUsize::new(0));
        let executed = count.clone();
        let _guard = scope(
            &registry,
            Arc::new(move |_, _| {
                executed.fetch_add(1, Ordering::SeqCst);
                Ok(ToolExecutionReceipt::not_dispatched("fixture"))
            }),
        );
        for field in ["schemaVersion", "runId", "source", "executorOwner"] {
            let mut value = serde_json::to_value(input("invalid")).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert(field.into(), json!("invented"));
            assert!(serde_json::from_value::<NestedToolInput>(value).is_err());
        }
        for (call_id, name) in [("", "selected"), ("invalid", " ")] {
            let mut invalid = input(call_id);
            invalid.name = name.into();
            assert!(registry
                .invoke("request:tool:outer", &ExecutorOwner::Kernel, invalid)
                .is_err());
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
        let owner = ExecutorOwner::External {
            identity: "other".into(),
            epoch: "other".into(),
        };
        assert!(registry
            .invoke("request:tool:outer", &owner, input("one"))
            .is_err());
        let first = registry
            .invoke("request:tool:outer", &ExecutorOwner::Kernel, input("one"))
            .unwrap();
        assert_eq!(
            first,
            registry
                .invoke("request:tool:outer", &ExecutorOwner::Kernel, input("one"))
                .unwrap()
        );
        let mut changed = input("one");
        changed.arguments = json!({"value":2});
        assert!(registry
            .invoke("request:tool:outer", &ExecutorOwner::Kernel, changed)
            .is_err());
        let mut absent = input("two");
        absent.name = "not-selected".into();
        assert!(registry
            .invoke("request:tool:outer", &ExecutorOwner::Kernel, absent)
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn nested_identifiers_encode_the_pair_without_separator_or_unicode_collisions() {
        let root = "request:tool:é外";
        let origin = ToolOrigin::NestedCall {
            parent_operation_id: root.into(),
        };
        let direct = origin.operation_id("x:nested:y");
        let descendant = ToolOrigin::NestedCall {
            parent_operation_id: origin.operation_id("x"),
        }
        .operation_id("y");
        assert_ne!(direct, descendant);
        assert_eq!(
            origin.operation_id("call"),
            format!("nested:18:{root}:call")
        );
    }
}
