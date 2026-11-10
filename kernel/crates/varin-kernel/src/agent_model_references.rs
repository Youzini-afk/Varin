//! Private Application Host access to the same Catalog reference index. This
//! channel does not expose an alias writer to renderers or extension processes.
use super::*;

pub(super) fn execute(runtime: Arc<RunSupervisor>, method: &str, params: Value) -> Result<Value, KernelError> {
    if method == "runtime.model_reference.file_state" {
        let p: ModelReferenceFileStateParams = serde_json::from_value(params)?;
        let namespace = if p.source.mode == varin_runtime::SourceMode::FixedBranch {
            format!("fixed:{}:{}@{}", p.source.workspace_id,
                p.source.branch_id.0.as_deref().ok_or_else(|| KernelError::Protocol("Fixed file source has no branch".into()))?,
                p.source.revision.0.ok_or_else(|| KernelError::Protocol("Fixed file source has no revision".into()))?)
        } else {
            p.root_id.and_then(|root| root.0).or_else(||p.read_version.as_ref().map(|_|String::new())).ok_or_else(|| KernelError::Protocol("Physical file source has no original root".into()))?
        };
        let state: varin_runtime::catalog::followups::FileState = serde_json::from_value(serde_json::to_value(p.state)?)?;
        let version = match p.read_version { Some(version) => version, None => crate::storage::file_mutations::read_version(&namespace, &p.path, &state)? };
        if p.expected_read_version.and_then(|version| version.0).as_deref().is_some_and(|expected| crate::storage::file_mutations::read_basis(expected).0 != version) {
            return Err(KernelError::Operation("The file changed after it was read; read its path again to select the new version".into()));
        }
        return Ok(json!({"readVersion":version}));
    }
    let catalog = runtime.catalog();
    let mut db = catalog.lock().map_err(|_| KernelError::Storage("Catalog owner failed".into()))?;
    match method {
        "runtime.model_reference.agent_source" => {
            let p: ModelAgentSourceParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(db.agent_source(&p.run_id, &p.identity).map_err(domain)?)?)
        }
        "runtime.model_reference.register" => {
            let p: ModelReferenceRegisterParams = serde_json::from_value(params)?;
            // Retention follows a real operation or Run, never a new Host lifetime.
            if db.operation(&p.holder).is_err() { db.run(&p.holder).map_err(domain)?; }
            // Source-owner keys use the native enum serializer, not the Host's
            // JSON property order (notably managed Host resource owners).
            let owner = if matches!(p.kind, varin_runtime::catalog::model_references::ReferenceKind::File | varin_runtime::catalog::model_references::ReferenceKind::Script | varin_runtime::catalog::model_references::ReferenceKind::Process) {
                match serde_json::from_str::<varin_runtime::catalog::launches::SourceResourceOwner>(&p.owner) {
                    Ok(source_owner) => serde_json::to_string(&source_owner)?,
                    Err(_) => p.owner,
                }
            } else {p.owner};
            let reference = db.register_model_reference(p.kind, &owner, &p.target, &p.holder).map_err(domain)?;
            Ok(json!({"reference":reference}))
        }
        "runtime.model_reference.resolve" => {
            let p: ModelReferenceResolveParams = serde_json::from_value(params)?;
            Ok(serde_json::to_value(db.resolve_model_reference(p.kind, &p.reference).map_err(domain)?)?)
        }
        "runtime.model_reference.target" => {
            let p: ModelReferenceTargetParams = serde_json::from_value(params)?;
            db.operation(&p.operation_id).map_err(domain)?;
            if let Some(target) = p.target {
                Ok(db.freeze_model_target(&p.operation_id, &p.purpose, &p.original, &target).map_err(domain)?)
            } else {
                Ok(db.model_target(&p.operation_id, &p.purpose, &p.original).map_err(domain)?.unwrap_or(Value::Null))
            }
        }
        _ => Err(KernelError::Protocol(format!("Unknown model reference method: {method}"))),
    }
}
