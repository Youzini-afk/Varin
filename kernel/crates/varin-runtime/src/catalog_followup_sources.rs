//! Flat one-shot conditions retain each leaf's cursor and receipt binding in the Catalog.
//! A reconciliation observes one current snapshot; it does not reconstruct which event
//! historically won a race while this owner was offline.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupSource {
    At { at_ms: u64 },
    ProcessStopped { operation_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupLeafEvidence {
    At {
        at_ms: u64,
        observed_at_ms: u64,
    },
    ProcessStopped {
        receipt_identity: String,
        receipt_epoch: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceObservation {
    pub trigger_cursor: u64,
    pub evidence: FollowupLeafEvidence,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceState {
    pub source_index: usize,
    pub after_cursor: u64,
    pub observed: Option<FollowupSourceObservation>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceEvidence {
    pub source_index: usize,
    pub trigger_cursor: u64,
    pub evidence: FollowupLeafEvidence,
}
impl FollowupTrigger {
    pub fn sources(&self) -> Vec<FollowupSource> {
        match self {
            Self::At { at_ms } => vec![FollowupSource::At { at_ms: *at_ms }],
            Self::ProcessStopped { operation_id } => vec![FollowupSource::ProcessStopped {
                operation_id: operation_id.clone(),
            }],
            Self::Any { sources } | Self::All { sources } => sources.clone(),
            Self::RunCompleted { .. } | Self::GoalRequested { .. } => vec![],
        }
    }
}
impl TriggerEvidence {
    pub(super) fn has_at(&self) -> bool {
        match self {
            Self::At { .. } => true,
            Self::Any { sources } | Self::All { sources } => sources
                .iter()
                .any(|s| matches!(s.evidence, FollowupLeafEvidence::At { .. })),
            _ => false,
        }
    }
    pub(super) fn process_receipts(&self) -> Vec<(&str, &str)> {
        match self {
            Self::ProcessStopped {
                receipt_identity,
                receipt_epoch,
            } => vec![(receipt_identity, receipt_epoch)],
            Self::Any { sources } | Self::All { sources } => sources
                .iter()
                .filter_map(|s| match &s.evidence {
                    FollowupLeafEvidence::ProcessStopped {
                        receipt_identity,
                        receipt_epoch,
                    } => Some((receipt_identity.as_str(), receipt_epoch.as_str())),
                    _ => None,
                })
                .collect(),
            _ => vec![],
        }
    }
}
fn observe_leaf(
    tx: &Transaction<'_>,
    d: &Definition,
    index: usize,
    source: &FollowupSource,
    now: u64,
) -> Result<Option<FollowupSourceObservation>> {
    let (trigger_cursor, evidence) = match source {
        FollowupSource::At { at_ms } => {
            if now < *at_ms {
                return Ok(None);
            }
            let cursor = event(
                tx,
                &d.id,
                d.revision,
                "followup.time_reached",
                json!({"source_index":index,"at_ms":at_ms,"observed_at_ms":now}),
            )?;
            (
                cursor,
                FollowupLeafEvidence::At {
                    at_ms: *at_ms,
                    observed_at_ms: now,
                },
            )
        }
        FollowupSource::ProcessStopped { operation_id } => {
            let op: Operation = record(tx, "operations", operation_id)?;
            let Some(receipt) = op.external_receipt.as_ref().filter(|r| r.executor_stopped) else {
                return Ok(None);
            };
            if receipt.identity != op.id
                || receipt.executor != "process_spawn"
                || op.execution_owner != Some(ExecutorOwner::Kernel)
            {
                return Err(RuntimeError::Invalid(
                    "process stop receipt owner mismatch".into(),
                ));
            }
            // The executor's original indexed receipt is the only stop authority. It may
            // precede registration; register-then-recheck must still observe that fact.
            let cursor = tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?2 AND json_extract(data,'$.receipt_epoch')=?3 ORDER BY cursor LIMIT 1", params![op.id, receipt.identity, receipt.epoch], |r| read_number(r, 0))?;
            (
                cursor,
                FollowupLeafEvidence::ProcessStopped {
                    receipt_identity: receipt.identity.clone(),
                    receipt_epoch: receipt.epoch.clone(),
                },
            )
        }
    };
    Ok(Some(FollowupSourceObservation {
        trigger_cursor,
        evidence,
    }))
}
pub(super) fn observe_sources(
    tx: &Transaction<'_>,
    d: &mut Definition,
    now: u64,
) -> Result<Option<(u64, TriggerEvidence)>> {
    let sources = d.trigger.sources();
    if sources.is_empty()
        || d.sources.len() != sources.len()
        || d.sources
            .iter()
            .enumerate()
            .any(|(i, s)| s.source_index != i)
    {
        return Err(RuntimeError::Invalid(
            "follow-up source cursor binding changed".into(),
        ));
    }
    let mut changed = false;
    for (index, source) in sources.iter().enumerate() {
        if d.sources[index].observed.is_none() {
            if let Some(observed) = observe_leaf(tx, d, index, source, now)? {
                d.sources[index].observed = Some(observed);
                changed = true;
            }
        }
    }
    if changed {
        put(tx, "followups", &d.id, d)?;
        event(
            tx,
            &d.id,
            d.revision,
            "followup.sources_observed",
            json!({"sources":d.sources}),
        )?;
    }
    let observed = d
        .sources
        .iter()
        .filter_map(|s| {
            s.observed.as_ref().map(|o| FollowupSourceEvidence {
                source_index: s.source_index,
                trigger_cursor: o.trigger_cursor,
                evidence: o.evidence.clone(),
            })
        })
        .collect::<Vec<_>>();
    if observed.is_empty()
        || (matches!(d.trigger, FollowupTrigger::All { .. }) && observed.len() != sources.len())
    {
        return Ok(None);
    }
    let cursor = observed
        .iter()
        .map(|s| s.trigger_cursor)
        .max()
        .expect("observed source");
    let evidence = match &d.trigger {
        FollowupTrigger::Any { .. } => TriggerEvidence::Any { sources: observed },
        FollowupTrigger::All { .. } => TriggerEvidence::All { sources: observed },
        _ => match &observed[0].evidence {
            FollowupLeafEvidence::At {
                at_ms,
                observed_at_ms,
            } => TriggerEvidence::At {
                at_ms: *at_ms,
                observed_at_ms: *observed_at_ms,
            },
            FollowupLeafEvidence::ProcessStopped {
                receipt_identity,
                receipt_epoch,
            } => TriggerEvidence::ProcessStopped {
                receipt_identity: receipt_identity.clone(),
                receipt_epoch: receipt_epoch.clone(),
            },
        },
    };
    Ok(Some((cursor, evidence)))
}
fn process_settled(db: &Connection, identity: &str, epoch: &str) -> Result<bool> {
    let op: Operation = record(db, "operations", identity)?;
    let occupied: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
        [identity],
        |r| r.get(0),
    )?;
    Ok(op.phase == OperationPhase::Terminal
        && !occupied
        && op.execution_owner == Some(ExecutorOwner::Kernel)
        && op.external_receipt.as_ref().is_some_and(|r| {
            r.executor_stopped
                && r.executor == "process_spawn"
                && r.identity == identity
                && r.epoch == epoch
        }))
}
fn leaf_settled(db: &Connection, evidence: &FollowupLeafEvidence) -> Result<bool> {
    match evidence {
        FollowupLeafEvidence::At { .. } => Ok(true),
        FollowupLeafEvidence::ProcessStopped {
            receipt_identity,
            receipt_epoch,
        } => process_settled(db, receipt_identity, receipt_epoch),
    }
}
pub(super) fn evidence_settled(db: &Connection, evidence: &TriggerEvidence) -> Result<bool> {
    match evidence {
        TriggerEvidence::ProcessStopped {
            receipt_identity,
            receipt_epoch,
        } => process_settled(db, receipt_identity, receipt_epoch),
        TriggerEvidence::Any { sources } => {
            // An actually observed At branch is independently eligible; a merely mentioned
            // or still-running process cannot turn an OR into an implicit AND.
            if sources
                .iter()
                .any(|s| matches!(s.evidence, FollowupLeafEvidence::At { .. }))
            {
                return Ok(true);
            }
            for source in sources {
                if leaf_settled(db, &source.evidence)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        TriggerEvidence::All { sources } => {
            for source in sources {
                if !leaf_settled(db, &source.evidence)? {
                    return Ok(false);
                }
            }
            Ok(!sources.is_empty())
        }
        _ => Ok(true),
    }
}
pub(super) fn nearest_deadline(db: &Connection) -> Result<Option<u64>> {
    // Read just the persisted clock-leaf cursors. A malformed independent definition is
    // reported by fact reconciliation; it must not disarm unrelated Wait deadlines.
    let next: Option<i64> = db.query_row(
        "SELECT min(CASE json_extract(f.body,'$.trigger.kind')
            WHEN 'at' THEN json_extract(f.body,'$.trigger.at_ms')
            ELSE json_extract(f.body,'$.trigger.sources[' || json_extract(s.value,'$.source_index') || '].at_ms') END)
         FROM followups f JOIN json_each(f.body,'$.sources') s
         WHERE json_extract(f.body,'$.wait.state')='waiting'
           AND json_extract(f.body,'$.state')!='cancelled'
           AND json_extract(s.value,'$.observed') IS NULL
           AND ((json_extract(f.body,'$.trigger.kind')='at' AND json_extract(s.value,'$.source_index')=0)
             OR (json_extract(f.body,'$.trigger.kind') IN ('any','all')
               AND json_extract(f.body,'$.trigger.sources[' || json_extract(s.value,'$.source_index') || '].kind')='at'))",
        [], |row| row.get(0),
    )?;
    next.map(|n| {
        u64::try_from(n).map_err(|_| RuntimeError::Invalid("negative follow-up deadline".into()))
    })
    .transpose()
}
