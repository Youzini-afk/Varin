//! Plan identity projections only. KnowledgeStore owns every plan body and receipt.
use super::*;
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanView {
    pub thread_id: String,
    pub branch_id: String,
    pub head_id: Option<String>,
    pub inherited_ref: Option<String>,
    pub fork_basis: Option<PlanForkBasis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanForkBasis {
    pub source_branch_id: String,
    pub head_id: Option<String>,
    pub source_inherited_ref: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanForkCapture {
    pub source_thread_id: String,
    pub source_branch_id: String,
    pub target_branch_id: String,
    pub head_id: Option<String>,
    pub inherited_ref: Option<String>,
    pub captured_ref: Option<String>,
}

impl Catalog {
    /// A fixed cut of actual ancestry; no content bodies are hydrated here.
    pub fn plan_view(&self, branch_id: &str, head_id: Option<&str>) -> Result<PlanView> {
        let thread_id = self.branch_thread_id(branch_id)?;
        self.head(branch_id)?;
        if let Some(head) = head_id {
            let actual: Option<String> = self
                .db
                .query_row("SELECT thread_id FROM history WHERE id=?1", [head], |row| {
                    row.get(0)
                })
                .optional()?;
            if actual.as_deref() != Some(thread_id.as_str()) {
                return Err(RuntimeError::Invalid(
                    "plan head belongs to another Thread or is unavailable".into(),
                ));
            }
        }
        let creation: Option<String> = self.db.query_row(
            "SELECT data FROM events WHERE subject=?1 AND kind='branch.created' ORDER BY cursor LIMIT 1",
            [branch_id], |row| row.get(0)).optional()?;
        let creation = creation
            .map(|value| serde_json::from_str::<Value>(&value))
            .transpose()?;
        let capture: Option<PlanForkCapture> = creation
            .as_ref()
            .and_then(|value| value.get("planCapture"))
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()?;
        let inherited_ref = capture
            .as_ref()
            .and_then(|value| value.captured_ref.clone());
        let fork_basis = capture.map(|value| PlanForkBasis {
            source_branch_id: value.source_branch_id,
            head_id: value.head_id,
            source_inherited_ref: value.inherited_ref,
        });
        Ok(PlanView {
            thread_id,
            branch_id: branch_id.into(),
            head_id: head_id.map(str::to_owned),
            inherited_ref,
            fork_basis,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    epoch: u64,
    thread: String,
    branch: String,
    head: Option<String>,
    candidate: Option<String>,
    seeking_head: bool,
    next: Option<String>,
}
// HMAC-SHA256 with a per-open random key. Tokens are transient authenticated read
// positions, never durable authorization or an additional history owner.
fn mac(key: &[u8; 32], data: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut inner = [0x36; 64];
    let mut outer = [0x5c; 64];
    for (index, byte) in key.iter().enumerate() {
        inner[index] ^= byte;
        outer[index] ^= byte;
    }
    let mut hash = Sha256::new();
    hash.update(inner);
    hash.update(data);
    let inside = hash.finalize();
    let mut hash = Sha256::new();
    hash.update(outer);
    hash.update(inside);
    hash.finalize().into()
}
impl Catalog {
    pub fn plan_contains(
        &self,
        branch_id: &str,
        head_id: Option<&str>,
        candidate_head_id: Option<&str>,
        token: Option<&str>,
    ) -> Result<Value> {
        use base64::Engine;
        let codec = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let thread = self.branch_thread_id(branch_id)?;
        let mut cursor = if let Some(token) = token {
            let (body, signature) = token
                .split_once('.')
                .ok_or_else(|| RuntimeError::Invalid("invalid plan cursor".into()))?;
            let bytes = codec
                .decode(body)
                .map_err(|_| RuntimeError::Invalid("invalid plan cursor".into()))?;
            let signature = hex::decode(signature)
                .map_err(|_| RuntimeError::Invalid("invalid plan cursor".into()))?;
            let expected = mac(&self.plan_cursor_key, &bytes);
            if signature.len() != expected.len()
                || signature
                    .iter()
                    .zip(expected)
                    .fold(0u8, |v, (a, b)| v | (a ^ b))
                    != 0
            {
                return Err(RuntimeError::Invalid(
                    "invalid plan cursor signature".into(),
                ));
            }
            let cursor: Cursor = serde_json::from_slice(&bytes)?;
            if cursor.epoch != self.epoch
                || cursor.thread != thread
                || cursor.branch != branch_id
                || cursor.head.as_deref() != head_id
                || cursor.candidate.as_deref() != candidate_head_id
            {
                return Err(RuntimeError::Conflict(
                    "plan cursor belongs to another fixed view or epoch".into(),
                ));
            }
            cursor
        } else {
            Cursor {
                epoch: self.epoch,
                thread,
                branch: branch_id.into(),
                head: head_id.map(str::to_owned),
                candidate: candidate_head_id.map(str::to_owned),
                seeking_head: true,
                next: self.head(branch_id)?,
            }
        };
        // Same default page budget as immutable history projection; never a conversation limit.
        for _ in 0..256 {
            if cursor.seeking_head && (cursor.head.is_none() || cursor.next == cursor.head) {
                cursor.seeking_head = false;
                cursor.next = cursor.head.clone();
            }
            if !cursor.seeking_head
                && (cursor.candidate.is_none() || cursor.next == cursor.candidate)
            {
                return Ok(json!({"status":"ready","visible":true}));
            }
            let Some(key) = cursor.next else {
                return if cursor.seeking_head {
                    Err(RuntimeError::Invalid("plan head is not an ancestor".into()))
                } else {
                    Ok(json!({"status":"ready","visible":false}))
                };
            };
            let row: Option<(String, Option<String>)> = self
                .db
                .query_row(
                    "SELECT thread_id,parent FROM history WHERE id=?1",
                    [&key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (actual, parent) = row.ok_or_else(|| RuntimeError::NotFound(key))?;
            if actual != cursor.thread {
                return Err(RuntimeError::Invalid(
                    "plan ancestry crosses Threads".into(),
                ));
            }
            cursor.next = parent;
        }
        let bytes = serde_json::to_vec(&cursor)?;
        let signature = hex::encode(mac(&self.plan_cursor_key, &bytes));
        Ok(json!({"status":"pending","cursor":format!("{}.{}",codec.encode(bytes),signature)}))
    }
}
