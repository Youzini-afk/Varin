//! Cursor receipts for original research log bytes. The domain reader/matcher works
//! outside Catalog; each transaction advances one cursor and at most one source edge.
use super::*;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FollowupLogState {
    pub offset: u64,
    pub matched_prefix: u64,
    pub ended: bool,
    pub failure_code: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FollowupLogEvidence {
    LogLiteral {
        binding: host_jobs::HostJobBinding,
        stream: LogStream,
        start_offset: u64,
        end_offset: u64,
        published_bytes: u64,
        job_revision: u64,
    },
    LogEnd {
        binding: host_jobs::HostJobBinding,
        stream: LogStream,
        published_bytes: u64,
        job_revision: Option<u64>,
        attempt_revision: u64,
    },
}
impl From<FollowupLogEvidence> for FollowupLeafEvidence {
    fn from(value: FollowupLogEvidence) -> Self {
        match value {
            FollowupLogEvidence::LogLiteral {
                binding,
                stream,
                start_offset,
                end_offset,
                published_bytes,
                job_revision,
            } => Self::LogLiteral {
                binding,
                stream,
                start_offset,
                end_offset,
                published_bytes,
                job_revision,
            },
            FollowupLogEvidence::LogEnd {
                binding,
                stream,
                published_bytes,
                job_revision,
                attempt_revision,
            } => Self::LogEnd {
                binding,
                stream,
                published_bytes,
                job_revision,
                attempt_revision,
            },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FollowupLogObservation {
    pub key: FollowupResearchKey,
    pub binding: host_jobs::HostJobBinding,
    pub expected: FollowupLogState,
    pub next: FollowupLogState,
    pub evidence: Option<FollowupLogEvidence>,
}
pub(super) fn initial_state(source: &FollowupSource) -> Option<FollowupLogState> {
    let offset = match source {
        FollowupSource::LogLiteral { from_offset, .. } => *from_offset,
        FollowupSource::LogEnd { .. } => 0,
        _ => return None,
    };
    Some(FollowupLogState {
        offset,
        matched_prefix: 0,
        ended: false,
        failure_code: None,
    })
}
impl Catalog {
    pub fn apply_log_observation(&mut self, input: FollowupLogObservation) -> Result<bool> {
        if input.key.owner_epoch != self.epoch || self.continuation_stopping.load(Ordering::Acquire)
        {
            return Ok(false);
        }
        let tx = self.db.transaction()?;
        let mut d: Definition = record(&tx, "followups", &input.key.followup_id)?;
        let current = artifacts::work(&tx, &d, input.key.source_index, self.epoch)?;
        let index = input.key.source_index;
        if current.key != input.key
            || sources::exhausted(&tx, &d)?
            || !artifacts::open(&d, index)
            || current.log.as_ref() != Some(&input.expected)
        {
            return Ok(false);
        }
        if input.binding != current.binding {
            return Err(RuntimeError::Conflict(
                "Original log Job binding changed".into(),
            ));
        }
        let (stream, literal_bytes, from_offset) = match current.source {
            FollowupSource::LogLiteral {
                stream,
                literal_bytes,
                from_offset,
                ..
            } => (stream, Some(literal_bytes), from_offset),
            FollowupSource::LogEnd { stream, .. } => (stream, None, 0),
            _ => return Err(RuntimeError::Invalid("Not a log observation source".into())),
        };
        if input.next.offset < input.expected.offset
            || input.expected.ended
            || input.next.matched_prefix > input.next.offset.saturating_sub(from_offset)
            || literal_bytes.map_or(input.next.matched_prefix != 0, |n| {
                input.next.matched_prefix >= n
            })
            || (input.next.offset == input.expected.offset
                && input.next.matched_prefix != input.expected.matched_prefix)
            || (input.next.failure_code.is_some()
                && (input.next.offset != input.expected.offset
                    || input.next.matched_prefix != input.expected.matched_prefix
                    || input.next.ended
                    || input.evidence.is_some()))
        {
            return Err(RuntimeError::Invalid(
                "Log progress differs from its original byte cursor".into(),
            ));
        }
        if let Some(evidence) = &input.evidence {
            match evidence {
                FollowupLogEvidence::LogLiteral {
                    binding,
                    stream: actual,
                    start_offset,
                    end_offset,
                    published_bytes,
                    job_revision,
                } if binding == &current.binding
                    && *actual == stream
                    && literal_bytes == end_offset.checked_sub(*start_offset)
                    && *start_offset >= from_offset
                    && *end_offset == input.next.offset
                    && *end_offset > input.expected.offset
                    && *end_offset <= *published_bytes
                    && *job_revision > 0
                    && !input.next.ended =>
                {
                    ()
                }
                FollowupLogEvidence::LogEnd {
                    binding,
                    stream: actual,
                    published_bytes,
                    job_revision,
                    attempt_revision,
                } if binding == &current.binding
                    && *actual == stream
                    && literal_bytes.is_none()
                    && input.next.ended
                    && *published_bytes == input.next.offset
                    && *attempt_revision > 0
                    && job_revision.is_none_or(|r| r > 0) =>
                {
                    ()
                }
                _ => {
                    return Err(RuntimeError::Invalid(
                        "Log evidence differs from the registered condition or byte range".into(),
                    ))
                }
            }
        } else if literal_bytes.is_none() && input.next.ended {
            return Err(RuntimeError::Invalid(
                "Log end requires its original drained-output fact".into(),
            ));
        }
        if input.expected == input.next && input.evidence.is_none() {
            return Ok(false);
        }
        d.sources[index].log = Some(input.next);
        if let Some(evidence) = input.evidence {
            sources::accept_observation(&tx, &mut d, index, None, evidence.into())?;
        }
        put(&tx, "followups", &d.id, &d)?;
        event(
            &tx,
            &d.id,
            d.revision,
            "followup.log_progress",
            json!({"source_index":index,"log":d.sources[index].log}),
        )?;
        observe(&tx, &mut d, observations::wall_time_ms()?)?;
        observation::exhausted(&tx, &d)?;
        tx.commit()?;
        Ok(true)
    }
}
