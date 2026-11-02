//! One-time conversion at the Catalog open boundary. Execution and history readers use
//! the current representation after commit; original bodies and identities stay in place.
use super::*;

struct Upgrade {
    from: i64,
    to: i64,
    convert: fn(&Transaction<'_>, &[HistoryIndex]) -> Result<()>,
}

const UPGRADES: &[Upgrade] = &[
    Upgrade {
        from: 78,
        to: 79,
        convert: |tx, _| external::initialize_new(tx),
    },
    // The ledger starts empty: earlier receipts lack settle time and attribution, so they are
    // not backfilled. Its start time commits with the format marker.
    Upgrade {
        from: 79,
        to: 80,
        convert: |tx, _| usage_ledger::initialize(tx),
    },
    // Delegated selection adds typed Operation intents and optional child metadata.
    // Existing children retain their original inherited model binding. Sparse text
    // indexes point into original content objects; no body is copied or work replayed.
    // Generation 81 belongs to another schema and is
    // deliberately not accepted until its conversion has been independently verified.
    Upgrade {
        from: 80,
        to: 82,
        convert: install_history_indexes,
    },
];

pub(super) fn supports(mut version: i64) -> bool {
    while version < FORMAT {
        let Some(step) = UPGRADES.iter().find(|step| step.from == version) else {
            return false;
        };
        version = step.to;
    }
    version == FORMAT
}

pub(super) fn check_external_schema(db: &Connection, version: i64) -> Result<()> {
    if version >= 79 {
        external::check_format(db)?;
    }
    Ok(())
}

struct HistoryIndex {
    table: &'static str,
    key: &'static str,
    id: String,
    before: String,
    after: String,
}

// Prepare the derived metadata before taking the write transaction. Read only stored
// JSON payloads: never hydrate referenced attachments, provider media or tool outputs.
fn prepare_history_indexes(
    db: &Connection,
    content: &crate::content::ContentStore,
) -> Result<Vec<HistoryIndex>> {
    let mut indexes = Vec::new();
    for (table, key, query) in [
        (
            "history",
            "id",
            "SELECT id,body FROM history WHERE json_extract(body,'$.source') IN ('user','assistant') AND json_type(body,'$.content.history_text') IS NULL",
        ),
        (
            "input_history_content",
            "input_id",
            "SELECT input_id,body FROM input_history_content WHERE json_type(body,'$.history_text') IS NULL",
        ),
    ] {
        let mut statement = db.prepare(query)?;
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (id, before) = row?;
            let mut body: Value = serde_json::from_str(&before)?;
            let reference = if table == "history" {
                &mut body["content"]
            } else {
                &mut body
            };
            let payload = content.load(reference)?;
            *reference = content.index_history_text(reference.clone(), &payload)?;
            indexes.push(HistoryIndex {
                table,
                key,
                id,
                before,
                after: encode(&body)?,
            });
        }
    }
    Ok(indexes)
}

fn install_history_indexes(tx: &Transaction<'_>, indexes: &[HistoryIndex]) -> Result<()> {
    for index in indexes {
        let changed = tx.execute(
            &format!(
                "UPDATE {} SET body=?1 WHERE {}=?2 AND body=?3",
                index.table, index.key
            ),
            params![index.after, index.id, index.before],
        )?;
        if changed != 1 {
            return Err(RuntimeError::Conflict(
                "Original history changed during catalog upgrade".into(),
            ));
        }
    }
    Ok(())
}

pub(super) fn apply(
    db: &mut Connection,
    from: i64,
    content: &crate::content::ContentStore,
) -> Result<()> {
    apply_before_commit(db, from, content, |_| Ok(()))
}

fn apply_before_commit(
    db: &mut Connection,
    from: i64,
    content: &crate::content::ContentStore,
    before_commit: impl FnOnce(&Transaction<'_>) -> Result<()>,
) -> Result<()> {
    let result = (|| {
        let indexes = prepare_history_indexes(db, content)?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut version = inspect_catalog_format(&tx)?;
        if version != from {
            return Err(RuntimeError::Conflict(
                "catalog generation changed before upgrade".into(),
            ));
        }
        while version != FORMAT {
            let step = UPGRADES
                .iter()
                .find(|step| step.from == version)
                .ok_or(RuntimeError::Format(version))?;
            (step.convert)(&tx, &indexes)?;
            version = step.to;
            tx.pragma_update(None, "user_version", version)?;
        }
        check_catalog_schema(&tx, FORMAT)?;
        event(
            &tx,
            "catalog",
            version as u64,
            "catalog.upgraded",
            json!({ "from": from, "to": version }),
        )?;
        before_commit(&tx)?;
        tx.commit()?;
        Ok(())
    })();
    result.map_err(|source| RuntimeError::Upgrade {
        from,
        to: FORMAT,
        source: Box::new(source),
    })
}

#[cfg(test)]
#[path = "catalog_upgrade_tests.rs"]
mod tests;
