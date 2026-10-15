//! Private file observer adapter: original Catalog binding, Host root watcher and
//! Storage single-path read. Work runs outside both control owners.
use crate::storage::file_observations::{ReadTask, Snapshot, Target};
use crate::{error::KernelError, host_query::OwnerChannel, storage::Storage, tools::ToolBinding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::{catalog::followups::*, execution::CancellationToken, Catalog};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Admission {
    Local {
        grant_id: String,
    },
    ManagedHost {
        coordinator_host_id: String,
        authority_id: String,
        resource_epoch: String,
    },
}

pub(crate) enum Command {
    Idle {
        request: FileObservationRequest,
        reply: mpsc::Sender<Result<bool, KernelError>>,
    },
    ManagedAccept {
        request: FileObservationRequest,
        address: crate::source_resources::SourceAuthorityAddress,
        reply: mpsc::Sender<Result<Target, KernelError>>,
    },
    Baseline {
        request: FileObservationRequest,
        observed: Option<PreparedFileObservation>,
        address: crate::source_resources::SourceAuthorityAddress,
        reply: mpsc::Sender<Result<Option<PreparedFileObservation>, KernelError>>,
    },
    ManagedRelease {
        request: FileObservationRequest,
        address: crate::source_resources::SourceAuthorityAddress,
        reply: mpsc::Sender<Result<bool, KernelError>>,
    },
    Accept {
        request: FileObservationRequest,
        grant_id: String,
        binding: Option<ToolBinding>,
        reply: mpsc::Sender<Result<Target, KernelError>>,
    },
    Describe {
        request: FileObservationRequest,
        authorize: bool,
        reply: mpsc::Sender<Result<Target, KernelError>>,
    },
    Prepare {
        request: FileObservationRequest,
        cancel: Arc<AtomicBool>,
        reply: mpsc::Sender<Result<ReadTask, KernelError>>,
    },
    Finish {
        task: ReadTask,
        result: Result<FileState, KernelError>,
        reply: mpsc::Sender<Result<Snapshot, KernelError>>,
    },
    Acceptances {
        after: Option<String>,
        strict: bool,
        followup_id: Option<String>,
        reply: mpsc::Sender<Result<(Vec<FileObservationRequest>, Option<String>), KernelError>>,
    },
    Release {
        request: FileObservationRequest,
        reply: mpsc::Sender<Result<bool, KernelError>>,
    },
}
impl Command {
    pub(crate) fn serve(
        self,
        storage: Option<&mut Storage>,
        epoch: &str,
        host: &str,
        generation: &str,
    ) {
        let missing = || KernelError::Storage("file observation Storage owner unavailable".into());
        match self {
            Self::Idle { request, reply } => {
                let _ = reply.send(
                    storage
                        .ok_or_else(missing)
                        .and_then(|s| s.file_observation_idle(&request, host)),
                );
            }
            Self::ManagedAccept {
                request,
                address,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.accept_managed_file_observation(&request, &address, epoch, host, generation)
                }));
            }
            Self::Baseline {
                request,
                observed,
                address,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.initial_file_observation(&request, observed, &address, epoch, host)
                }));
            }
            Self::ManagedRelease {
                request,
                address,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.release_managed_file_observation(&request, &address, epoch, host)
                }));
            }
            Self::Accept {
                request,
                grant_id,
                binding,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.accept_file_observation(
                        &request,
                        &grant_id,
                        binding.as_ref(),
                        epoch,
                        host,
                        generation,
                    )
                }));
            }
            Self::Describe {
                request,
                authorize,
                reply,
            } => {
                let _ = reply.send(
                    storage
                        .ok_or_else(missing)
                        .and_then(|s| s.describe_file_observation(&request, authorize, host)),
                );
            }
            Self::Prepare {
                request,
                cancel,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.prepare_file_observation(request, cancel, epoch, host, generation)
                }));
            }
            Self::Finish {
                task,
                result,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.finish_file_observation(task, result, epoch, host, generation)
                }));
            }
            Self::Acceptances {
                after,
                strict,
                followup_id,
                reply,
            } => {
                let _ = reply.send(storage.ok_or_else(missing).and_then(|s| {
                    s.file_acceptance_page(after.as_deref(), strict, followup_id.as_deref())
                }));
            }
            Self::Release { request, reply } => {
                let _ = reply.send(
                    storage
                        .ok_or_else(missing)
                        .and_then(|s| s.release_file_observation(&request)),
                );
            }
        }
    }
}
#[derive(Clone)]
pub(crate) struct Client {
    send: Arc<dyn Fn(Command) -> Result<(), KernelError> + Send + Sync>,
    bridge: OwnerChannel,
    source_bridge: Option<OwnerChannel>,
}
pub(crate) struct RegistrationGuard {
    client: Client,
    catalog: Arc<Mutex<Catalog>>,
    items: Vec<(FileObservationRequest, Target, Option<String>)>,
}
impl Drop for RegistrationGuard {
    fn drop(&mut self) {
        for (request, target, watch) in &self.items {
            let (referenced, may_release) = self
                .catalog
                .lock()
                .ok()
                .map(|c| match c.followup(&request.followup_id) {
                    Ok(definition) => {
                        let current = definition
                            .sources
                            .get(request.source_index)
                            .and_then(|s| s.file.as_ref())
                            .and_then(|f| f.watch_id.as_ref());
                        (
                            watch.as_ref().is_some_and(|watch| current == Some(watch)),
                            false,
                        )
                    }
                    Err(varin_runtime::RuntimeError::NotFound(_)) => (
                        false,
                        c.file_acceptance_may_release(request).unwrap_or(false),
                    ),
                    Err(_) => (true, false),
                })
                .unwrap_or((true, false));
            // A caller abort is not cancellation of a shared durable User intent.
            if may_release {
                let _ = self.client.release_request(request);
            }
            if !referenced && request.resource_authority.is_none() {
                if let Some(watch) = watch {
                    self.client.close(target, watch);
                }
            }
        }
    }
}
struct WatchGuard<'a> {
    client: &'a Client,
    target: &'a Target,
    watch: String,
    close: bool,
}
impl Drop for WatchGuard<'_> {
    fn drop(&mut self) {
        if self.close {
            self.client.close(self.target, &self.watch);
        }
    }
}
fn failed(e: impl ToString) -> KernelError {
    KernelError::Operation(e.to_string())
}
impl Client {
    /// B composes its original read worker and Documents watcher without an Agent Catalog.
    pub(crate) fn execute_managed(
        &self,
        address: crate::source_resources::SourceAuthorityAddress,
        action: crate::source_resources::SourceFileObservationAction,
        cancel: &CancellationToken,
    ) -> Result<Value, KernelError> {
        use crate::source_resources::SourceFileObservationAction as A;
        let result = (|| -> Result<Value, KernelError> {
            match action {
                A::Accept { request } => {
                    let target = self.request(|reply| Command::ManagedAccept {
                        request: request.clone(),
                        address: address.clone(),
                        reply,
                    })?;
                    let first = self.request(|reply| Command::Baseline {
                        request: request.clone(),
                        observed: None,
                        address: address.clone(),
                        reply,
                    })?;
                    let observation = if let Some(original) = first {
                        original
                    } else {
                        let observed = self.observe_managed_target(
                            &request, &target, None, None, None, false, cancel,
                        )?;
                        match self.request(|reply| Command::Baseline {
                            request: request.clone(),
                            observed: Some(observed),
                            address,
                            reply,
                        }) {
                            Ok(Some(value)) => value,
                            Ok(None) => return Err(failed("Original baseline missing")),
                            Err(error) => {
                                let _ = self.query(
                                    json!({"action":"release","receiptId":request.receipt_id()}),
                                    &CancellationToken::default(),
                                );
                                return Err(error);
                            }
                        }
                    };
                    Ok(json!({"ok":true,"observation":observation}))
                }
                A::Observe {
                    request,
                    watch_id,
                    after,
                    current,
                    ready,
                    ..
                } => {
                    let target = self.request(|reply| Command::Describe {
                        request: request.clone(),
                        authorize: true,
                        reply,
                    })?;
                    let observation = self.observe_managed_target(
                        &request, &target, watch_id, after, current, ready, cancel,
                    )?;
                    Ok(json!({"ok":true,"observation":observation}))
                }
                A::Release { request } => {
                    let released = self.request(|reply| Command::ManagedRelease {
                        request: request.clone(),
                        address,
                        reply,
                    })?;
                    self.query(
                        json!({"action":"release","receiptId":request.receipt_id()}),
                        &CancellationToken::default(),
                    )?;
                    Ok(json!({"ok":true,"released":released}))
                }
            }
        })();
        result.or_else(|error| {
            if cancel.is_cancelled() {
                return Err(error);
            }
            let code = match &error {
                KernelError::Authorization(message) if message == "file_observation_revoked" => {
                    "authority_revoked"
                }
                KernelError::Authorization(_) => "authority_denied",
                KernelError::FileObservationSource(code) => code.as_str(),
                KernelError::Cancelled => "cancelled",
                _ => "source_unavailable",
            };
            Ok(json!({"ok":false,"code":code}))
        })
    }
    fn observe_managed_target(
        &self,
        r: &FileObservationRequest,
        target: &Target,
        previous: Option<String>,
        after: Option<FileWatchPosition>,
        current: Option<FileState>,
        was_ready: bool,
        cancel: &CancellationToken,
    ) -> Result<PreparedFileObservation, KernelError> {
        if target.immutable {
            return self.observe_target_local(r, target, None, None, false, cancel);
        }
        let resumed = self.query(json!({"action":"resume","target":target}), cancel)?;
        let watch = resumed["watchId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| failed("Original watcher missing"))?
            .to_owned();
        let gap = previous.as_ref().is_some_and(|old| *old != watch);
        if current.is_some() && after.is_some() && !gap {
            // Probe the original watch and both writer owners before considering
            // reuse of A's accepted version. No second body cache lives on B.
            let begin = self.query(
                json!({"action":"begin","target":target,"watchId":watch,"after":after}),
                cancel,
            )?;
            let token = begin["token"]
                .as_str()
                .ok_or_else(|| failed("file probe token missing"))?;
            let finish=match self.query(json!({"action":"finish","target":target,"watchId":watch,"token":token,"after":after}),cancel){Ok(v)=>v,Err(e)=>{self.discard(target,&watch,token);return Err(e)}};
            let idle = self.request(|reply| Command::Idle {
                request: r.clone(),
                reply,
            })?;
            let stable = finish["stable"]
                .as_bool()
                .ok_or_else(|| failed("file stability evidence missing"))?;
            let ready = idle
                && finish["managedIdle"]
                    .as_bool()
                    .ok_or_else(|| failed("file writer evidence missing"))?;
            let changed = finish["readRequired"]
                .as_bool()
                .ok_or_else(|| failed("file change evidence missing"))?;
            if stable && !changed && ready == was_ready {
                return Ok(PreparedFileObservation {
                    resource_authority: r.resource_authority.clone(),
                    source_index: r.source_index,
                    receipt_id: r.receipt_id(),
                    state: current,
                    immutable: false,
                    watch_id: Some(watch),
                    position: Some(serde_json::from_value(finish["position"].clone())?),
                    gap: false,
                    targeted_change: false,
                    ready,
                });
            }
        }
        let mut observed =
            self.observe_target_local(r, target, Some(watch), after, false, cancel)?;
        observed.gap |= gap;
        Ok(observed)
    }
    pub(crate) fn new(
        send: impl Fn(Command) -> Result<(), KernelError> + Send + Sync + 'static,
        bridge: OwnerChannel,
    ) -> Self {
        Self {
            send: Arc::new(send),
            bridge,
            source_bridge: None,
        }
    }
    pub(crate) fn with_source_bridge(mut self, bridge: OwnerChannel) -> Self {
        self.source_bridge = Some(bridge);
        self
    }
    fn source_query(&self, value: Value, cancel: &CancellationToken) -> Result<Value, KernelError> {
        let reply = self
            .source_bridge
            .as_ref()
            .ok_or_else(|| failed("Managed source owner unavailable"))?
            .query(value, cancel)
            .map_err(failed)?;
        if reply["ok"] != true {
            return Err(failed(
                reply["message"]
                    .as_str()
                    .unwrap_or("Managed file observation unavailable"),
            ));
        }
        Ok(reply["value"].clone())
    }
    pub(crate) fn admission(
        &self,
        binding: &ToolBinding,
        cancel: &CancellationToken,
    ) -> Result<Admission, KernelError> {
        if binding.resource_owner.is_local() {
            return Ok(Admission::Local {
                grant_id: binding.grant_id.clone(),
            });
        }
        serde_json::from_value(self.source_query(
            json!({"kind":"file_observation_address","binding":binding}),
            cancel,
        )?)
        .map_err(Into::into)
    }
    fn remote(
        &self,
        r: &FileObservationRequest,
        action: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, KernelError> {
        let authority = r
            .resource_authority
            .as_ref()
            .ok_or_else(|| failed("Original managed file authority missing"))?;
        let value=self.source_query(json!({"kind":"file_observation","source":r.source,"authority":authority,"action":action}),cancel)?;
        if value["ok"] == false {
            let code = value["code"].as_str().unwrap_or("source_unavailable");
            if code == "authority_revoked" {
                return Err(KernelError::Authorization(
                    "file_observation_revoked".into(),
                ));
            }
            return Err(crate::error::FileObservationSourceCode::parse(code)
                .map(KernelError::FileObservationSource)
                .unwrap_or_else(|| failed(code)));
        }
        if value["ok"] != true {
            return Err(failed("Unconfirmed file observation response"));
        }
        Ok(value)
    }
    fn remote_target(r: &FileObservationRequest) -> Target {
        Target {
            receipt_id: r.receipt_id(),
            followup_id: r.followup_id.clone(),
            source_index: r.source_index,
            source_run_id: r.source_run_id.clone(),
            thread_id: r.thread_id.clone(),
            source: r.source.clone(),
            physical_root: None,
            path: r.path.clone(),
            immutable: r.source.mode == varin_runtime::SourceMode::FixedBranch,
        }
    }
    fn close_registration_scope(&self, r: &FileObservationRequest) -> Result<(), KernelError> {
        let Some(scope) = &r.registration_scope else {
            return Ok(());
        };
        let mut source = r.source.clone();
        if source.mode == varin_runtime::SourceMode::Materialized
            && source.environment_run_id.is_none()
        {
            source.environment_run_id = Some(r.source_run_id.clone());
        }
        let result=self.source_query(json!({"kind":"file_observation_scope_close","source":source,"coordinatorHostId":scope.coordinator_host_id,"scope":{"kind":"source_read","threadId":r.thread_id,"branchId":scope.branch_id,"key":scope.key}}),&CancellationToken::default())?;
        if result["closed"] != true {
            return Err(failed("Original file registration scope is not closed"));
        }
        Ok(())
    }
    fn release_request(&self, r: &FileObservationRequest) -> Result<bool, KernelError> {
        if !r.source.resource_owner.is_local() {
            if r.resource_authority.is_some() {
                return self.remote(
                    r,
                    json!({"kind":"release","request":r}),
                    &CancellationToken::default(),
                )?["released"]
                    .as_bool()
                    .ok_or_else(|| failed("File release acknowledgement missing"));
            }
            self.close_registration_scope(r)?;
            return Ok(true);
        }
        self.request(|reply| Command::Release {
            request: r.clone(),
            reply,
        })
    }
    fn request<T>(
        &self,
        command: impl FnOnce(mpsc::Sender<Result<T, KernelError>>) -> Command,
    ) -> Result<T, KernelError> {
        let (tx, rx) = mpsc::channel();
        (self.send)(command(tx))?;
        rx.recv().map_err(failed)?
    }
    fn query(&self, value: Value, cancel: &CancellationToken) -> Result<Value, KernelError> {
        let result = self.bridge.query(value, cancel).map_err(failed)?;
        match result["ok"].as_bool() {
            Some(true) => Ok(result),
            Some(false) => {
                let code = result["code"]
                    .as_str()
                    .and_then(crate::error::FileObservationSourceCode::parse)
                    .ok_or_else(|| {
                        KernelError::Protocol("invalid file observation source failure".into())
                    })?;
                Err(KernelError::FileObservationSource(code))
            }
            None => Err(KernelError::Protocol(
                "file observation reply has no outcome".into(),
            )),
        }
    }
    pub(crate) fn describe(&self, r: &FileObservationRequest) -> Result<Target, KernelError> {
        if !r.source.resource_owner.is_local() {
            return Ok(Self::remote_target(r));
        }
        self.request(|reply| Command::Describe {
            request: r.clone(),
            authorize: false,
            reply,
        })
    }
    fn read(
        &self,
        r: &FileObservationRequest,
        cancel: &CancellationToken,
    ) -> Result<Snapshot, KernelError> {
        let task = self.request(|reply| Command::Prepare {
            request: r.clone(),
            cancel: cancel.shared_flag(),
            reply,
        })?;
        let result = task.run();
        self.request(|reply| Command::Finish {
            task,
            result,
            reply,
        })
    }
    fn close(&self, target: &Target, watch: &str) {
        let _ = self.query(
            json!({"action":"close","receiptId":target.receipt_id,"watchId":watch}),
            &CancellationToken::default(),
        );
    }
    fn discard(&self, target: &Target, watch: &str, token: &str) {
        let _ = self.query(
            json!({"action":"discard","receiptId":target.receipt_id,"watchId":watch,"token":token}),
            &CancellationToken::default(),
        );
    }
    fn open(
        &self,
        target: &Target,
        cancel: &CancellationToken,
    ) -> Result<(String, FileWatchPosition), KernelError> {
        let result = self.query(json!({"action":"open","target":target}), cancel)?;
        let watch = result["watchId"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| failed("watch identity missing"))?
            .to_owned();
        let position = serde_json::from_value(result["position"].clone())?;
        Ok((watch, position))
    }
    fn observe_target(
        &self,
        r: &FileObservationRequest,
        target: &Target,
        watch: Option<String>,
        after: Option<FileWatchPosition>,
        reopen: bool,
        current: Option<FileState>,
        ready: bool,
        cancel: &CancellationToken,
    ) -> Result<PreparedFileObservation, KernelError> {
        if !r.source.resource_owner.is_local() {
            return serde_json::from_value(self.remote(r,json!({"kind":"observe","request":r,"watchId":watch,"after":after,"reopen":reopen,"current":current,"ready":ready}),cancel)?["observation"].clone()).map_err(Into::into);
        }
        self.observe_target_local(r, target, watch, after, reopen, cancel)
    }
    fn observe_target_local(
        &self,
        r: &FileObservationRequest,
        target: &Target,
        watch: Option<String>,
        after: Option<FileWatchPosition>,
        reopen: bool,
        cancel: &CancellationToken,
    ) -> Result<PreparedFileObservation, KernelError> {
        if target.immutable {
            let snapshot = self.read(r, cancel)?;
            return Ok(PreparedFileObservation {
                resource_authority: r.resource_authority.clone(),
                source_index: r.source_index,
                receipt_id: r.receipt_id(),
                state: Some(snapshot.state),
                immutable: true,
                watch_id: None,
                position: None,
                gap: false,
                targeted_change: false,
                ready: true,
            });
        }
        let replacement = reopen || watch.is_none();
        let (watch, opened) = if replacement {
            let (w, p) = self.open(target, cancel)?;
            (w, Some(p))
        } else {
            (watch.expect("watch"), None)
        };
        let mut watch_guard = WatchGuard {
            client: self,
            target,
            watch: watch.clone(),
            close: replacement,
        };
        let begin = self.query(
            json!({"action":"begin","target":target,"watchId":watch,"after":after}),
            cancel,
        )?;
        let token = begin["token"]
            .as_str()
            .ok_or_else(|| failed("file read token missing"))?
            .to_owned();
        let beginning: FileWatchPosition = serde_json::from_value(begin["position"].clone())?;
        let base = after.clone().or(Some(beginning));
        let snapshot = match self.read(r, cancel) {
            Ok(s) => s,
            Err(KernelError::FileObservationBusy | KernelError::SnapshotChanged(_)) => {
                self.discard(target, &watch, &token);
                watch_guard.close = false;
                return Ok(PreparedFileObservation {
                    resource_authority: r.resource_authority.clone(),
                    source_index: r.source_index,
                    receipt_id: r.receipt_id(),
                    state: None,
                    immutable: false,
                    watch_id: Some(watch),
                    position: base,
                    gap: replacement && after.is_some(),
                    targeted_change: false,
                    ready: false,
                });
            }
            Err(e) => {
                self.discard(target, &watch, &token);
                return Err(e);
            }
        };
        let finish = match self.query(
            json!({"action":"finish","target":target,"watchId":watch,"token":token,"after":base}),
            cancel,
        ) {
            Ok(v) => v,
            Err(e) => {
                self.discard(target, &watch, &token);
                return Err(e);
            }
        };
        let position: FileWatchPosition = serde_json::from_value(finish["position"].clone())?;
        let gap = finish["gap"]
            .as_bool()
            .ok_or_else(|| failed("file gap evidence missing"))?
            || (replacement && after.is_some())
            || opened.as_ref().is_some_and(|p| {
                p.source_id != position.source_id || p.generation != position.generation
            });
        let targeted = finish["targetedChange"]
            .as_bool()
            .ok_or_else(|| failed("file change evidence missing"))?;
        let stable = finish["stable"]
            .as_bool()
            .ok_or_else(|| failed("file stability evidence missing"))?;
        let idle = finish["managedIdle"]
            .as_bool()
            .ok_or_else(|| failed("file writer evidence missing"))?;
        watch_guard.close = false;
        Ok(PreparedFileObservation {
            resource_authority: r.resource_authority.clone(),
            source_index: r.source_index,
            receipt_id: r.receipt_id(),
            state: stable.then_some(snapshot.state),
            immutable: false,
            watch_id: Some(watch),
            position: if stable { Some(position) } else { base },
            gap,
            targeted_change: stable && targeted,
            ready: stable && idle && snapshot.storage_idle,
        })
    }
    pub(crate) fn prepare_registration(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        p: &mut PreparedFollowupRegistration,
        authority: &Admission,
        binding: Option<&ToolBinding>,
        cancel: &CancellationToken,
    ) -> Result<RegistrationGuard, KernelError> {
        let mut guard = RegistrationGuard {
            client: self.clone(),
            catalog: catalog.clone(),
            items: Vec::new(),
        };
        if p.already_accepted() {
            return Ok(guard);
        }
        if let Admission::ManagedHost {
            coordinator_host_id,
            authority_id,
            resource_epoch,
        } = authority
        {
            catalog
                .lock()
                .map_err(failed)?
                .stage_file_registration(
                    p,
                    Some(coordinator_host_id),
                    Some(FileObservationAuthority {
                        coordinator_host_id: coordinator_host_id.clone(),
                        authority_id: authority_id.clone(),
                        resource_epoch: resource_epoch.clone(),
                    }),
                )
                .map_err(failed)?;
            if p.already_accepted() {
                return Ok(guard);
            }
        }
        let mut prepared = Vec::new();
        for request in p.file_requests().map_err(failed)? {
            let authorization = {
                let owner = catalog.lock().map_err(failed)?;
                owner.authorize_followup_registration(p)
            };
            authorization.map_err(failed)?;
            if !request.source.resource_owner.is_local() {
                let target = Self::remote_target(&request);
                guard.items.push((request.clone(), target, None));
                let observed: PreparedFileObservation = serde_json::from_value(
                    self.remote(&request, json!({"kind":"accept","request":request}), cancel)?
                        ["observation"]
                        .clone(),
                )?;
                guard.items.last_mut().expect("accepted source").2 = observed.watch_id.clone();
                catalog
                    .lock()
                    .map_err(failed)?
                    .authorize_followup_registration(p)
                    .map_err(failed)?;
                prepared.push(observed);
                continue;
            }
            let Admission::Local { grant_id } = authority else {
                return Err(failed("Local file registration requires local authority"));
            };
            let target = self.request(|reply| Command::Accept {
                request: request.clone(),
                grant_id: grant_id.into(),
                binding: binding.cloned(),
                reply,
            })?;
            guard.items.push((request.clone(), target.clone(), None));
            let authorization = {
                let owner = catalog.lock().map_err(failed)?;
                owner.authorize_followup_registration(p)
            };
            authorization.map_err(failed)?;
            let (watch, position) = if target.immutable {
                (None, None)
            } else {
                let (w, p) = self.open(&target, cancel)?;
                (Some(w), Some(p))
            };
            guard.items.last_mut().expect("accepted source").2 = watch.clone();
            let observed = self.observe_target(
                &request, &target, watch, position, false, None, false, cancel,
            )?;
            prepared.push(observed);
        }
        p.bind_file_observations(prepared).map_err(failed)?;
        if let Some((request, _, _)) = guard
            .items
            .first()
            .filter(|(r, _, _)| r.actor == FollowupActor::User && r.resource_authority.is_some())
        {
            // Every original leaf has acknowledged its baseline. Caller retirement
            // does not release any of those independent observation receipts.
            self.close_registration_scope(request)?;
        }
        Ok(guard)
    }
    pub(crate) fn release(&self, work: &FileObservationWork) -> Result<bool, KernelError> {
        if !work.release_required {
            return Err(failed("Catalog still requires this file observation"));
        }
        let target = self.describe(&work.request)?;
        let drained = self.release_request(&work.request)?;
        if !work.request.source.resource_owner.is_local() {
            return Ok(drained);
        }
        if let Some(watch) = &work.file.watch_id {
            self.close(&target, watch);
        }
        Ok(drained)
    }
    pub(crate) fn reconcile(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        key: FileObservationKey,
        reopen: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, KernelError> {
        let work = {
            let owner = catalog.lock().map_err(failed)?;
            let definition = owner.followup(&key.followup_id).map_err(failed)?;
            let file = definition
                .sources
                .get(key.source_index)
                .and_then(|s| s.file.as_ref())
                .ok_or_else(|| failed("file binding source missing"))?;
            if definition.generation != key.generation
                || file.receipt_id != key.receipt_id
                || file.revision != key.observation_revision
            {
                return Ok(json!({"accepted":false,"followup":definition}));
            }
            owner.followup_file_work(&key).map_err(failed)?
        };
        if work.release_required || work.paused {
            return Ok(
                json!({"accepted":false,"followup":catalog.lock().map_err(failed)?.followup(&key.followup_id).map_err(failed)?}),
            );
        }
        let target = if !work.request.source.resource_owner.is_local() {
            self.describe(&work.request)
        } else {
            self.request(|reply| Command::Describe {
                request: work.request.clone(),
                authorize: true,
                reply,
            })
        };
        let observed = match &target {
            Ok(target) => self.observe_target(
                &work.request,
                target,
                work.file.watch_id.clone(),
                work.file.position.clone(),
                reopen,
                work.file.current.clone(),
                work.file.ready,
                cancel,
            ),
            Err(KernelError::Authorization(message)) => {
                Err(KernelError::Authorization(message.clone()))
            }
            Err(error) => Err(failed(error)),
        };
        let update = match observed {
            Ok(p) => FileObservationUpdate {
                failure_code: p.state.is_none().then(|| "baseline_pending".into()),
                state: p.state,
                watch_id: p.watch_id,
                position: p.position,
                gap: p.gap,
                targeted_change: p.targeted_change,
                ready: p.ready,
            },
            Err(e) => {
                if cancel.is_cancelled() {
                    return Err(e);
                }
                FileObservationUpdate {
                    state: None,
                    watch_id: work.file.watch_id.clone(),
                    position: work.file.position.clone(),
                    gap: reopen,
                    targeted_change: false,
                    ready: false,
                    failure_code: Some(
                        if matches!(&e,KernelError::Authorization(message) if message=="file_observation_revoked")
                        {
                            "authority_revoked".into()
                        } else if let KernelError::FileObservationSource(code) = &e {
                            code.as_str().into()
                        } else {
                            crate::error::error_code(&e).into()
                        },
                    ),
                }
            }
        };
        let new_watch = update.watch_id.clone();
        let replaced = new_watch != work.file.watch_id;
        let mut guard = if replaced && work.request.source.resource_owner.is_local() {
            target
                .as_ref()
                .ok()
                .zip(new_watch.as_ref())
                .map(|(target, watch)| WatchGuard {
                    client: self,
                    target,
                    watch: watch.clone(),
                    close: true,
                })
        } else {
            None
        };
        let accepted = {
            let mut owner = catalog.lock().map_err(failed)?;
            owner
                .apply_file_observation(&work, update)
                .map_err(failed)?
        };
        if accepted {
            if let Some(guard) = guard.as_mut() {
                guard.close = false;
            }
        }
        if accepted && replaced && work.request.source.resource_owner.is_local() {
            if let (Ok(target), Some(old)) = (&target, &work.file.watch_id) {
                self.close(target, old);
            }
        }
        let followup = catalog
            .lock()
            .map_err(failed)?
            .followup(&key.followup_id)
            .map_err(failed)?;
        Ok(json!({"accepted":accepted,"followup":followup}))
    }
    pub(crate) fn pending_registrations(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        thread: &str,
        branch: &str,
        after: Option<String>,
    ) -> Result<Value, KernelError> {
        #[derive(Default, Serialize, Deserialize)]
        struct Cursor {
            local: Option<String>,
            pending: Option<String>,
            local_done: bool,
            pending_done: bool,
        }
        let mut cursor: Cursor = after
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let (mut requests, local) = if cursor.local_done {
            (Vec::new(), None)
        } else {
            self.request(|reply| Command::Acceptances {
                after: cursor.local.clone(),
                strict: true,
                followup_id: None,
                reply,
            })?
        };
        cursor.local_done = local.is_none();
        cursor.local = local;
        if !cursor.pending_done {
            let (pending, next) = catalog
                .lock()
                .map_err(failed)?
                .pending_file_registration_page(cursor.pending.as_deref())
                .map_err(failed)?;
            requests.extend(pending);
            cursor.pending_done = next.is_none();
            cursor.pending = next;
        }
        let next = if cursor.local_done && cursor.pending_done {
            None
        } else {
            Some(serde_json::to_string(&cursor)?)
        };
        let owner = catalog.lock().map_err(failed)?;
        if owner.branch_thread_id(branch).map_err(failed)? != thread {
            return Err(KernelError::Authorization(
                "pending registration scope changed".into(),
            ));
        }
        let mut registrations = std::collections::BTreeMap::<String, Value>::new();
        for request in requests {
            if owner
                .pending_user_file_registration(&request, thread, branch)
                .map_err(failed)?
            {
                let value=registrations.entry(request.followup_id.clone()).or_insert_with(||json!({"id":request.followup_id,"sourceRunId":request.source_run_id,"threadId":thread,"branchId":branch,"paths":[]}));
                let paths = value["paths"].as_array_mut().expect("paths");
                let path = json!(request.path);
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
        Ok(
            json!({"registrations":registrations.into_values().collect::<Vec<_>>(),"nextCursor":next}),
        )
    }
    pub(crate) fn cancel_registration(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        key: &str,
        run: &str,
    ) -> Result<Value, KernelError> {
        // A committed definition already supplies the original User authority.
        // Its ordinary cancellation must not wait on possibly damaged Storage receipts;
        // the existing files/release coordinator drains its sources afterward.
        let committed = {
            let mut owner = catalog.lock().map_err(failed)?;
            match owner.followup(key) {
                Ok(_) => Some(
                    owner
                        .cancel_user_followup_registration(key, run, &[])
                        .map_err(failed)?,
                ),
                Err(varin_runtime::RuntimeError::NotFound(_)) => None,
                Err(error) => return Err(failed(error)),
            }
        };
        if let Some(followup) = committed {
            return Ok(json!({"followup":followup}));
        }
        let mut requests = Vec::new();
        requests.extend(
            catalog
                .lock()
                .map_err(failed)?
                .pending_file_registration(key)
                .map_err(failed)?,
        );
        let mut after = None;
        loop {
            let (page, next) = self.request(|reply| Command::Acceptances {
                after,
                strict: true,
                followup_id: Some(key.into()),
                reply,
            })?;
            requests.extend(page);
            after = next;
            if after.is_none() {
                break;
            }
        }
        let followup = catalog
            .lock()
            .map_err(failed)?
            .cancel_user_followup_registration(key, run, &requests)
            .map_err(failed)?;
        // The durable fence precedes release. Later acceptances recheck this same fence
        // before opening/reading; completed workers retain their exact cleanup handles.
        for request in requests {
            let work = {
                let owner = catalog.lock().map_err(failed)?;
                match owner.followup(key) {
                    Ok(d) => d
                        .sources
                        .get(request.source_index)
                        .and_then(|s| s.file.as_ref())
                        .map(|file| FileObservationKey {
                            followup_id: key.into(),
                            generation: d.generation,
                            source_index: request.source_index,
                            receipt_id: file.receipt_id.clone(),
                            observation_revision: file.revision,
                        })
                        .map(|key| owner.followup_file_release_work(&key))
                        .transpose()
                        .map_err(failed)?,
                    Err(varin_runtime::RuntimeError::NotFound(_)) => None,
                    Err(error) => return Err(failed(error)),
                }
            };
            if let Some(work) = work {
                if self.release(&work)? {
                    catalog
                        .lock()
                        .map_err(failed)?
                        .confirm_file_observation_released(&work.key)
                        .map_err(failed)?;
                }
            } else {
                if self.release_request(&request)? {
                    self.close_registration_scope(&request)?;
                    catalog
                        .lock()
                        .map_err(failed)?
                        .confirm_pending_file_released(&request)
                        .map_err(failed)?;
                }
            }
        }
        Ok(json!({"followup":followup}))
    }
    pub(crate) fn release_pending(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        key: &FileObservationKey,
    ) -> Result<bool, KernelError> {
        let request = {
            let owner = catalog.lock().map_err(failed)?;
            let request = owner
                .pending_file_registration(&key.followup_id)
                .map_err(failed)?
                .into_iter()
                .find(|r| r.source_index == key.source_index && r.receipt_id() == key.receipt_id);
            let Some(request) = request else {
                return Ok(true);
            };
            if key.generation != 0
                || key.observation_revision != 0
                || !owner
                    .file_acceptance_may_release(&request)
                    .map_err(failed)?
            {
                return Err(failed("Original registration still requires its resource"));
            }
            request
        };
        let released = self.release_request(&request)?;
        if released {
            self.close_registration_scope(&request)?;
            catalog
                .lock()
                .map_err(failed)?
                .confirm_pending_file_released(&request)
                .map_err(failed)?;
        }
        Ok(released)
    }
    pub(crate) fn drain_bot_scope(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        suspension: &varin_runtime::catalog::bot::BotSuspension,
        cancel: &AtomicBool,
    ) -> Result<(), KernelError> {
        let mut local = Vec::new();
        let mut after = None;
        loop {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let (page, next) = self.request(|reply| Command::Acceptances {
                after,
                strict: true,
                followup_id: None,
                reply,
            })?;
            local.extend(page);
            after = next;
            if after.is_none() {
                break;
            }
        }
        let (works, pending) = catalog
            .lock()
            .map_err(failed)?
            .prepare_bot_file_release(suspension, &local)
            .map_err(failed)?;
        for work in works {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            if !self.release(&work)? {
                return Err(failed("Original Bot file reader has not drained"));
            }
            catalog
                .lock()
                .map_err(failed)?
                .confirm_file_observation_released(&work.key)
                .map_err(failed)?;
        }
        for request in pending {
            if cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            if !self.release_request(&request)? {
                return Err(failed("Original Bot file registration has not drained"));
            }
            self.close_registration_scope(&request)?;
            catalog
                .lock()
                .map_err(failed)?
                .confirm_pending_file_released(&request)
                .map_err(failed)?;
        }
        Ok(())
    }
    pub(crate) fn bindings(
        &self,
        catalog: &Arc<Mutex<Catalog>>,
        after: Option<&str>,
    ) -> Result<Value, KernelError> {
        #[derive(Default, Serialize, Deserialize)]
        struct Page {
            catalog_after: Option<String>,
            storage_after: Option<String>,
            catalog_done: bool,
            storage_done: bool,
            pending_after: Option<String>,
            pending_done: bool,
        }
        let mut page: Page = after
            .map(serde_json::from_str)
            .transpose()?
            .unwrap_or_default();
        let (works, next) = if page.catalog_done {
            (Vec::new(), None)
        } else {
            catalog
                .lock()
                .map_err(failed)?
                .followup_file_works(page.catalog_after.as_deref())
                .map_err(failed)?
        };
        page.catalog_done = next.is_none();
        page.catalog_after = next;
        // Cleanup only original accepted permissions whose real Agent call is now closed.
        // Unknown User request outcomes remain inert and may be retried with the same key.
        if !page.storage_done {
            match self.request(|reply| Command::Acceptances {
                after: page.storage_after.clone(),
                strict: false,
                followup_id: None,
                reply,
            }) {
                Ok((requests, next)) => {
                    page.storage_done = next.is_none();
                    page.storage_after = next;
                    for request in requests {
                        let release = catalog
                            .lock()
                            .map_err(failed)?
                            .file_acceptance_may_release(&request)
                            .unwrap_or(false);
                        if release {
                            let _: Result<bool, KernelError> =
                                self.request(|reply| Command::Release { request, reply });
                        }
                    }
                }
                Err(_) => page.storage_done = true,
            }
        }
        let mut bindings = Vec::new();
        if !page.pending_done {
            let (requests, next) = catalog
                .lock()
                .map_err(failed)?
                .pending_file_registration_page(page.pending_after.as_deref())
                .map_err(failed)?;
            page.pending_done = next.is_none();
            page.pending_after = next;
            for request in requests {
                if catalog
                    .lock()
                    .map_err(failed)?
                    .file_acceptance_may_release(&request)
                    .map_err(failed)?
                {
                    bindings.push(json!({"followupId":request.followup_id,"generation":0,"sourceIndex":request.source_index,
                        "receiptId":request.receipt_id(),"observationRevision":0,"definitionRevision":0,"target":Self::remote_target(&request),
                        "watchId":null,"position":null,"failureCode":null,"action":"release"}));
                }
            }
        }
        for mut work in works {
            let described = if !work.request.source.resource_owner.is_local() {
                self.describe(&work.request)
            } else {
                self.request(|reply| Command::Describe {
                    request: work.request.clone(),
                    authorize: !work.release_required,
                    reply,
                })
            };
            let revoked = matches!(&described,Err(KernelError::Authorization(message)) if message=="file_observation_revoked");
            let (target, failure) = match described {
                Ok(target) => (serde_json::to_value(target)?, Value::Null),
                Err(_) if revoked => (
                    self.describe(&work.request)
                        .ok()
                        .map(serde_json::to_value)
                        .transpose()?
                        .unwrap_or(Value::Null),
                    json!("authority_revoked"),
                ),
                Err(_) => (Value::Null, json!("receipt_unavailable")),
            };
            if failure != Value::Null && !work.release_required {
                let mut owner = catalog.lock().map_err(failed)?;
                let accepted = owner
                    .apply_file_observation(
                        &work,
                        FileObservationUpdate {
                            state: None,
                            watch_id: work.file.watch_id.clone(),
                            position: work.file.position.clone(),
                            gap: false,
                            targeted_change: false,
                            ready: false,
                            failure_code: failure.as_str().map(str::to_owned),
                        },
                    )
                    .unwrap_or(false);
                if accepted {
                    let definition = owner.followup(&work.key.followup_id).map_err(failed)?;
                    if let Some(file) = definition.sources[work.key.source_index].file.as_ref() {
                        let mut key = work.key.clone();
                        key.observation_revision = file.revision;
                        work = owner.followup_file_work(&key).map_err(failed)?;
                    }
                }
            }
            let mut value = serde_json::to_value(&work.key)?;
            value["definitionRevision"] = json!(work.definition_revision);
            value["target"] = target;
            value["failureCode"] = if failure.is_null() {
                json!(work.file.failure_code)
            } else {
                failure
            };
            value["watchId"] = json!(work.file.watch_id);
            value["position"] = json!(work.file.position);
            value["action"] = json!(if work.release_required {
                "release"
            } else if work.paused {
                "paused"
            } else {
                "observe"
            });
            bindings.push(value);
        }
        let next = if page.catalog_done && page.storage_done && page.pending_done {
            None
        } else {
            Some(serde_json::to_string(&page)?)
        };
        Ok(json!({"bindings":bindings,"nextCursor":next}))
    }
}
