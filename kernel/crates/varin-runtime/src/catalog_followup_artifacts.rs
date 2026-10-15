//! Original research owners publish metadata observations; Catalog owns only accepted edges.
use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResearchCollectionOutcome {
    Done,
    Failed,
    NotStarted,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResearchArtifactCounts {
    pub available: u64,
    pub failed: u64,
    pub expired: u64,
    pub pending: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupArtifactFact {
    ArtifactAvailable {
        artifact_id: String,
        record_revision: u64,
    },
    ArtifactFailed {
        artifact_id: String,
        record_revision: u64,
    },
    ArtifactExpired {
        artifact_id: String,
        record_revision: u64,
    },
    ArtifactMissing {
        completion_revision: u64,
        outcome: ResearchCollectionOutcome,
    },
    ArtifactAbsent {
        completion_revision: u64,
        outcome: ResearchCollectionOutcome,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowupResearchKey {
    pub followup_id: String,
    pub generation: u64,
    pub source_index: usize,
    pub definition_revision: u64,
    pub owner_epoch: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowupResearchWork {
    pub key: FollowupResearchKey,
    pub binding: host_jobs::HostJobBinding,
    pub observer: host_jobs::ResearchScope,
    pub source: FollowupSource,
    pub log: Option<FollowupLogState>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowupResearchObservation {
    pub key: FollowupResearchKey,
    pub evidence: FollowupLeafEvidence,
    pub content: Value,
}
pub struct ResearchObservationPreparation {
    input: FollowupResearchObservation,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedResearchObservation {
    key: FollowupResearchKey,
    evidence: FollowupLeafEvidence,
    reference: Value,
    _publication: crate::content::ContentPublication,
}
impl ResearchObservationPreparation {
    pub fn load(self) -> Result<PreparedResearchObservation> {
        Ok(PreparedResearchObservation {
            key: self.input.key,
            evidence: self.input.evidence,
            reference: self.content.save(&self.input.content)?,
            _publication: self.publication,
        })
    }
}
pub(super) fn validate_source(
    operation: &str,
    artifact: Option<&str>,
    name: Option<&str>,
) -> Result<()> {
    if operation.trim().is_empty()
        || artifact.is_some_and(|v| v.trim().is_empty())
        || name.is_some_and(|v| v.trim().is_empty())
        || (artifact.is_some() && name.is_some())
    {
        return Err(RuntimeError::Invalid(
            "artifact source requires an accepted Job and at most one nonempty artifactId or name"
                .into(),
        ));
    }
    Ok(())
}
pub(super) fn require_target(
    db: &Connection,
    run: &Run,
    operation: &str,
) -> Result<host_jobs::HostJobBinding> {
    let op = host_jobs::require_observation(db, run, operation)?;
    let binding = op.host_job.expect("authorized accepted Job").binding;
    if !host_jobs::observation_kinds(&binding)
        .iter()
        .any(|kind| kind == "artifact")
    {
        return Err(RuntimeError::Invalid(
            "Research observation requires the original accepted research.experiment v1 Job"
                .into(),
        ));
    }
    Ok(binding)
}
pub(super) fn work(db: &Connection, d: &Definition, index: usize, epoch: u64) -> Result<FollowupResearchWork> {
    let source = d
        .trigger
        .sources()
        .get(index)
        .cloned()
        .ok_or_else(|| RuntimeError::Invalid("research source index".into()))?;
    let operation = match &source {
        FollowupSource::Artifact { operation_id, .. }
        | FollowupSource::Collection { operation_id }
        | FollowupSource::LogLiteral { operation_id, .. }
        | FollowupSource::LogEnd { operation_id, .. } => operation_id,
        _ => {
            return Err(RuntimeError::Invalid(
                "not a research observation source".into(),
            ))
        }
    };
    let run: Run = record(db, "runs", &d.source_run_id)?;
    let binding = require_target(db, &run, operation)?;
    let observer = host_jobs::scopes(db, &d.thread_id, &d.branch_id, Some(&d.source_run_id))?
        .into_iter()
        .find(|scope| Some(&scope.source) == d.source.as_ref())
        .ok_or_else(|| {
            RuntimeError::Conflict("original research observer source changed".into())
        })?;
    Ok(FollowupResearchWork {
        key: FollowupResearchKey {
            followup_id: d.id.clone(),
            generation: d.generation,
            source_index: index,
            definition_revision: d.revision,
            owner_epoch: epoch,
        },
        binding,
        observer,
        source,
        log: d.sources[index].log.clone(),
    })
}
pub(super) fn open(d: &Definition, index: usize) -> bool {
    !d.sources[index].log.as_ref().is_some_and(|l| l.ended || l.failure_code.is_some())
        && d.state == FollowupState::Active
        && d.wait.state != NextRunWaitState::Cancelled
        && (d.repeat == FollowupRepeat::Each
            || (d.wait.state == NextRunWaitState::Waiting && d.sources[index].observed.is_none()))
}
fn identity(e: &FollowupLeafEvidence) -> Result<(String, u64)> {
    let value = match e {
        FollowupLeafEvidence::Artifact { fact, .. } => match fact {
            FollowupArtifactFact::ArtifactAvailable {
                artifact_id,
                record_revision,
            }
            | FollowupArtifactFact::ArtifactFailed {
                artifact_id,
                record_revision,
            }
            | FollowupArtifactFact::ArtifactExpired {
                artifact_id,
                record_revision,
            } => (format!("artifact:{artifact_id}"), *record_revision),
            FollowupArtifactFact::ArtifactMissing {
                completion_revision,
                ..
            }
            | FollowupArtifactFact::ArtifactAbsent {
                completion_revision,
                ..
            } => ("missing".into(), *completion_revision),
        },
        FollowupLeafEvidence::Collection {
            completion_revision,
            ..
        } => ("collection".into(), *completion_revision),
        _ => {
            return Err(RuntimeError::Invalid(
                "research observation must retain its typed domain evidence".into(),
            ))
        }
    };
    if value.1 == 0 {
        return Err(RuntimeError::Invalid(
            "research record revision must be positive".into(),
        ));
    }
    Ok(value)
}
fn validate_evidence(w: &FollowupResearchWork, e: &FollowupLeafEvidence) -> Result<()> {
    let actual = match (&w.source, e) {
        (
            FollowupSource::Artifact { artifact_id, .. },
            FollowupLeafEvidence::Artifact { binding, fact, .. },
        ) => {
            if let FollowupArtifactFact::ArtifactAvailable {
                artifact_id: actual,
                ..
            }
            | FollowupArtifactFact::ArtifactFailed {
                artifact_id: actual,
                ..
            }
            | FollowupArtifactFact::ArtifactExpired {
                artifact_id: actual,
                ..
            } = fact
            {
                if actual.is_empty() || artifact_id.as_ref().is_some_and(|id| id != actual) {
                    return Err(RuntimeError::Conflict(
                        "artifact observation selector changed".into(),
                    ));
                }
            }
            if let FollowupArtifactFact::ArtifactMissing {
                outcome: ResearchCollectionOutcome::Failed,
                ..
            } = fact
            {
                return Err(RuntimeError::Invalid(
                    "failed collection proves absence of a collected record, not a missing file"
                        .into(),
                ));
            }
            binding
        }
        (FollowupSource::Collection { .. }, FollowupLeafEvidence::Collection { binding, .. }) => {
            binding
        }
        _ => {
            return Err(RuntimeError::Conflict(
                "research evidence differs from its registered leaf".into(),
            ))
        }
    };
    if actual != &w.binding {
        return Err(RuntimeError::Conflict(
            "original research Job binding changed".into(),
        ));
    }
    identity(e)?;
    Ok(())
}
fn already_observed(
    db: &Connection,
    d: &Definition,
    index: usize,
    entity: &str,
    revision: u64,
) -> Result<bool> {
    let previous:Option<i64>=db.query_row("SELECT max(json_extract(data,'$.domain_revision')) FROM events WHERE subject=?1 AND kind='followup.source_observed' AND json_extract(data,'$.generation')=?2 AND json_extract(data,'$.source_index')=?3 AND json_extract(data,'$.entity')=?4",params![d.id,sql_number(d.generation)?,sql_number(index as u64)?,entity],|r|r.get(0))?;
    Ok(previous.is_some_and(|old| revision <= old as u64))
}
impl Catalog {
    pub fn followup_research_works(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<FollowupResearchWork>, Option<String>)> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok((vec![], None));
        }
        let (id, index) = after
            .map(|s| serde_json::from_str::<(String, usize)>(s))
            .transpose()?
            .unwrap_or_default();
        let mut q = self
            .db
            .prepare("SELECT body FROM followups WHERE id>=?1 ORDER BY id")?;
        let mut works = vec![];
        for row in q.query_map([&id], |r| r.get::<_, String>(0))? {
            let d: Definition = serde_json::from_str(&row?)?;
            if sources::exhausted(&self.db, &d)? { continue; }
            for (i, source) in d.trigger.sources().iter().enumerate() {
                if (after.is_some() && d.id == id && i <= index)
                    || !matches!(
                        source,
                        FollowupSource::Artifact { .. } | FollowupSource::Collection { .. } | FollowupSource::LogLiteral { .. } | FollowupSource::LogEnd { .. }
                    )
                    || !open(&d, i)
                {
                    continue;
                }
                if works.len() == 64 {
                    let last: &FollowupResearchWork = works.last().expect("page");
                    return Ok((
                        works.clone(),
                        Some(serde_json::to_string(&(
                            last.key.followup_id.clone(),
                            last.key.source_index,
                        ))?),
                    ));
                }
                works.push(work(&self.db, &d, i, self.epoch)?);
            }
        }
        Ok((works, None))
    }
    pub fn prepare_research_observation(
        &self,
        input: FollowupResearchObservation,
    ) -> Result<Option<ResearchObservationPreparation>> {
        if input.key.owner_epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire)
        {
            return Err(RuntimeError::Conflict(
                "research observer owner changed".into(),
            ));
        }
        let d: Definition = record(&self.db, "followups", &input.key.followup_id)?;
        let current = work(&self.db, &d, input.key.source_index, self.epoch)?;
        if current.key != input.key {
            return Err(RuntimeError::Conflict(
                "research observer changed or stopped".into(),
            ));
        }
        validate_evidence(&current, &input.evidence)?;
        let (entity, revision) = identity(&input.evidence)?;
        if sources::exhausted(&self.db, &d)? || !open(&d, input.key.source_index)
            || already_observed(&self.db, &d, input.key.source_index, &entity, revision)?
        {
            return Ok(None);
        }
        Ok(Some(ResearchObservationPreparation {
            input,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }))
    }
    pub fn apply_research_observation(&mut self, p: PreparedResearchObservation) -> Result<bool> {
        if p.key.owner_epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire) {
            return Ok(false);
        }
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &p.key.followup_id)?;
        let current = work(&tx, &d, p.key.source_index, self.epoch)?;
        if current.key != p.key || !open(&d, p.key.source_index) || sources::exhausted(&tx, &d)? {
            return Ok(false);
        }
        validate_evidence(&current, &p.evidence)?;
        let (entity, revision) = identity(&p.evidence)?;
        if already_observed(&tx, &d, p.key.source_index, &entity, revision)? {
            return Ok(false);
        }
        sources::accept_observation_content(
            &tx,
            &mut d,
            p.key.source_index,
            None,
            p.evidence,
            Some(p.reference),
            Some((entity, revision)),
        )?;
        put(&tx, "followups", &d.id, &d)?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        tx.commit()?;
        Ok(true)
    }
}

pub(super) fn occurrence_fact_refs(
    db: &Connection,
    d: &Definition,
    o: &Occurrence,
) -> Result<Vec<(usize, u64, Value)>> {
    let edges = match &o.evidence {
        TriggerEvidence::Artifact { .. } | TriggerEvidence::Collection { .. } => {
            vec![(0, o.accepted_cursor)]
        }
        TriggerEvidence::Any { sources } | TriggerEvidence::All { sources } => sources
            .iter()
            .filter(|s| {
                matches!(
                    s.evidence,
                    FollowupLeafEvidence::Artifact { .. } | FollowupLeafEvidence::Collection { .. }
                )
            })
            .map(|s| (s.source_index, s.accepted_cursor))
            .collect(),
        _ => vec![],
    };
    edges.into_iter().map(|(index,cursor)| {
        let raw:String=db.query_row("SELECT json_extract(data,'$.content_ref') FROM events WHERE cursor=?1 AND subject=?2 AND kind='followup.source_observed' AND json_extract(data,'$.generation')=?3 AND json_extract(data,'$.source_index')=?4",params![sql_number(cursor)?,d.id,sql_number(o.generation)?,sql_number(index as u64)?],|r|r.get(0))?;
        Ok((index,cursor,serde_json::from_str(&raw)?))
    }).collect()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowupOccurrenceFact {
    pub source_index: usize,
    pub accepted_cursor: u64,
    pub content: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FollowupOccurrenceView {
    pub occurrence: FollowupOccurrence,
    pub facts: Vec<FollowupOccurrenceFact>,
}
pub struct FollowupOccurrenceRead {
    occurrence: FollowupOccurrence,
    refs: Vec<(usize, u64, Value)>,
    content: crate::content::ContentStore,
    _publication: crate::content::ContentPublication,
}
impl FollowupOccurrenceRead {
    pub fn load(self) -> Result<FollowupOccurrenceView> {
        Ok(FollowupOccurrenceView {
            occurrence: self.occurrence,
            facts: self
                .refs
                .into_iter()
                .map(|(source_index, accepted_cursor, reference)| {
                    Ok(FollowupOccurrenceFact {
                        source_index,
                        accepted_cursor,
                        content: self.content.load(&reference)?,
                    })
                })
                .collect::<Result<_>>()?,
        })
    }
}
impl Catalog {
    pub fn capture_followup_occurrence(
        &self,
        id: &str,
        occurrence_id: &str,
    ) -> Result<FollowupOccurrenceRead> {
        let d: Definition = record(&self.db, "followups", id)?;
        let o = occurrence(&self.db, id, occurrence_id)?;
        Ok(FollowupOccurrenceRead {
            refs: occurrence_fact_refs(&self.db, &d, &o)?,
            occurrence: project_occurrence(&self.db, &d, o)?,
            content: self.content.clone(),
            _publication: self.content.begin_publication(),
        })
    }
}
