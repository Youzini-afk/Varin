//! MCP creation bodies use Storage's existing immutable object store. The
//! original holder owns the durable reference; released holders retain only its
//! fingerprint. Staging, hashing and hydration run on Source workers.
use super::*;
use crate::source_resources::{
    AuthorityRecord, SourceAuthorityAddress, SourceDispatch, SourceMcpHolderBinding,
    SourceMcpCreationOutcome, SourceMcpCreationReceiptBodyRef,
};

pub(crate) struct McpReceiptPreparation {
    pub(super) address: SourceAuthorityAddress,
    pub(super) binding: SourceMcpHolderBinding,
    pub(super) request_hash: String,
    pub(super) epoch: String,
    pub(super) outcome: SourceMcpCreationOutcome,
    pub(super) root: PathBuf,
}
pub(crate) struct StagedMcpReceipt {
    pub(super) address: SourceAuthorityAddress,
    pub(super) binding: SourceMcpHolderBinding,
    pub(super) request_hash: String,
    pub(super) epoch: String,
    pub(super) staged: PathBuf,
    pub(super) reference: SourceMcpCreationReceiptBodyRef,
}
impl Drop for StagedMcpReceipt {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
    }
}
impl McpReceiptPreparation {
    pub(crate) fn stage(self) -> Result<(Value, StagedMcpReceipt), KernelError> {
        let value = serde_json::to_value(self.outcome)?;
        let bytes = serde_json::to_vec(&value)?;
        let staged = StagedMcpReceipt {
            address: self.address,
            binding: self.binding,
            request_hash: self.request_hash,
            epoch: self.epoch,
            staged: self
                .root
                .join("staging")
                .join(format!("source-mcp-receipt-{}", Uuid::new_v4())),
            reference: SourceMcpCreationReceiptBodyRef {
                object_hash: format!("sha256-{}", hex::encode(Sha256::digest(&bytes))),
                byte_length: bytes.len() as u64,
            },
        };
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged.staged)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok((value, staged))
    }
}
pub(crate) struct McpReceiptBody {
    value: Value,
    path: PathBuf,
    reference: SourceMcpCreationReceiptBodyRef,
    _retention: blob_reads::BlobReadRetention,
}
impl McpReceiptBody {
    pub(crate) fn load(mut self) -> Result<Value, KernelError> {
        let bytes = fs::read(&self.path)?;
        if bytes.len() as u64 != self.reference.byte_length
            || format!("sha256-{}", hex::encode(Sha256::digest(&bytes)))
                != self.reference.object_hash
        {
            return Err(KernelError::Storage(
                "Original MCP creation receipt object is corrupt".into(),
            ));
        }
        self.value["outcome"] = serde_json::from_slice(&bytes)?;
        Ok(self.value)
    }
}
impl Storage {
    pub(super) fn recall_source_mcp_creation_receipt(
        &mut self,
        record: AuthorityRecord,
        index: usize,
        dispatch: bool,
    ) -> Result<SourceDispatch, KernelError> {
        let holder = &record.result.mcp_holders[index];
        let reference = holder
            .creation_receipt
            .as_ref()
            .and_then(|receipt| receipt.outcome_ref.clone());
        let released = holder.released;
        let value =
            json!({"dispatch":dispatch,"holder":holder,"authority":record.result,"outcome":null});
        // Release acknowledges that the original coordinator no longer needs the
        // creation body. Its immutable hash is still a late-settlement fence.
        if let Some(reference) = reference.filter(|_| !released) {
            return Ok(SourceDispatch::McpCreationReceiptObserve(McpReceiptBody {
                path: object_path(&self.root, &reference.object_hash)?,
                _retention: self.blob_read_roots.retain(&reference.object_hash),
                reference,
                value,
            }));
        }
        Ok(SourceDispatch::Ready(value))
    }
}
