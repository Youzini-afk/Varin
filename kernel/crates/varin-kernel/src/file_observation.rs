//! Private file observer adapter: original Catalog binding, Host root watcher and
//! Storage single-path read. Work runs outside both control owners.
use crate::storage::file_observations::{ReadTask, Snapshot, Target};
use crate::{error::KernelError, host_query::OwnerChannel, storage::Storage, tools::ToolBinding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;
use std::sync::{mpsc, Arc, Mutex};
use varin_runtime::{catalog::followups::*, execution::CancellationToken, Catalog};

pub(crate) enum Command {
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
                let _: Result<bool, KernelError> = self.client.request(|reply| Command::Release {
                    request: request.clone(),
                    reply,
                });
            }
            if !referenced {
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
    pub(crate) fn new(
        send: impl Fn(Command) -> Result<(), KernelError> + Send + Sync + 'static,
        bridge: OwnerChannel,
    ) -> Self {
        Self {
            send: Arc::new(send),
            bridge,
        }
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
        cancel: &CancellationToken,
    ) -> Result<PreparedFileObservation, KernelError> {
        if target.immutable {
            let snapshot = self.read(r, cancel)?;
            return Ok(PreparedFileObservation {
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
        grant_id: &str,
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
        let mut prepared = Vec::new();
        for request in p.file_requests().map_err(failed)? {
            let authorization = {
                let owner = catalog.lock().map_err(failed)?;
                owner.authorize_followup_registration(p)
            };
            authorization.map_err(failed)?;
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
            let observed =
                self.observe_target(&request, &target, watch, position, false, cancel)?;
            prepared.push(observed);
        }
        p.bind_file_observations(prepared).map_err(failed)?;
        Ok(guard)
    }
    pub(crate) fn release(&self, work: &FileObservationWork) -> Result<bool, KernelError> {
        if !work.release_required {
            return Err(failed("Catalog still requires this file observation"));
        }
        let target = self.describe(&work.request)?;
        let drained = self.request(|reply| Command::Release {
            request: work.request.clone(),
            reply,
        })?;
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
        let target = self.request(|reply| Command::Describe {
            request: work.request.clone(),
            authorize: true,
            reply,
        });
        let observed = match &target {
            Ok(target) => self.observe_target(
                &work.request,
                target,
                work.file.watch_id.clone(),
                work.file.position.clone(),
                reopen,
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
        let mut guard = if replaced {
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
        if accepted && replaced {
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
        let (requests, next) = self.request(|reply| Command::Acceptances {
            after,
            strict: true,
            followup_id: None,
            reply,
        })?;
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
                let _: bool = self.request(|reply| Command::Release { request, reply })?;
            }
        }
        Ok(json!({"followup":followup}))
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
        for mut work in works {
            let described = self.request(|reply| Command::Describe {
                request: work.request.clone(),
                authorize: !work.release_required,
                reply,
            });
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
            value["failureCode"] = failure;
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
        let next = if page.catalog_done && page.storage_done {
            None
        } else {
            Some(serde_json::to_string(&page)?)
        };
        Ok(json!({"bindings":bindings,"nextCursor":next}))
    }
}
