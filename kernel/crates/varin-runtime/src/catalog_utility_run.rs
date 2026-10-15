//! Branchless Run codec shared by explicit standalone product owners.
use super::*;
use serde::Deserialize;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UtilityRun {
    pub kind: String,
    pub id: String,
    pub state: RunState,
    pub epoch: u64,
    pub revision: u64,
    pub cancel_requested: bool,
}
pub(super) fn recover(tx: &Transaction<'_>, value: &Value, epoch: u64) -> Result<bool> {
    if value["kind"] != model_text::KIND && value["kind"] != knowledge_inference::KIND {
        return Ok(false);
    }
    let mut run: UtilityRun = serde_json::from_value(value.clone())?;
    if !run.state.terminal() {
        run.epoch = epoch;
        run.cancel_requested = true;
        run.revision += 1;
        put(tx, "runs", &run.id, &run)?;
    }
    Ok(true)
}
