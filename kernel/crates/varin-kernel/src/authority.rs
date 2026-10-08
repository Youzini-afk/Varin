use crate::error::KernelError;
use crate::model::Grant;

pub(crate) fn required_capability(method: &str) -> &'static str {
    match method {
        "compute.grammar.register" => "compute.grammar",
        method if method.starts_with("compute.") => "storage.read",
        method if method.starts_with("process.") => "process",
        "storage.health"
        | "storage.snapshot"
        | "storage.getBlob"
        | "branch.read"
        | "branch.diff"
        | "pin.read"
        | "operation.get"
        | "storage.record.get"
        | "storage.record.list"
        | "working.result.get"
        | "working.result.list"
        | "working.draft.get"
        | "working.draft.list"
        | "working.verification.list"
        | "working.review.list"
        | "file.scan"
        | "file.read"
        | "file.measure"
        | "file.operation.list" => "storage.read",
        "storage.putBlob.begin"
        | "storage.putBlob.finish"
        | "storage.putBlob.abort"
        | "storage.blob.release"
        | "storage.putBlob.chunk"
        | "branch.create.begin"
        | "branch.create.append"
        | "branch.create.finish"
        | "branch.create.abort"
        | "branch.write.begin"
        | "branch.write.append"
        | "branch.write.finish"
        | "branch.write.abort"
        | "branch.publish"
        | "branch.pin"
        | "branch.unpin"
        | "branch.delete"
        | "operation.release"
        | "file.root.register"
        | "file.operation.reconcile"
        | "file.lease.acquire"
        | "file.lease.check"
        | "file.lease.release"
        | "file.capture"
        | "file.captureBatch"
        | "file.apply"
        | "file.mkdir"
        | "file.remove"
        | "file.rename"
        | "file.materialize"
        | "storage.record.put"
        | "storage.record.release"
        | "working.result.put"
        | "working.result.release"
        | "working.draft.put"
        | "working.draft.release"
        | "working.verification.put"
        | "working.verification.release"
        | "working.review.put"
        | "working.review.release" => "storage.write",
        "storage.record.workspaces"
        | "branch.objects" => "storage.maintenance",
        "storage.gc" => "storage.gc",
        "storage.object.rebindOwner"
        | "recovery.operation.get"
        | "recovery.turn.start"
        | "recovery.turn.get"
        | "recovery.turn.settle"
        | "recovery.checkpoint.create"
        | "recovery.checkpoint.list"
        | "recovery.entry.resolve"
        | "recovery.change.before"
        | "recovery.change.get"
        | "recovery.change.list"
        | "recovery.change.after"
        | "recovery.operation.create"
        | "recovery.operation.file.cas"
        | "recovery.operation.complete"
        | "recovery.operation.list"
        | "recovery.operation.release" => "recovery",
        _ => "storage.read",
    }
}

pub(crate) fn require_capability(grant: &Grant, method: &str) -> Result<(), KernelError> {
    let required = required_capability(method);
    if grant.capabilities.contains(required) || grant.capabilities.contains("storage.admin") {
        return Ok(());
    }
    Err(KernelError::Authorization(format!(
        "grant lacks capability: {required}"
    )))
}

pub(crate) fn path_allowed(grant: &Grant, path: &str) -> bool {
    path_allowed_scopes(&grant.path_scopes, path)
}

pub(crate) fn path_allowed_scopes(scopes: &[String], path: &str) -> bool {
    scopes
        .iter()
        .any(|scope| scope.is_empty() || path == scope || path.starts_with(&format!("{scope}/")))
}
