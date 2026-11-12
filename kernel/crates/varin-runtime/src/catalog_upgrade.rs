//! One-time conversion at the Catalog open boundary. Execution and history readers use
//! the current representation after commit; original bodies and identities stay in place.
use super::*;

struct Upgrade {
    from: i64,
    to: i64,
    convert: fn(&Transaction<'_>, &[HistoryIndex]) -> Result<()>,
}

const UPGRADES: &[Upgrade] = &[
    // The original directory omitted readable unowned native conversations. Ask the
    // Settings-backed initializer to fill missing placements without changing owners,
    // existing positions, container identities or original command receipts.
    Upgrade { from: 96, to: 97, convert: |tx, _| { tx.execute("UPDATE organization_spaces SET initialization=NULL", [])?; Ok(()) } },
    Upgrade { from: 95, to: 96, convert: |tx, _| organization::upgrade_95(tx) },
    Upgrade { from: 94, to: 95, convert: |tx, _| organization::initialize_95(tx) },
    // New recipes freeze readable source mappings separately from their original bodies.
    // Earlier readers must not ignore that mapping and reinterpret offsets/retention groups.
    // Existing recipes retain their exact optional-field-free semantics.
    Upgrade { from: 93, to: 94, convert: |_, _| Ok(()) },
    Upgrade { from: 92, to: 93, convert: |tx, _| model_references::upgrade(tx) },
    // Frozen quote relations live in the original input bodies. Older readers must not
    // silently omit their model projection; historical bodies and receipts stay unchanged.
    Upgrade { from: 91, to: 92, convert: |_, _| Ok(()) },
    Upgrade { from: 90, to: 91, convert: |tx, _| usage_ledger::upgrade_responses_cache_writes(tx) },
    // Existing launches have no extension admission marker and keep their exact semantics.
    // Only newly admitted automatic roots use the field; old readers must reject it.
    Upgrade { from: 89, to: 90, convert: |_, _| Ok(()) },
    Upgrade { from: 88, to: 89, convert: |tx, _| { followups::events::upgrade(tx)?; external::assign_legacy_principals(tx)?; attachments::upgrade_external_targets(tx) } },
    Upgrade { from: 87, to: 88, convert: |tx, _| { identity::upgrade(tx)?; calendar::upgrade_invocations(tx) } },
    Upgrade { from: 86, to: 87, convert: |tx, _| principals::upgrade(tx) },
    // Tool children retain their exact old bodies. Nullable provenance admits the new
    // User domain only; the marker prevents an old reader from treating it as a tool.
    Upgrade { from: 85, to: 86, convert: |_, _| Ok(()) },
    Upgrade { from: 84, to: 85, convert: |tx, _| attachments::initialize(tx) },
    Upgrade { from: 83, to: 84, convert: |tx, _| driver::upgrade(tx) },
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
    // These are distinct persisted layouts, not interchangeable generation labels.
    // 81 contains Zone2 captures; standalone 82 contains indexed delegation history.
    Upgrade {
        from: 80,
        to: 81,
        convert: |tx, _| context_observations::initialize(tx),
    },
    Upgrade {
        from: 81,
        to: 83,
        convert: install_history_indexes,
    },
    Upgrade {
        from: 82,
        to: 83,
        convert: |tx, _| context_observations::initialize(tx),
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

/// Standalone 82 does not contain Zone2. A blanket >=81 check would reject that
/// valid asset or, worse, relabel a different layout without running its converter.
pub(super) fn check_context_schema(db: &Connection, version: i64) -> Result<()> {
    if matches!(version, 81 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97) {
        return context_observations::check_format(db);
    }
    let present: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('context_observation_captures','context_observation_imports','context_observation_queue_cursor','context_observation_queue_page'))",
        [], |row| row.get(0))?;
    if present {
        return Err(RuntimeError::Invalid(format!(
            "Catalog {version} does not define the Zone2 capture schema"
        )));
    }
    Ok(())
}

/// 82 introduced sparse original-history references. Do not silently repair a
/// current generation or defer an unbounded content scan to a dispatch request.
/// Environment queue entries (including Zone2 captures) intentionally have a
/// different representation and are not evidence of a missing history index.
pub(super) fn check_history_indexes(db: &Connection, version: i64) -> Result<()> {
    if !matches!(version, 82 | 83 | 84 | 85 | 86 | 87 | 88 | 89 | 90 | 91 | 92 | 93 | 94 | 95 | 96 | 97) {
        return Ok(());
    }
    let missing: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM history WHERE json_extract(body,'$.source') IN ('user','assistant') AND json_type(body,'$.content.history_text') IS NOT 'object')",
        [],
        |row| row.get(0),
    )?;
    if missing {
        return Err(RuntimeError::Invalid(format!(
            "Catalog {version} original history text index is missing or malformed; data was preserved"
        )));
    }
    Ok(())
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

// The retired text-reference convention is interpreted only at conversion. New
// dispatches inherit typed file parts; ordinary text never creates a read relation.
fn prepare_material_inheritances(db:&Connection,content:&crate::content::ContentStore)->Result<Vec<HistoryIndex>> {
    let reference=regex::Regex::new(r#""(?:snapshotId|sourceSnapshotId)"\s*:\s*"([^"\\]+)""#).expect("legacy material pattern");
    fn collect(value:&Value,reference:&regex::Regex,ids:&mut std::collections::BTreeSet<String>) {
        match value {
            Value::Object(fields)=>for (key,value) in fields {
                if matches!(key.as_str(),"snapshotId"|"sourceSnapshotId") {
                    if let Some(id)=value.as_str(){ids.insert(id.to_owned());}
                }
                collect(value,reference,ids);
            },
            Value::Array(values)=>for value in values {collect(value,reference,ids);},
            Value::String(text)=>for capture in reference.captures_iter(text){ids.insert(capture[1].to_owned());},
            _=>(),
        }
    }
    let mut rows=Vec::new();
    for row in db.prepare("SELECT id,body FROM child_tasks WHERE json_extract(body,'$.inherited_context') IS NOT NULL")?.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))? {
        let (id,before)=row?;let mut body:Value=serde_json::from_str(&before)?;
        let mut ids=std::collections::BTreeSet::new();
        collect(&content.load(&body["inherited_context"]["items"] )?,&reference,&mut ids);
        if !ids.is_empty() {
            body["material_snapshot_ids"]=json!(ids);
            rows.push(HistoryIndex{table:"child_tasks",key:"id",id,before,after:encode(&body)?});
        }
    }
    Ok(rows)
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
        let indexes = if matches!(from, 78 | 79 | 80 | 81) {
            prepare_history_indexes(db, content)?
        } else {
            Vec::new()
        };
        let materials = prepare_material_inheritances(db,content)?;
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
        install_history_indexes(&tx,&materials)?;
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
