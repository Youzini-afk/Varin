//! Flat explicit conditions retain each leaf's cursor and receipt binding in the Catalog.
//! A reconciliation observes one current snapshot; it does not reconstruct which event
//! historically won a race while this owner was offline.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupSource {
    At {
        at_ms: u64,
    },
    ProcessStopped {
        operation_id: String,
    },
    JobStopped {
        operation_id: String,
    },
    Artifact {
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        artifact_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    Collection {
        operation_id: String,
    },
    File {
        path: String,
        condition: FileCondition,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupLeafEvidence {
    Artifact {
        binding: host_jobs::HostJobBinding,
        fact: FollowupArtifactFact,
        gap: bool,
    },
    Collection {
        binding: host_jobs::HostJobBinding,
        completion_revision: u64,
        outcome: ResearchCollectionOutcome,
        counts: ResearchArtifactCounts,
        gap: bool,
    },
    File {
        receipt_id: String,
        condition: FileCondition,
        path: String,
        state: FileState,
        proof: FileProof,
        position: Option<FileWatchPosition>,
        gap: bool,
        observed_at_ms: u64,
    },
    At {
        at_ms: u64,
        observed_at_ms: u64,
    },
    ProcessStopped {
        receipt_identity: String,
        receipt_epoch: String,
    },
    JobStopped {
        binding: host_jobs::HostJobBinding,
        outcome: Outcome,
        effect: Effect,
        receipt_identity: String,
        receipt_epoch: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceObservation {
    pub accepted_cursor: u64,
    pub trigger_cursor: u64,
    pub evidence: FollowupLeafEvidence,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceState {
    pub source_index: usize,
    pub after_cursor: u64,
    pub consumed_cursor: u64,
    pub observed: Option<FollowupSourceObservation>,
    pub file: Option<FollowupFileSourceState>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupSourceEvidence {
    pub source_index: usize,
    pub accepted_cursor: u64,
    pub trigger_cursor: u64,
    pub evidence: FollowupLeafEvidence,
}
impl FollowupSource {
    pub(super) fn repeatable(&self) -> bool {
        matches!(
            self,
            Self::Artifact { .. }
                | Self::Collection { .. }
                | Self::File {
                    condition: FileCondition::Changed,
                    ..
                }
        )
    }
}
impl FollowupTrigger {
    pub fn sources(&self) -> Vec<FollowupSource> {
        match self {
            Self::Artifact {
                operation_id,
                artifact_id,
                name,
            } => vec![FollowupSource::Artifact {
                operation_id: operation_id.clone(),
                artifact_id: artifact_id.clone(),
                name: name.clone(),
            }],
            Self::Collection { operation_id } => vec![FollowupSource::Collection {
                operation_id: operation_id.clone(),
            }],
            Self::JobStopped { operation_id } => vec![FollowupSource::JobStopped {
                operation_id: operation_id.clone(),
            }],
            Self::At { at_ms } => vec![FollowupSource::At { at_ms: *at_ms }],
            Self::ProcessStopped { operation_id } => vec![FollowupSource::ProcessStopped {
                operation_id: operation_id.clone(),
            }],
            Self::File { path, condition } => vec![FollowupSource::File {
                path: path.clone(),
                condition: *condition,
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
    pub(super) fn job_receipts(
        &self,
        cursor: u64,
    ) -> Vec<(&host_jobs::HostJobBinding, &str, &str, u64)> {
        match self {
            Self::JobStopped {
                binding,
                receipt_identity,
                receipt_epoch,
                ..
            } => vec![(binding, receipt_identity, receipt_epoch, cursor)],
            Self::Any { sources } | Self::All { sources } => sources
                .iter()
                .filter_map(|s| match &s.evidence {
                    FollowupLeafEvidence::JobStopped {
                        binding,
                        receipt_identity,
                        receipt_epoch,
                        ..
                    } => Some((
                        binding,
                        receipt_identity.as_str(),
                        receipt_epoch.as_str(),
                        s.trigger_cursor,
                    )),
                    _ => None,
                })
                .collect(),
            _ => vec![],
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
) -> Result<Option<(u64, FollowupLeafEvidence)>> {
    let (trigger_cursor, evidence) = match source {
        FollowupSource::File { .. }
        | FollowupSource::Artifact { .. }
        | FollowupSource::Collection { .. } => return Ok(None),
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
        FollowupSource::JobStopped { operation_id } => {
            let run: Run = record(tx, "runs", &d.source_run_id)?;
            let op = host_jobs::require_observation(tx, &run, operation_id)?;
            let Some(receipt) = op.external_receipt.as_ref().filter(|r| r.executor_stopped) else {
                return Ok(None);
            };
            host_jobs::require_stop_receipt(&op, receipt)?;
            let cursor = tx.query_row("SELECT cursor FROM events WHERE subject=?1 AND kind='operation.executor_stopped' AND json_extract(data,'$.receipt_identity')=?2 AND json_extract(data,'$.receipt_epoch')=?3 ORDER BY cursor LIMIT 1", params![op.id, receipt.identity, receipt.epoch], |r| read_number(r, 0))?;
            let binding = &op.host_job.as_ref().expect("accepted job").binding;
            let original =
                host_jobs::stop_receipt(tx, cursor, binding, &receipt.identity, &receipt.epoch)?;
            host_jobs::require_stop_receipt(&op, &original)?;
            (
                cursor,
                FollowupLeafEvidence::JobStopped {
                    binding: binding.clone(),
                    outcome: original.outcome,
                    effect: original.effect,
                    receipt_identity: original.identity,
                    receipt_epoch: original.epoch,
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
    Ok(Some((trigger_cursor, evidence)))
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AcceptedSourceFact {
    generation: u64,
    source_index: usize,
    // File facts are accepted directly here; other domains retain their original receipt cursor.
    trigger_cursor: Option<u64>,
    evidence: FollowupLeafEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_ref: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    domain_revision: Option<u64>,
}
/// This is a short Catalog receipt for an observed source fact, not the transient
/// watcher notification. The original source cursor retains its own provenance.
pub(super) fn accept_observation(
    tx: &Transaction<'_>,
    d: &mut Definition,
    index: usize,
    trigger_cursor: Option<u64>,
    evidence: FollowupLeafEvidence,
) -> Result<()> {
    accept_observation_content(tx, d, index, trigger_cursor, evidence, None, None)
}
pub(super) fn accept_observation_content(
    tx: &Transaction<'_>,
    d: &mut Definition,
    index: usize,
    trigger_cursor: Option<u64>,
    evidence: FollowupLeafEvidence,
    content_ref: Option<Value>,
    identity: Option<(String, u64)>,
) -> Result<()> {
    let accepted_cursor = event(
        tx,
        &d.id,
        d.revision,
        "followup.source_observed",
        serde_json::to_value(AcceptedSourceFact {
            generation: d.generation,
            source_index: index,
            trigger_cursor,
            evidence: evidence.clone(),
            content_ref,
            entity: identity.as_ref().map(|v| v.0.clone()),
            domain_revision: identity.map(|v| v.1),
        })?,
    )?;
    d.sources[index].observed = Some(FollowupSourceObservation {
        accepted_cursor,
        trigger_cursor: trigger_cursor.unwrap_or(accepted_cursor),
        evidence,
    });
    Ok(())
}
fn next_observation(
    db: &Connection,
    d: &Definition,
    index: usize,
) -> Result<Option<FollowupSourceEvidence>> {
    let row: Option<(u64, String)> = db
        .query_row(
            "SELECT cursor,data FROM events WHERE subject=?1 AND kind='followup.source_observed'
         AND json_extract(data,'$.generation')=?2 AND json_extract(data,'$.source_index')=?3
         AND cursor>?4 ORDER BY cursor LIMIT 1",
            params![
                d.id,
                sql_number(d.generation)?,
                sql_number(index as u64)?,
                sql_number(d.sources[index].consumed_cursor)?
            ],
            |r| Ok((read_number(r, 0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(accepted_cursor, raw)| {
        let data: AcceptedSourceFact = serde_json::from_str(&raw)?;
        Ok(FollowupSourceEvidence {
            source_index: index,
            accepted_cursor,
            trigger_cursor: data.trigger_cursor.unwrap_or(accepted_cursor),
            evidence: data.evidence,
        })
    })
    .transpose()
}
pub(super) fn observe_sources(
    tx: &Transaction<'_>,
    d: &mut Definition,
    now: u64,
) -> Result<Option<(u64, u64, TriggerEvidence)>> {
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
            if let Some((cursor, evidence)) = observe_leaf(tx, d, index, source, now)? {
                accept_observation(tx, d, index, Some(cursor), evidence)?;
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
    let mut observed = if d.repeat == FollowupRepeat::Each {
        (0..sources.len())
            .map(|index| next_observation(tx, d, index))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
    } else {
        d.sources
            .iter()
            .filter_map(|s| {
                s.observed.as_ref().map(|o| FollowupSourceEvidence {
                    source_index: s.source_index,
                    accepted_cursor: o.accepted_cursor,
                    trigger_cursor: o.trigger_cursor,
                    evidence: o.evidence.clone(),
                })
            })
            .collect::<Vec<_>>()
    };
    if observed.is_empty()
        || (matches!(d.trigger, FollowupTrigger::All { .. }) && observed.len() != sources.len())
    {
        return Ok(None);
    }
    if d.repeat == FollowupRepeat::Each && matches!(d.trigger, FollowupTrigger::Any { .. }) {
        observed.sort_by_key(|o| o.accepted_cursor);
        observed.truncate(1); // Each accepted leaf edge is an independent occurrence.
    }
    let accepted_cursor = observed
        .iter()
        .map(|s| s.accepted_cursor)
        .max()
        .expect("observed source");
    let cursor = observed
        .iter()
        .map(|s| s.trigger_cursor)
        .max()
        .expect("observed source");
    if d.repeat == FollowupRepeat::Each {
        for source in &observed {
            d.sources[source.source_index].consumed_cursor = source.accepted_cursor;
        }
    }
    let evidence = match &d.trigger {
        FollowupTrigger::Any { .. } => TriggerEvidence::Any { sources: observed },
        FollowupTrigger::All { .. } => TriggerEvidence::All { sources: observed },
        _ => match &observed[0].evidence {
            FollowupLeafEvidence::Artifact { binding, fact, gap } => TriggerEvidence::Artifact {
                binding: binding.clone(),
                fact: fact.clone(),
                gap: *gap,
            },
            FollowupLeafEvidence::Collection {
                binding,
                completion_revision,
                outcome,
                counts,
                gap,
            } => TriggerEvidence::Collection {
                binding: binding.clone(),
                completion_revision: *completion_revision,
                outcome: *outcome,
                counts: counts.clone(),
                gap: *gap,
            },
            FollowupLeafEvidence::File {
                receipt_id,
                condition,
                path,
                state,
                proof,
                position,
                gap,
                observed_at_ms,
            } => TriggerEvidence::File {
                receipt_id: receipt_id.clone(),
                condition: *condition,
                path: path.clone(),
                state: state.clone(),
                proof: *proof,
                position: position.clone(),
                gap: *gap,
                observed_at_ms: *observed_at_ms,
            },
            FollowupLeafEvidence::At {
                at_ms,
                observed_at_ms,
            } => TriggerEvidence::At {
                at_ms: *at_ms,
                observed_at_ms: *observed_at_ms,
            },
            FollowupLeafEvidence::JobStopped {
                binding,
                outcome,
                effect,
                receipt_identity,
                receipt_epoch,
            } => TriggerEvidence::JobStopped {
                binding: binding.clone(),
                outcome: *outcome,
                effect: *effect,
                receipt_identity: receipt_identity.clone(),
                receipt_epoch: receipt_epoch.clone(),
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
    Ok(Some((accepted_cursor, cursor, evidence)))
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
fn job_settled(
    db: &Connection,
    binding: &host_jobs::HostJobBinding,
    identity: &str,
    epoch: &str,
) -> Result<bool> {
    let op: Operation = record(db, "operations", &binding.operation_id)?;
    if op.host_job.as_ref().map(|link| &link.binding) != Some(binding) {
        return Err(RuntimeError::Conflict(
            "original follow-up Job binding changed".into(),
        ));
    }
    let Some(receipt) = op.external_receipt.as_ref() else {
        return Ok(false);
    };
    host_jobs::require_stop_receipt(&op, receipt)?;
    let occupied: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM resource_occupancy WHERE operation_id=?1)",
        [&op.id],
        |r| r.get(0),
    )?;
    // Business outcome may remain Unknown. Only the exact original stop fact and writers matter.
    Ok(op.phase == OperationPhase::Terminal
        && !occupied
        && receipt.executor_stopped
        && receipt.identity == identity
        && receipt.epoch == epoch)
}
fn leaf_settled(db: &Connection, evidence: &FollowupLeafEvidence) -> Result<bool> {
    match evidence {
        FollowupLeafEvidence::At { .. }
        | FollowupLeafEvidence::File { .. }
        | FollowupLeafEvidence::Artifact { .. }
        | FollowupLeafEvidence::Collection { .. } => Ok(true),
        FollowupLeafEvidence::JobStopped {
            binding,
            receipt_identity,
            receipt_epoch,
            ..
        } => job_settled(db, binding, receipt_identity, receipt_epoch),
        FollowupLeafEvidence::ProcessStopped {
            receipt_identity,
            receipt_epoch,
        } => process_settled(db, receipt_identity, receipt_epoch),
    }
}
pub(super) fn evidence_settled(db: &Connection, evidence: &TriggerEvidence) -> Result<bool> {
    match evidence {
        TriggerEvidence::JobStopped {
            binding,
            receipt_identity,
            receipt_epoch,
            ..
        } => job_settled(db, binding, receipt_identity, receipt_epoch),
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
