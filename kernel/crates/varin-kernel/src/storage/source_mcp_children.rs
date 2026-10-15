//! Original dispatch definition references on the existing Source authority.
//! Large frozen selections live in Storage objects, never in control metadata.
use super::*;
use crate::source_resources::{
    AuthorityRecord, SourceAuthorityAddress, SourceDispatch, SourceMcpChildAction as Action,
    SourceMcpChildBinding, SourceMcpChildParams, SourceMcpChildReference,
    SourceMcpCreationReceiptBodyRef,
};
use varin_runtime::catalog::launches::HostToolBinding;

pub(crate) struct McpChildPreparation {
    address: SourceAuthorityAddress,
    binding: SourceMcpChildBinding,
    epoch: String,
    selection: HostToolBinding,
    root: PathBuf,
}
pub(crate) struct StagedMcpChild {
    address: SourceAuthorityAddress,
    binding: SourceMcpChildBinding,
    epoch: String,
    staged: PathBuf,
    reference: SourceMcpCreationReceiptBodyRef,
}
impl Drop for StagedMcpChild {
    fn drop(&mut self) { let _ = fs::remove_file(&self.staged); }
}
impl McpChildPreparation {
    pub(crate) fn stage(self) -> Result<StagedMcpChild, KernelError> {
        let bytes = serde_json::to_vec(&self.selection)?;
        let staged = StagedMcpChild {
            address: self.address, binding: self.binding, epoch: self.epoch,
            staged: self.root.join("staging").join(format!("source-mcp-child-{}", Uuid::new_v4())),
            reference: SourceMcpCreationReceiptBodyRef {
                object_hash: format!("sha256-{}", hex::encode(Sha256::digest(&bytes))),
                byte_length: bytes.len() as u64,
            },
        };
        let mut file = OpenOptions::new().create_new(true).write(true).open(&staged.staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(staged)
    }
}
pub(crate) struct McpChildBody {
    value: Value,
    path: PathBuf,
    reference: SourceMcpCreationReceiptBodyRef,
    _retention: blob_reads::BlobReadRetention,
}
impl McpChildBody {
    pub(crate) fn load(mut self) -> Result<Value, KernelError> {
        let bytes = fs::read(&self.path)?;
        if bytes.len() as u64 != self.reference.byte_length
            || format!("sha256-{}", hex::encode(Sha256::digest(&bytes))) != self.reference.object_hash
        { return Err(KernelError::Storage("Original MCP child selection object is corrupt".into())); }
        self.value["selection"] = serde_json::from_slice(&bytes)?;
        Ok(self.value)
    }
}
fn denied(message: &str) -> KernelError { KernelError::Authorization(message.into()) }
impl Storage {
    fn check_mcp_child_binding(record: &AuthorityRecord, binding: &SourceMcpChildBinding) -> Result<Option<usize>, KernelError> {
        if record.purpose != "mcp_owner" || !binding.validate()
            || record.result.scope.run_id() != Some(binding.parent_run_id.as_str())
        { return Err(denied("Original MCP child dependency identity is incomplete")); }
        let index = record.result.mcp_children.iter().position(|child| child.binding.operation_id == binding.operation_id);
        if index.is_some_and(|index| record.result.mcp_children[index].binding != *binding) {
            return Err(denied("Original MCP child dependency binding changed"));
        }
        Ok(index)
    }
    fn admit_mcp_child_reference(&self, address: &SourceAuthorityAddress, record: &AuthorityRecord,
        existing: bool, epoch: &str) -> Result<(), KernelError>
    {
        let grant = self.load_grant(&record.result.grant_id)?;
        if !matches!(record.result.phase.as_str(), "ready" | "retaining")
            || record.result.resource_epoch != epoch || grant.kernel_epoch != epoch
            || grant.state != crate::model::GrantState::Active
        { return Err(denied("Original MCP Source no longer admits child dependencies")); }
        if !existing { self.source_authority(address, true, epoch)?; }
        Ok(())
    }
    fn mcp_child_result(&self, record: &AuthorityRecord, index: usize) -> Result<Value, KernelError> {
        let grant = self.load_grant(&record.result.grant_id)?;
        Ok(json!({"reference":record.result.mcp_children[index],"phase":record.result.phase,
            "grantState":grant.state,"created":false,"selection":null}))
    }
    pub(crate) fn source_mcp_child(&mut self, p: SourceMcpChildParams, epoch: &str) -> Result<SourceDispatch, KernelError> {
        let address = SourceAuthorityAddress { principal_id:p.principal_id, coordinator_host_id:p.coordinator_host_id,
            authority_id:p.authority_id, resource_epoch:p.resource_epoch };
        let mut record = self.source_authority(&address, false, epoch)?;
        let index = Self::check_mcp_child_binding(&record, &p.binding)?;
        if (p.action == Action::Retain) != p.selection.is_some() {
            return Err(denied("Original MCP child retention requires its exact selection"));
        }
        if p.action == Action::Retain {
            let selection = p.selection.expect("retention selection checked");
            selection.validate().map_err(|error| denied(&error.to_string()))?;
            if selection.provenance.servers.is_empty() || selection.provenance.servers.values().any(|server| {
                server.owner.resource_owner != record.result.source.resource_owner
                    || server.owner.source_authority.as_ref().is_none_or(|original|
                        original.authority_id != address.authority_id || original.resource_epoch != address.resource_epoch
                        || original.coordinator_host_id != address.coordinator_host_id)
            }) { return Err(denied("MCP child dependency selection belongs to another Source")); }
            if let Some(index) = index.filter(|index| record.result.mcp_children[*index].released) {
                return Ok(SourceDispatch::Ready(self.mcp_child_result(&record, index)?));
            }
            self.admit_mcp_child_reference(&address, &record, index.is_some(), epoch)?;
            return Ok(SourceDispatch::McpChildSelectionStage(McpChildPreparation {
                address, binding:p.binding, epoch:epoch.into(), selection, root:self.root.clone(),
            }));
        }
        let index = match index {
            Some(index) => index,
            None if p.action == Action::Release => {
                // A cancel/release may overtake the original retain worker or its
                // lost acknowledgement. Persist the exact identity before replying.
                record.result.mcp_children.push(SourceMcpChildReference {
                    binding:p.binding, selection_ref:None, released:true,
                });
                record.result.mcp_children.len() - 1
            }
            None => return Err(denied("Original MCP child dependency is unavailable")),
        };
        if p.action == Action::Release {
            record.result.mcp_children[index].released = true;
            if record.result.phase == "retaining"
                && record.result.mcp_holders.iter().all(|holder| holder.released)
                && record.result.mcp_deliveries.iter().all(|delivery| delivery.released)
                && record.result.mcp_children.iter().all(|child| child.released)
            { record.result.phase = "draining".into(); }
            self.save_source_record("source.authority", &address.authority_id,
                &record.result.source.workspace_id, &record.result.phase, &record)?;
        }
        let value = self.mcp_child_result(&record, index)?;
        if p.action == Action::Read && !record.result.mcp_children[index].released {
            let reference = record.result.mcp_children[index].selection_ref.clone()
                .ok_or_else(|| denied("Original MCP child selection is unavailable"))?;
            return Ok(SourceDispatch::McpChildSelectionObserve(McpChildBody {
                path:object_path(&self.root, &reference.object_hash)?,
                _retention:self.blob_read_roots.retain(&reference.object_hash), reference, value,
            }));
        }
        Ok(SourceDispatch::Ready(value))
    }
    pub(crate) fn publish_source_mcp_child(&mut self, staged: StagedMcpChild) -> Result<Value, KernelError> {
        let mut record = self.source_authority(&staged.address, false, &staged.epoch)?;
        let prior = Self::check_mcp_child_binding(&record, &staged.binding)?;
        if let Some(index) = prior {
            let original = &record.result.mcp_children[index];
            if original.selection_ref.as_ref().is_some_and(|reference| reference != &staged.reference) {
                return Err(denied("Original MCP child dependency selection changed"));
            }
            if original.released { return self.mcp_child_result(&record, index); }
        }
        self.admit_mcp_child_reference(&staged.address, &record, prior.is_some(), &staged.epoch)?;
        if let Some(index) = prior { return self.mcp_child_result(&record, index); }
        let object = object_path(&self.root, &staged.reference.object_hash)?;
        let shard = object.parent().expect("content object shard");
        if !shard.exists() { fs::create_dir_all(shard)?; sync_directory(&self.root.join("objects"))?; }
        durable_rename(&staged.staged, &object)?;
        sync_directory(shard)?;
        sync_directory(&self.root.join("staging"))?;
        record.result.mcp_children.push(SourceMcpChildReference {
            binding:staged.binding.clone(), selection_ref:Some(staged.reference.clone()), released:false,
        });
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let published = (|| {
            self.conn.execute("INSERT OR IGNORE INTO blobs(hash,byte_length) VALUES(?1,?2)",
                params![staged.reference.object_hash, i64::try_from(staged.reference.byte_length)
                    .map_err(|_| KernelError::Storage("MCP child selection object is too large".into()))?])?;
            self.conn.execute("DELETE FROM pending_gc_files WHERE hash=?1", [&staged.reference.object_hash])?;
            self.save_source_record("source.authority", &staged.address.authority_id,
                &record.result.source.workspace_id, &record.result.phase, &record)
        })();
        if let Err(error) = published { let _ = self.conn.execute_batch("ROLLBACK"); return Err(error); }
        self.conn.execute_batch("COMMIT")?;
        let mut result = self.mcp_child_result(&record, record.result.mcp_children.len()-1)?;
        result["created"] = json!(true);
        Ok(result)
    }
}
