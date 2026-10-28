//! Program identities prepared by the actual execution Host, before model command generation.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use varin_runtime::execution::ExecutionError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionShell {
    pub id: String,
    pub name: String,
    pub executable: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionEnvironment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_path: Option<String>,
    pub platform: String,
    pub default_shell: Option<String>,
    pub shells: Vec<ExecutionShell>,
}
impl ExecutionEnvironment {
    pub(crate) fn program_shell(&self, command:&str) -> Option<&ExecutionShell> {
        fn stem(name:&str)->&str {name.rsplit_once('.').filter(|(_,extension)|extension.eq_ignore_ascii_case("exe")).map_or(name,|(base,_)|base)}
        if command.contains(['/', '\\', ':']) {return None;}
        self.shells.iter().find(|shell| {
            let name=std::path::Path::new(&shell.executable).file_name().and_then(|name|name.to_str()).unwrap_or(&shell.id);
            if self.platform=="win32" {
                stem(command).eq_ignore_ascii_case(&shell.id) || stem(name).eq_ignore_ascii_case(stem(command))
            } else {command==shell.id || command==name}
        })
    }
    pub(crate) fn select(
        &self,
        requested: Option<&str>,
        local: bool,
    ) -> Result<&ExecutionShell, ExecutionError> {
        let id = requested
            .filter(|id| *id != "auto")
            .or(self.default_shell.as_deref());
        let selected = self
            .shells
            .iter()
            .find(|shell| Some(shell.id.as_str()) == id);
        if let Some(shell) = selected {
            if !local || std::fs::metadata(&shell.executable).is_ok_and(|file| file.is_file()) {
                return Ok(shell);
            }
        }
        Err(ExecutionError::new("shell_unavailable", "The selected shell is unavailable on the execution Host. Select an available shell or refresh execution settings.")
            .with_details(json!({"requestedShell":id,"availableShells":self.shells.iter().filter(|shell| !local || std::fs::metadata(&shell.executable).is_ok_and(|file|file.is_file())).map(|shell|&shell.id).collect::<Vec<_>>()})))
    }
    pub(crate) fn context(&self) -> String {
        let selected = self
            .shells
            .iter()
            .find(|shell| Some(&shell.id) == self.default_shell.as_ref());
        let default = selected
            .map(|shell| format!("{} ({})", shell.name, shell.executable))
            .unwrap_or_else(|| {
                format!(
                    "{} (unavailable)",
                    self.default_shell.as_deref().unwrap_or("none")
                )
            });
        let mut text = format!(
            "Execution Host: {}\nDefault command shell: {default}\nAvailable process_spawn.shell values: {}. shellCommand uses this default; command + args starts a program directly.",
            self.platform,
            self.shells
                .iter()
                .map(|shell| shell.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );
        if self.platform == "win32" && self.default_shell.as_deref() == Some("powershell") {
            text.push_str("\nWindows PowerShell aliases curl to Invoke-WebRequest; use curl.exe for curl flags.");
        }
        text
    }
}
impl ExecutionShell {
    pub(crate) fn arguments(&self, script: &Value) -> Result<Value, ExecutionError> {
        let prefix: &[&str] = match self.id.as_str() {
            "bash" => &["--noprofile", "--norc", "-c"],
            "zsh" => &["-f", "-c"],
            "pwsh" | "powershell" => &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"],
            "cmd" => &["/d", "/s", "/c"],
            "nu" => &["--no-config-file", "-c"],
            "fish" => &["--no-config", "-c"],
            "sh" | "dash" | "ksh" => &["-c"],
            _ => {
                return Err(ExecutionError::new(
                    "shell_unavailable",
                    "This shell has no supported command invocation. Use command and args for a custom interpreter.",
                ));
            }
        };
        Ok(Value::Array(
            prefix
                .iter()
                .map(|arg| json!(arg))
                .chain(std::iter::once(script.clone()))
                .collect(),
        ))
    }
}

pub(crate) struct ExecutionPreparation {
    pub inner: std::sync::Arc<dyn varin_runtime::execution::ContextPreparation>,
    pub environment: Option<ExecutionEnvironment>,
    pub bridge: crate::host_query::OwnerChannel,
}
impl varin_runtime::execution::ContextPreparation for ExecutionPreparation {
    fn prepare_binding(
        &self,
        run_id: &str,
        epoch: u64,
        binding: &mut varin_runtime::execution::RequestBinding,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<varin_runtime::execution::ConversationHistory, ExecutionError> {
        use sha2::{Digest, Sha256};
        use varin_runtime::execution::*;
        let mut history = self.inner.prepare_binding(run_id, epoch, binding, cancel)?;
        if binding
            .tools
            .iter()
            .any(|tool| tool.name == "process_spawn")
        {
            let reply = self.bridge.query(
                json!({"action":"execution_environment","runId":run_id}),
                cancel,
            )?;
            // Standalone clients can supply a complete trusted binding without a
            // context policy service. Production's service refreshes it per request.
            if reply["status"] != "ready"
                && !(reply["code"] == "context_owner_unavailable" && self.environment.is_some())
            {
                return Err(ExecutionError::new(
                    "execution_environment",
                    "Execution Host environment preparation is unavailable",
                ));
            }
            let environment: Option<ExecutionEnvironment> = reply
                .get("environment")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| ExecutionError::new("execution_environment", error.to_string()))?
                .or_else(|| self.environment.clone());
            if let Some(environment) = environment {
                binding.execution_environment = Some(json!(environment));
                let text = environment.context();
                let identity = hex::encode(Sha256::digest(text.as_bytes()));
                history.push(
                    ConversationItem {
                        id: format!("execution-environment:{identity}"),
                        resource_activation: None,
                        provenance: Provenance::SystemInstruction {
                            source: "execution_host".into(),
                        },
                        content: Content::Text { text },
                        opaque: None,
                    }
                    .into(),
                );
            }
        }
        Ok(history)
    }
    fn prepare(
        &self,
        run_id: &str,
        epoch: u64,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<(), ExecutionError> {
        self.inner.prepare(run_id, epoch, cancel)
    }
    fn prepare_request(
        &self,
        epoch: u64,
        view: &varin_runtime::execution::RequestView,
        body: &varin_runtime::execution::RequestBody,
        protocol: Option<varin_runtime::context_capacity::RequestBudgetProtocol>,
        preview: &dyn Fn(
            varin_runtime::execution::ContextProjection,
        )
            -> Result<varin_runtime::context_capacity::InputEstimate, ExecutionError>,
        cancel: &varin_runtime::execution::CancellationToken,
    ) -> Result<varin_runtime::execution::ContextRequestPreparation, ExecutionError> {
        self.inner
            .prepare_request(epoch, view, body, protocol, preview, cancel)
    }
}
