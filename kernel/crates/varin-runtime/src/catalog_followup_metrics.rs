//! Thresholds over original ResourceService samples. Only short observation cursors and
//! accepted edges belong to Catalog; sampling, machine identity and availability stay with the owner.
use super::*;
use serde_json::Number;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetricKind {
    CpuPercent,
    MemoryMb,
    GpuPercent,
    GpuMemoryMb,
}
impl MetricKind {
    pub fn gpu(self) -> bool {
        matches!(self, Self::GpuPercent | Self::GpuMemoryMb)
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetricPredicate {
    Above,
    Below,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetricAvailability {
    Available,
    Missing,
    Stale,
    Unavailable,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MetricMachineIdentity {
    pub host_id: String,
    pub machine_id: String,
    pub kind: String,
    pub backend: Option<String>,
    pub target_host_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupMetricState {
    pub identity: Option<MetricMachineIdentity>,
    pub sample_revision: Option<u64>,
    pub observed_at_ms: Option<u64>,
    pub status: MetricAvailability,
    pub failure_code: Option<String>,
    /// Unknown observations never reset the last known predicate.
    pub holding: Option<bool>,
    pub value: Option<Number>,
    pub gap: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupMetricSnapshot {
    pub identity: Option<MetricMachineIdentity>,
    pub machine_revision: Option<u64>,
    pub sample_revision: Option<u64>,
    pub observed_at_ms: Option<u64>,
    pub status: MetricAvailability,
    pub failure_code: Option<String>,
    pub value: Option<Number>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupMetricEvidence {
    pub identity: MetricMachineIdentity,
    pub machine_revision: u64,
    pub sample_revision: u64,
    pub observed_at_ms: u64,
    pub metric: MetricKind,
    pub gpu_uuid: Option<String>,
    pub predicate: MetricPredicate,
    pub threshold: Number,
    pub value: Number,
    pub gap: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowupMetricWork {
    pub key: FollowupResearchKey,
    pub observer: host_jobs::ResearchScope,
    pub source: FollowupSource,
    pub metric: FollowupMetricState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowupMetricObservation {
    pub key: FollowupResearchKey,
    pub expected: FollowupMetricState,
    pub snapshot: FollowupMetricSnapshot,
    pub gap: bool,
}
pub(super) fn validate_source(
    machine: &str,
    metric: MetricKind,
    gpu: Option<&str>,
    threshold: &Number,
) -> Result<()> {
    if machine.trim().is_empty()
        || metric.gpu() != gpu.is_some()
        || gpu.is_some_and(|id| id.trim().is_empty())
        || threshold.as_f64().is_none_or(|n| !n.is_finite())
    {
        return Err(RuntimeError::Invalid(
            "metric requires a machineId, finite threshold and gpuUuid only for GPU metrics".into(),
        ));
    }
    Ok(())
}
pub(super) fn scope(
    db: &Connection,
    run: &Run,
    source: Option<&launches::SourceSelection>,
) -> Result<host_jobs::ResearchScope> {
    host_jobs::scopes(db, &run.thread_id, &run.branch_id, Some(&run.id))?
        .into_iter()
        .find(|scope| Some(&scope.source) == source)
        .ok_or_else(|| {
            RuntimeError::Conflict(
                "Original machine observer source is unavailable or changed".into(),
            )
        })
}
pub(super) fn initial_state(source: &FollowupSource) -> Option<FollowupMetricState> {
    matches!(source, FollowupSource::Metric { .. }).then(|| FollowupMetricState {
        identity: None,
        sample_revision: None,
        observed_at_ms: None,
        status: MetricAvailability::Missing,
        failure_code: Some("sample_pending".into()),
        holding: None,
        value: None,
        gap: true,
    })
}
fn open(d: &Definition, index: usize) -> bool {
    d.state == FollowupState::Active
        && d.wait.state != NextRunWaitState::Cancelled
        && (d.repeat == FollowupRepeat::Each
            || (d.wait.state == NextRunWaitState::Waiting && d.sources[index].observed.is_none()))
}
fn work(db: &Connection, d: &Definition, index: usize, epoch: u64) -> Result<FollowupMetricWork> {
    let source = d
        .trigger
        .sources()
        .get(index)
        .cloned()
        .ok_or_else(|| RuntimeError::Invalid("metric source index".into()))?;
    if !matches!(source, FollowupSource::Metric { .. }) {
        return Err(RuntimeError::Invalid("not a metric source".into()));
    }
    let run: Run = record(db, "runs", &d.source_run_id)?;
    Ok(FollowupMetricWork {
        key: FollowupResearchKey {
            followup_id: d.id.clone(),
            generation: d.generation,
            source_index: index,
            definition_revision: d.revision,
            owner_epoch: epoch,
        },
        observer: scope(db, &run, d.source.as_ref())?,
        source,
        metric: d.sources[index]
            .metric
            .clone()
            .ok_or_else(|| RuntimeError::Invalid("metric observation cursor missing".into()))?,
    })
}
impl Catalog {
    pub fn followup_metric_works(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<FollowupMetricWork>, Option<String>)> {
        if self.continuation_stopping.load(Ordering::Acquire) {
            return Ok((vec![], None));
        }
        let (id, index) = after
            .map(|s| serde_json::from_str::<(String, usize)>(s))
            .transpose()?
            .unwrap_or_default();
        let mut query = self
            .db
            .prepare("SELECT body FROM followups WHERE id>=?1 ORDER BY id")?;
        let mut works = Vec::new();
        for row in query.query_map([&id], |r| r.get::<_, String>(0))? {
            let d: Definition = serde_json::from_str(&row?)?;
            if sources::exhausted(&self.db, &d)? {
                continue;
            }
            for (i, source) in d.trigger.sources().iter().enumerate() {
                if (after.is_some() && d.id == id && i <= index)
                    || !matches!(source, FollowupSource::Metric { .. })
                    || !open(&d, i)
                {
                    continue;
                }
                if works.len() == 64 {
                    let last: &FollowupMetricWork = works.last().expect("page");
                    let cursor = serde_json::to_string(&(
                        last.key.followup_id.clone(),
                        last.key.source_index,
                    ))?;
                    return Ok((works, Some(cursor)));
                }
                works.push(work(&self.db, &d, i, self.epoch)?);
            }
        }
        Ok((works, None))
    }
    pub fn apply_metric_observation(&mut self, input: FollowupMetricObservation) -> Result<bool> {
        if input.key.owner_epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire)
        {
            return Ok(false);
        }
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &input.key.followup_id)?;
        let index = input.key.source_index;
        let current = work(&tx, &d, index, self.epoch)?;
        if current.key != input.key
            || current.metric != input.expected
            || !open(&d, index)
            || sources::exhausted(&tx, &d)?
        {
            return Ok(false);
        }
        let FollowupSource::Metric {
            machine_id,
            metric,
            gpu_uuid,
            predicate,
            threshold,
        } = current.source
        else {
            unreachable!()
        };
        let snapshot = input.snapshot;
        if snapshot.identity.as_ref().is_some_and(|i| {
            i.machine_id != machine_id || i.host_id.is_empty() || i.kind.is_empty()
        }) || snapshot.machine_revision == Some(0)
            || snapshot.sample_revision == Some(0)
            || snapshot
                .value
                .as_ref()
                .is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite()))
            || (snapshot.status == MetricAvailability::Available
                && (snapshot.identity.is_none()
                    || snapshot.machine_revision.is_none()
                    || snapshot.sample_revision.is_none()
                    || snapshot.observed_at_ms.is_none()
                    || snapshot.value.is_none()
                    || snapshot.failure_code.is_some()))
        {
            return Err(RuntimeError::Invalid(
                "Metric observation is missing its original machine/sample evidence".into(),
            ));
        }
        let mut next = input.expected.clone();
        let identity_changed = next.identity.is_some()
            && snapshot.identity.is_some()
            && next.identity != snapshot.identity;
        let regressed = next
            .sample_revision
            .zip(snapshot.sample_revision)
            .is_some_and(|(old, new)| new < old);
        if identity_changed || regressed {
            next.status = MetricAvailability::Unavailable;
            next.failure_code = Some(
                if identity_changed {
                    "source_identity_changed"
                } else {
                    "sample_revision_regressed"
                }
                .into(),
            );
            next.value = None;
            next.gap = true;
        } else {
            if next.identity.is_none() {
                next.identity = snapshot.identity.clone();
            }
            next.sample_revision = snapshot.sample_revision.or(next.sample_revision);
            next.observed_at_ms = snapshot.observed_at_ms.or(next.observed_at_ms);
            next.status = snapshot.status;
            next.failure_code = snapshot.failure_code.clone();
            next.value = snapshot.value.clone();
            next.gap = input.gap
                || input
                    .expected
                    .sample_revision
                    .zip(snapshot.sample_revision)
                    .is_some_and(|(old, new)| new > old.saturating_add(1));
            if snapshot.status == MetricAvailability::Available {
                let value = snapshot
                    .value
                    .as_ref()
                    .expect("validated")
                    .as_f64()
                    .expect("finite");
                let threshold_value = threshold.as_f64().expect("validated registration");
                next.holding = Some(match predicate {
                    MetricPredicate::Above => value > threshold_value,
                    MetricPredicate::Below => value < threshold_value,
                });
            }
        }
        if next == input.expected {
            return Ok(false);
        }
        if !identity_changed
            && !regressed
            && snapshot.status == MetricAvailability::Available
            && next.holding == Some(true)
            && input.expected.holding != Some(true)
        {
            sources::accept_observation(
                &tx,
                &mut d,
                index,
                None,
                FollowupLeafEvidence::Metric {
                    fact: FollowupMetricEvidence {
                        identity: snapshot.identity.expect("validated"),
                        machine_revision: snapshot.machine_revision.expect("validated"),
                        sample_revision: snapshot.sample_revision.expect("validated"),
                        observed_at_ms: snapshot.observed_at_ms.expect("validated"),
                        metric,
                        gpu_uuid,
                        predicate,
                        threshold,
                        value: snapshot.value.expect("validated"),
                        gap: next.gap,
                    },
                },
            )?;
        }
        d.sources[index].metric = Some(next);
        put(&tx, "followups", &d.id, &d)?;
        event(
            &tx,
            &d.id,
            d.revision,
            "followup.metric_progress",
            json!({"source_index":index,"metric":d.sources[index].metric}),
        )?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        tx.commit()?;
        Ok(true)
    }
}
