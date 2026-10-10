//! Short process-domain intents use Storage's existing operation journal. Input
//! bodies, guardian waits and receipt-file I/O stay on the calling worker.
use super::*;
use crate::process::interaction::{self, Input, Receipt, Task};
use crate::tools::ToolBinding;
use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use varin_runtime::execution::{CancellationToken, ToolExecutionContext};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Address {
    pub workspace_id: String,
    pub process_id: String,
    pub operation_id: String,
    pub root_id: Option<String>,
}
#[derive(Clone)]
pub(crate) struct Context {
    pub grant_id: String,
    pub epoch: Option<String>,
    pub binding: Option<ToolBinding>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Native {
    pub context: ToolExecutionContext,
    pub executor: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Intent {
    pub address: Address,
    pub receipt: Receipt,
    pub digest: String,
    pub original_grant_id: String,
    pub current_grant_id: String,
    pub native: Option<Native>,
}
pub(crate) struct Read {
    pub intent: Intent,
    pub receipt: Option<Receipt>,
    pub path: PathBuf,
}
pub(crate) enum Admission {
    New { intent: Intent, task: Task },
    Existing(Read),
}
pub(crate) enum Command {
    Lookup {
        context: Context,
        address: Address,
        reply: mpsc::Sender<Result<Option<Read>, KernelError>>,
    },
    Prepare {
        context: Context,
        address: Address,
        input: Input,
        digest: String,
        native: Option<Native>,
        reply: mpsc::Sender<Result<Admission, KernelError>>,
    },
    /// Private Catalog-to-owner observation of an already admitted native intent.
    Recover {
        native: Native,
        address: Address,
        reply: mpsc::Sender<Result<Option<Read>, KernelError>>,
    },
    Finish {
        intent: Intent,
        receipt: Receipt,
        reply: mpsc::Sender<Result<(), KernelError>>,
    },
    Access {
        binding: ToolBinding,
        process_id: String,
        reply: mpsc::Sender<Result<Value, KernelError>>,
    },
}
#[derive(Debug)]
pub(crate) struct InvokeFailure {
    pub error: KernelError,
    pub dispatched: bool,
}
impl From<KernelError> for InvokeFailure {
    fn from(error: KernelError) -> Self {
        Self {
            error,
            dispatched: false,
        }
    }
}
type Watch = Arc<
    dyn Fn(
            &[String],
            &CancellationToken,
        ) -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, KernelError>
        + Send
        + Sync,
>;
#[derive(Clone)]
pub(crate) struct Client {
    send: Arc<dyn Fn(Command) -> Result<(), KernelError> + Send + Sync>,
    watch: Option<Watch>,
}
impl Client {
    pub(crate) fn new(
        send: impl Fn(Command) -> Result<(), KernelError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            send: Arc::new(send),
            watch: None,
        }
    }
    pub(crate) fn with_watch(
        mut self,
        watch: impl Fn(
                &[String],
                &CancellationToken,
            )
                -> Result<varin_runtime::execution_capacity::AdmissionControlGuard, KernelError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.watch = Some(Arc::new(watch));
        self
    }
    pub(crate) fn wire(
        &self,
        mut request: Value,
        cancel: CancellationToken,
    ) -> Result<Value, KernelError> {
        crate::protocol::reject_unknown_fields(
            &request,
            &["v", "kind", "id", "method", "params", "epoch", "grantId"],
            "process interaction",
        )?;
        if request["v"] != crate::protocol::PROTOCOL_VERSION
            || request["kind"] != "request"
            || request["id"].as_str().is_none_or(str::is_empty)
        {
            return Err(KernelError::Protocol(
                "invalid process interaction envelope".into(),
            ));
        }
        let method = request["method"].as_str().unwrap_or_default().to_string();
        let context = Context {
            grant_id: request["grantId"]
                .as_str()
                .ok_or_else(|| KernelError::Authorization("process grant required".into()))?
                .into(),
            epoch: Some(
                request["epoch"]
                    .as_str()
                    .ok_or_else(|| KernelError::Authorization("process epoch required".into()))?
                    .into(),
            ),
            binding: None,
        };
        let mut params = request["params"].take();
        crate::protocol::validate_method_params(&method, &params)?;
        let address = Address {
            workspace_id: params["workspaceId"].as_str().unwrap_or_default().into(),
            process_id: params["processId"].as_str().unwrap_or_default().into(),
            operation_id: params["operationId"].as_str().unwrap_or_default().into(),
            root_id: params["rootId"].as_str().map(str::to_owned),
        };
        if address.operation_id.is_empty() || address.process_id.is_empty() {
            return Err(KernelError::Protocol(
                "process interaction identity required".into(),
            ));
        }
        if method == "process.interaction.inspect" {
            return serde_json::to_value(self.inspect(context, address)?).map_err(Into::into);
        }
        if cancel.is_cancelled() {
            return Err(KernelError::Cancelled);
        }
        let receipt = self
            .invoke(
                context,
                address,
                move || {
                    if method == "process.write" {
                        let bytes = params["bytesBase64"].take();
                        let bytes =
                            BASE64
                                .decode(bytes.as_str().unwrap_or_default())
                                .map_err(|_| {
                                    KernelError::Protocol("stdin bytes are not valid base64".into())
                                })?;
                        Ok(Input::Write {
                            bytes: bytes.into(),
                            eof: params["eof"].as_bool().unwrap_or(false),
                        })
                    } else if method == "process.resize" {
                        let cols = u16::try_from(params["cols"].as_u64().unwrap_or(0))
                            .map_err(|_| KernelError::Protocol("invalid PTY columns".into()))?;
                        let rows = u16::try_from(params["rows"].as_u64().unwrap_or(0))
                            .map_err(|_| KernelError::Protocol("invalid PTY rows".into()))?;
                        Ok(Input::Resize { cols, rows })
                    } else {
                        Err(KernelError::Protocol(
                            "unknown process interaction method".into(),
                        ))
                    }
                },
                None,
                cancel,
            )
            .map_err(|failure| failure.error)?;
        serde_json::to_value(receipt).map_err(Into::into)
    }
    fn lookup(&self, context: Context, address: Address) -> Result<Option<Read>, KernelError> {
        let (reply, receive) = mpsc::channel();
        (self.send)(Command::Lookup {
            context,
            address,
            reply,
        })?;
        receive
            .recv()
            .map_err(|_| KernelError::Storage("process receipt owner stopped".into()))?
    }
    fn finish(&self, intent: Intent, receipt: Receipt) -> Result<(), KernelError> {
        let (reply, receive) = mpsc::channel();
        (self.send)(Command::Finish {
            intent,
            receipt,
            reply,
        })?;
        receive
            .recv()
            .map_err(|_| KernelError::Storage("process receipt owner stopped".into()))?
    }
    fn read(&self, read: Read) -> Result<Receipt, KernelError> {
        if let Some(receipt) = &read.receipt {
            if receipt.identity().state != interaction::State::Unknown {
                return Ok(receipt.clone());
            }
        }
        if let Some(receipt) = interaction::read(&read.path, &read.intent.receipt)? {
            self.finish(read.intent, receipt.clone())?;
            return Ok(receipt);
        }
        Ok(read.receipt.unwrap_or(read.intent.receipt))
    }
    pub(crate) fn inspect(
        &self,
        context: Context,
        address: Address,
    ) -> Result<Option<Receipt>, KernelError> {
        self.lookup(context, address)?
            .map(|read| self.read(read))
            .transpose()
    }
    pub(crate) fn reconcile(
        &self,
        native: Native,
        address: Address,
    ) -> Result<Option<(Intent, Receipt)>, KernelError> {
        let (reply, receive) = mpsc::channel();
        (self.send)(Command::Recover {
            native,
            address,
            reply,
        })?;
        let Some(read) = receive
            .recv()
            .map_err(|_| KernelError::Storage("process recovery owner stopped".into()))??
        else {
            return Ok(None);
        };
        let receipt = match read.receipt {
            Some(receipt) if receipt.identity().state != interaction::State::Unknown => {
                Some(receipt)
            }
            prior => interaction::read(&read.path, &read.intent.receipt)?.or(prior),
        };
        if let Some(receipt) = receipt {
            self.finish(read.intent.clone(), receipt.clone())?;
            Ok(Some((read.intent, receipt)))
        } else {
            Ok(None)
        }
    }
    pub(crate) fn access(
        &self,
        binding: ToolBinding,
        process_id: String,
    ) -> Result<Value, KernelError> {
        let (reply, receive) = mpsc::channel();
        (self.send)(Command::Access {
            binding,
            process_id,
            reply,
        })?;
        receive
            .recv()
            .map_err(|_| KernelError::Storage("process access owner stopped".into()))?
    }
    /// The callback prepares a new body only after the original receipt lookup.
    pub(crate) fn invoke(
        &self,
        context: Context,
        address: Address,
        prepare: impl FnOnce() -> Result<Input, KernelError>,
        native: Option<Native>,
        cancel: CancellationToken,
    ) -> Result<Receipt, InvokeFailure> {
        let prior = self.lookup(context.clone(), address.clone())?;
        // A supplied duplicate body is checked outside Storage; receipt-only retries use inspect.
        let input = prepare()?;
        let digest = input.digest();
        if let Some(prior) = prior {
            if prior.intent.digest != digest {
                return Err(KernelError::Operation(
                    "process interaction identity reused with different input".into(),
                )
                .into());
            }
            return self.read(prior).map_err(|error| InvokeFailure {
                error,
                dispatched: true,
            });
        }
        let (reply, receive) = mpsc::channel();
        (self.send)(Command::Prepare {
            context,
            address,
            input: input.clone(),
            digest,
            native,
            reply,
        })?;
        let admission = receive
            .recv()
            .map_err(|_| KernelError::Storage("process input owner stopped".into()))??;
        let (intent, task) = match admission {
            Admission::Existing(read) => {
                return self.read(read).map_err(|error| InvokeFailure {
                    error,
                    dispatched: true,
                })
            }
            Admission::New { intent, task } => (intent, task),
        };
        let guard = match self
            .watch
            .as_ref()
            .map(|watch| {
                watch(
                    &[
                        intent.current_grant_id.clone(),
                        intent.original_grant_id.clone(),
                    ],
                    &cancel,
                )
            })
            .transpose()
        {
            Ok(guard) => guard,
            Err(error) => {
                let receipt = intent.receipt.no_effect(
                    format!("input control registration failed before dispatch: {error}"),
                    cancel.is_cancelled(),
                );
                interaction::persist(&task.receipt_path, &receipt).map_err(|error| {
                    InvokeFailure {
                        error,
                        dispatched: true,
                    }
                })?;
                self.finish(intent, receipt.clone())
                    .map_err(|error| InvokeFailure {
                        error,
                        dispatched: true,
                    })?;
                return Ok(receipt);
            }
        };
        let (observed, result) = mpsc::channel();
        let client = self.clone();
        let initial = intent.clone();
        let receipt_path = task.receipt_path.clone();
        let spawned = std::thread::Builder::new()
            .name("process-input".into())
            .spawn(move || {
                let _guard = guard;
                let mut observed = Some(observed);
                task.run(input, cancel, |receipt, final_receipt| {
                    let result = if final_receipt {
                        client
                            .finish(intent.clone(), receipt.clone())
                            .map(|_| receipt)
                    } else {
                        Ok(receipt)
                    };
                    if let Some(sender) = observed.take() {
                        let _ = sender.send(result);
                    }
                });
            });
        if let Err(error) = spawned {
            let receipt = initial.receipt.no_effect(
                format!("process input worker could not start: {error}"),
                false,
            );
            interaction::persist(&receipt_path, &receipt).map_err(|error| InvokeFailure {
                error,
                dispatched: true,
            })?;
            self.finish(initial, receipt.clone())
                .map_err(|error| InvokeFailure {
                    error,
                    dispatched: true,
                })?;
            return Ok(receipt);
        }
        result
            .recv()
            .map_err(|_| InvokeFailure {
                error: KernelError::Storage(
                    "process input worker stopped without a receipt".into(),
                ),
                dispatched: true,
            })?
            .map_err(|error| InvokeFailure {
                error,
                dispatched: true,
            })
    }
}
impl Storage {
    fn interaction_context(
        &self,
        context: &Context,
        epoch: &str,
        host_id: &str,
        host_generation: &str,
        address: &Address,
    ) -> Result<Grant, KernelError> {
        if context.epoch.as_deref().is_some_and(|given| given != epoch) {
            return Err(KernelError::Authorization(
                "stale process interaction epoch".into(),
            ));
        }
        let params = json!({"workspaceId":address.workspace_id,"processId":address.process_id,"operationId":address.operation_id,"rootId":address.root_id});
        let (grant, _) = self.authorize(
            Some(&context.grant_id),
            epoch,
            host_id,
            host_generation,
            "process.interaction.inspect",
            &params,
        )?;
        if let Some(binding) = &context.binding {
            if grant.run_id.as_deref() != Some(binding.run_id.as_str())
                || grant.thread_id.as_deref() != Some(binding.thread_id.as_str())
                || grant.owning_workspace.as_deref() != Some(binding.workspace_id.as_str())
                || grant.execution_workspace.as_deref()
                    != Some(binding.execution_workspace_id.as_str())
                || binding.root_id != address.root_id
                || binding.workspace_id != address.workspace_id
            {
                return Err(KernelError::Authorization(
                    "process interaction binding changed".into(),
                ));
            }
            if let Some(root) = &binding.live_root {
                self.validate_live_root(root, &grant, host_id)?;
            }
        }
        Ok(grant)
    }
    fn interaction_lookup(
        &mut self,
        address: &Address,
        grant: &Grant,
    ) -> Result<Option<Read>, KernelError> {
        self.authorize_process_access(
            &address.process_id,
            &address.workspace_id,
            grant,
            address.root_id.as_deref(),
            false,
        )?;
        self.interaction_record(address)
    }
    fn interaction_record(&mut self, address: &Address) -> Result<Option<Read>, KernelError> {
        let row = self.operation_get(&json!({"operationId":address.operation_id}))?;
        if row.is_null() {
            return Ok(None);
        }
        let mut intent: Intent =
            serde_json::from_value(row["result"]["intent"].clone()).map_err(|_| {
                KernelError::Authorization("operation is not a process interaction".into())
            })?;
        if intent.address.process_id != address.process_id
            || intent.address.workspace_id != address.workspace_id
            || intent.receipt.identity().operation_id != address.operation_id
            || !matches!(
                row["kind"].as_str(),
                Some("process.write" | "process.resize")
            )
        {
            return Err(KernelError::Authorization(
                "process interaction belongs to another process".into(),
            ));
        }
        let receipt = row["result"]
            .get("receipt")
            .filter(|v| !v.is_null())
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()?;
        if receipt.is_none() {
            if let Some(progress) = self
                .processes
                .interaction_progress(&address.process_id, &address.operation_id)
            {
                intent.receipt = progress;
            }
        }
        Ok(Some(Read {
            path: interaction::path(
                &crate::process::receipt_path(&self.root, &address.process_id),
                &address.operation_id,
            ),
            intent,
            receipt,
        }))
    }
    fn interaction_prepare(
        &mut self,
        address: Address,
        input: Input,
        digest: String,
        native: Option<Native>,
        grant: &Grant,
    ) -> Result<Admission, KernelError> {
        if let Some(prior) = self.interaction_lookup(&address, grant)? {
            if prior.intent.digest != digest {
                return Err(KernelError::Operation(
                    "process interaction identity reused with different input".into(),
                ));
            }
            return Ok(Admission::Existing(prior));
        }
        let (record, original) = self.authorize_process_access(
            &address.process_id,
            &address.workspace_id,
            grant,
            address.root_id.as_deref(),
            true,
        )?;
        if record["writerActive"] != true {
            return Err(KernelError::Operation("process has already stopped".into()));
        }
        match &input {
            Input::Write{eof:true,..} if record["mode"]=="pty"=>return Err(KernelError::Operation("PTY input does not support pipe EOF; write the intended control character explicitly".into())),
            Input::Resize{cols,rows} if record["mode"]!="pty"||*cols==0||*rows==0=>return Err(KernelError::Operation("resize requires a PTY and valid dimensions".into())),_=>()
        }
        if let Some(native) = &native {
            if grant.run_id.as_deref() != Some(native.context.run_id.as_str())
                || native.context.operation_id != address.operation_id
            {
                return Err(KernelError::Authorization(
                    "native process interaction identity changed".into(),
                ));
            }
        }
        let task = self.processes.reserve_interaction(
            &address.process_id,
            &address.operation_id,
            &grant.kernel_epoch,
            &input,
            &self.root,
        )?;
        let intent = Intent {
            address,
            receipt: task.seed.clone(),
            digest,
            original_grant_id: original,
            current_grant_id: grant.grant_id.clone(),
            native,
        };
        let short = serde_json::to_string(&json!({"intent":intent}))?;
        let params_hash = hash_json(&json!([
            intent.address.process_id,
            intent.digest,
            intent.receipt.method()
        ]))?;
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.operation_begin(
                &intent.address.operation_id,
                intent.receipt.method(),
                &params_hash,
            )?;
            self.record_operation_workspace(
                &intent.address.operation_id,
                Some(&intent.address.workspace_id),
            )?;
            self.conn.execute(
                "UPDATE operations SET result_json=?2 WHERE operation_id=?1",
                params![intent.address.operation_id, short],
            )?;
            self.conn.execute_batch("COMMIT")?;
            Ok::<_, KernelError>(())
        })();
        if let Err(error) = result {
            self.conn.execute_batch("ROLLBACK").ok();
            return Err(error);
        }
        Ok(Admission::New { intent, task })
    }
    pub(crate) fn serve_interaction(
        &mut self,
        command: Command,
        epoch: &str,
        host_id: &str,
        host_generation: &str,
    ) -> Option<(Intent, Receipt)> {
        match command {
            Command::Lookup {
                context,
                address,
                reply,
            } => {
                let result = self
                    .interaction_context(&context, epoch, host_id, host_generation, &address)
                    .and_then(|grant| self.interaction_lookup(&address, &grant));
                let _ = reply.send(result);
            }
            Command::Prepare {
                context,
                address,
                input,
                digest,
                native,
                reply,
            } => {
                let result = self
                    .interaction_context(&context, epoch, host_id, host_generation, &address)
                    .and_then(|grant| {
                        self.interaction_prepare(address, input, digest, native, &grant)
                    });
                let _ = reply.send(result);
            }
            Command::Recover {
                native,
                address,
                reply,
            } => {
                let result = (|| {
                    let Some(read) = self.interaction_record(&address)? else {
                        return Ok(None);
                    };
                    let saved = read.intent.native.as_ref().ok_or_else(|| {
                        KernelError::Authorization(
                            "process receipt has no original native invocation".into(),
                        )
                    })?;
                    if saved != &native
                        || native.context.operation_id != address.operation_id
                        || read.intent.address.root_id != address.root_id
                    {
                        return Err(KernelError::Authorization(
                            "process recovery differs from its original native intent/root".into(),
                        ));
                    }
                    let actor: String = self.conn.query_row(
                        "SELECT grant_id FROM process_records WHERE process_id=?1",
                        [&address.process_id],
                        |row| row.get(0),
                    )?;
                    let original = self.load_grant(&actor)?;
                    if actor != read.intent.original_grant_id
                        || original.run_id.as_deref() != Some(native.context.run_id.as_str())
                        || original.owning_workspace.as_deref()
                            != Some(address.workspace_id.as_str())
                    {
                        return Err(KernelError::Authorization(
                            "process recovery original actor changed".into(),
                        ));
                    }
                    // Revocation remains authoritative for input/output access. Reading this
                    // original short effect receipt neither exercises nor restores that grant.
                    Ok(Some(read))
                })();
                let _ = reply.send(result);
            }
            Command::Finish {
                intent,
                receipt,
                reply,
            } => {
                let result = (|| {
                    if !receipt.follows(&intent.receipt) {
                        return Err(KernelError::Authorization(
                            "interaction receipt changed identity".into(),
                        ));
                    }
                    let prior =
                        self.operation_get(&json!({"operationId":intent.address.operation_id}))?;
                    let stored: Intent = serde_json::from_value(prior["result"]["intent"].clone())?;
                    if stored.digest != intent.digest || !stored.receipt.same_intent(&receipt) {
                        return Err(KernelError::Authorization(
                            "interaction intent changed".into(),
                        ));
                    }
                    if let Some(existing) = prior["result"].get("receipt").filter(|v| !v.is_null())
                    {
                        let existing: Receipt = serde_json::from_value(existing.clone())?;
                        if !receipt.follows(&existing)
                            || (existing.identity().state != interaction::State::Unknown
                                && existing != receipt)
                        {
                            return Err(KernelError::Storage(
                                "conflicting final process interaction receipt".into(),
                            ));
                        }
                    }
                    self.operation_finish(
                        &intent.address.operation_id,
                        &json!({"intent":intent,"receipt":receipt}),
                    )
                })();
                let completed = result.is_ok();
                let _ = reply.send(result);
                if completed {
                    return Some((intent, receipt));
                }
            }
            Command::Access {
                binding,
                process_id,
                reply,
            } => {
                let address = Address {
                    workspace_id: binding.workspace_id.clone(),
                    process_id: process_id.clone(),
                    operation_id: process_id.clone(),
                    root_id: binding.root_id.clone(),
                };
                let context = Context {
                    grant_id: binding.grant_id.clone(),
                    epoch: None,
                    binding: Some(binding),
                };
                let result = self
                    .interaction_context(&context, epoch, host_id, host_generation, &address)
                    .and_then(|grant| {
                        self.authorize_process_access(
                            &process_id,
                            &address.workspace_id,
                            &grant,
                            address.root_id.as_deref(),
                            false,
                        )?;
                        self.refresh_process_record(&process_id)?
                            .ok_or_else(|| KernelError::Operation("process not found".into()))
                    });
                let _ = reply.send(result);
            }
        }
        None
    }
}
