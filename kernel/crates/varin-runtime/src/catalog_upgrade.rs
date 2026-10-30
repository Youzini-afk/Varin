//! One-time conversion at the Catalog open boundary. Execution and history readers use
//! the current representation after commit; original bodies and identities stay in place.
use super::*;

struct Upgrade {
    from: i64,
    to: i64,
    convert: fn(&Transaction<'_>) -> Result<()>,
}

const UPGRADES: &[Upgrade] = &[Upgrade {
    from: 78,
    to: 79,
    convert: external::initialize_new,
}];

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

pub(super) fn apply(db: &mut Connection, from: i64) -> Result<()> {
    apply_before_commit(db, from, |_| Ok(()))
}

fn apply_before_commit(
    db: &mut Connection,
    from: i64,
    before_commit: impl FnOnce(&Transaction<'_>) -> Result<()>,
) -> Result<()> {
    let result = (|| {
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
            (step.convert)(&tx)?;
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
