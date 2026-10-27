//! A normal immutable pin retains its paired filesystem root. The pair survives
//! the source branch, and drains with the original pin rather than an age policy.
use super::*;
impl Storage {
    pub(in crate::storage::workspace_metadata) fn pinned_filesystem(
        &self,
        pin: &str,
        data_root: &str,
    ) -> Result<Option<(Head, String)>, KernelError> {
        let id = format!("workspace-filesystem-pin:{pin}");
        let row:Option<String>=self.conn.query_row("SELECT payload_json FROM domain_records WHERE record_id=?1 AND record_type='workspace.filesystem-pin'",[id],|row|row.get(0)).optional()?;
        let Some(row) = row else {
            return Ok(None);
        };
        let value: Value = serde_json::from_str(&row)?;
        let head: Head = serde_json::from_value(value["head"].clone())?;
        let root = value["root"]
            .as_str()
            .ok_or_else(|| KernelError::Storage("Filesystem pin root is missing".into()))?;
        let retained: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pins WHERE pin_id=?1 AND root_hash=?2)",
            params![format!("filesystem-pin:{pin}"), root],
            |row| row.get(0),
        )?;
        if value["dataRoot"] != data_root || !retained {
            return Err(KernelError::Storage(
                "Filesystem pin differs from its original body boundary".into(),
            ));
        }
        Ok(Some((head, root.into())))
    }
    pub(in crate::storage) fn retain_filesystem_pin(
        &mut self,
        pin: &str,
        branch: &str,
        revision: i64,
        write_revision: i64,
        data_root: &str,
        subtree: Option<&str>,
        selected_root: &str,
        grant: &str,
        ephemeral: bool,
    ) -> Result<(), KernelError> {
        let Some((head, root)) =
            self.selected_filesystem(branch, revision, write_revision, data_root)?
        else {
            return Ok(());
        };
        let (head, root) =
            self.scope_workspace_metadata(&head, &root, &[], subtree.unwrap_or(""))?;
        let workspace = self.branch(branch)?.workspace_id;
        self.conn.execute("INSERT INTO pins(pin_id,branch_id,workspace_id,revision,write_revision,root_hash,grant_id,ephemeral,created_at) VALUES(?1,?2,?3,-1,?4,?5,?6,?7,?8)",params![format!("filesystem-pin:{pin}"),head.metadata_branch,workspace,crate::model::SNAPSHOT_PIN_WRITE_REVISION,root,grant,ephemeral,now_ms()])?;
        self.conn.execute("INSERT INTO domain_records(record_id,workspace_id,record_type,state,record_revision,payload_json,created_at,updated_at) VALUES(?1,?2,'workspace.filesystem-pin','active',1,?3,?4,?4)",params![format!("workspace-filesystem-pin:{pin}"),workspace,json!({"pinId":pin,"head":head,"root":root,"dataRoot":selected_root}).to_string(),now_ms()])?;
        Ok(())
    }
    pub(in crate::storage) fn prune_filesystem_pins(&mut self) -> Result<(), KernelError> {
        self.conn.execute("DELETE FROM pins WHERE pin_id IN (SELECT 'filesystem-pin:'||json_extract(payload_json,'$.pinId') FROM domain_records WHERE record_type='workspace.filesystem-pin' AND NOT EXISTS(SELECT 1 FROM pins WHERE pin_id=json_extract(payload_json,'$.pinId')))",[])?;
        self.conn.execute("DELETE FROM domain_records WHERE record_type='workspace.filesystem-pin' AND NOT EXISTS(SELECT 1 FROM pins WHERE pin_id=json_extract(payload_json,'$.pinId'))",[])?;
        Ok(())
    }
}
