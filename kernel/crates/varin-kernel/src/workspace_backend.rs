//! Lightweight qualification of the actual resource Host. No probe workspace,
//! source capture, component installation or mode substitution belongs here.
use crate::error::KernelError;
use serde_json::{json, Value};
use varin_runtime::execution::ExecutionError;

pub(crate) fn backend() -> &'static str {
    if cfg!(windows) {
        "winfsp"
    } else if cfg!(target_os = "macos") {
        "macfuse"
    } else {
        "fuse"
    }
}
pub(crate) fn help_url() -> &'static str {
    if cfg!(windows) {
        "https://winfsp.dev/rel/"
    } else if cfg!(target_os = "macos") {
        "https://macfuse.github.io/"
    } else {
        "https://github.com/libfuse/libfuse"
    }
}
pub(crate) fn unavailable(reason: &str, message: impl Into<String>) -> KernelError {
    KernelError::Execution(ExecutionError::new("workspace_backend_unavailable", message).with_details(json!({
        "stage":"workspace_preflight", "platform":std::env::consts::OS,
        "architecture":std::env::consts::ARCH, "backend":backend(), "reason":reason, "helpUrl":help_url()
    })))
}
pub(crate) fn require() -> Result<(), KernelError> {
    #[cfg(feature = "workspace-mount")]
    {
        crate::workspace_mount::dependencies()
    }
    #[cfg(not(feature = "workspace-mount"))]
    {
        Err(unavailable(
            "backend_not_compiled",
            "This execution Host was built without native workspace mount support",
        ))
    }
}
pub(crate) fn require_isolation(host_id: &str) -> Result<(), KernelError> {
    require().map_err(|error| {
        let mut failure: ExecutionError = error.into();
        let details = failure.details.get_or_insert_with(|| json!({}));
        details["hostId"] = json!(host_id);
        details["workMode"] = json!("isolated_write");
        details["executionStarted"] = json!(false);
        failure.message = format!("Cannot create an independent workspace on execution Host {host_id}: {}. The child has not started. Resolve the Host component or permission issue and retry; if shared file changes suit the task, dispatch again with workMode=shared. Help: {}", failure.message, help_url());
        KernelError::Execution(failure)
    })
}
pub(crate) fn inspect() -> Value {
    let result = require();
    let error = result.err().map(ExecutionError::from);
    let mut value=json!({"backend":backend(), "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "mountCompiled":cfg!(feature="workspace-mount"),"dependenciesReady":error.is_none(),
        "detail":error.as_ref().map(|error|&error.message),"reason":error.as_ref().and_then(|error|error.details.as_ref()).and_then(|details|details.get("reason")),
        "helpUrl":help_url()});
    #[cfg(all(target_os="macos",feature="workspace-mount"))]
    { let facts=crate::workspace_mount::macos::facts();if facts["ready"]==true{value["backend"]=json!("fskit");}
      value["builtInExtension"]=facts;value["canOpenSettings"]=json!(crate::workspace_mount::macos::helper().is_ok_and(|p|p.is_file())); }
    value
}
