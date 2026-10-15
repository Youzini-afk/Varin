//! Byte cursor receipts exercise real Catalog queues, recovery and input delivery.
use super::jobs::job;
use super::*;
use varin_runtime::catalog::host_jobs::HostJobBinding;
fn literal(b: &HostJobBinding) -> FollowupRegistrationSource {
    FollowupRegistrationSource::LogLiteral {
        operation_id: b.operation_id.clone(),
        stream: LogStream::Stdout,
        literal: "aba".into(),
        from_offset: None,
    }
}
fn register(
    f: &mut Fixture,
    id: &str,
    trigger: FollowupRegistrationTrigger,
    repeat: FollowupRepeat,
) {
    let p =
        f.db.prepare_followup_registration(
            id,
            &f.run,
            FollowupRegistration {
                trigger,
                repeat,
                instruction: "Read the exact original log range".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_followup_registration(p).unwrap();
}
fn work(f: &Fixture, id: &str, index: usize) -> FollowupResearchWork {
    f.db.followup_research_works(None)
        .unwrap()
        .0
        .into_iter()
        .find(|w| w.key.followup_id == id && w.key.source_index == index)
        .unwrap()
}
fn hit(w: FollowupResearchWork, start: u64, end: u64, prefix: u64) -> FollowupLogObservation {
    FollowupLogObservation {
        key: w.key,
        binding: w.binding.clone(),
        expected: w.log.unwrap(),
        next: FollowupLogState {
            offset: end,
            matched_prefix: prefix,
            ended: false,
            failure_code: None,
        },
        evidence: Some(FollowupLogEvidence::LogLiteral {
            binding: w.binding,
            stream: LogStream::Stdout,
            start_offset: start,
            end_offset: end,
            published_bytes: 20,
            job_revision: 2,
        }),
    }
}
fn end(w: FollowupResearchWork) -> FollowupLogObservation {
    let expected = w.log.unwrap();
    FollowupLogObservation {
        key: w.key,
        binding: w.binding,
        next: FollowupLogState {
            ended: true,
            ..expected.clone()
        },
        expected,
        evidence: None,
    }
}
#[test]
fn overlapping_log_edges_commit_the_cursor_and_occurrence_together_and_reopen_mid_page() {
    let mut f = Fixture::new();
    let b = job(&mut f, "logs", true);
    register(
        &mut f,
        "logs",
        FollowupRegistrationTrigger::Any {
            sources: vec![literal(&b)],
        },
        FollowupRepeat::Each,
    );
    let first = hit(work(&f, "logs", 0), 0, 3, 1);
    assert!(f.db.apply_log_observation(first.clone()).unwrap());
    assert!(!f.db.apply_log_observation(first).unwrap());
    let mut f = f.reopen();
    assert_eq!(work(&f, "logs", 0).log.as_ref().unwrap().offset, 3);
    assert!(f
        .db
        .apply_log_observation(hit(work(&f, "logs", 0), 2, 5, 1))
        .unwrap());
    let last = end(work(&f, "logs", 0));
    assert!(f.db.apply_log_observation(last).unwrap());
    assert!(f.db.followup("logs").unwrap().exhausted);
    assert_eq!(
        f.db.followup_occurrences("logs", None)
            .unwrap()
            .occurrences
            .len(),
        2
    );
    let prepared = f.db.capture_followup_continuations().unwrap();
    for capture in prepared {
        f.db.admit_followup_continuation(capture.load().unwrap())
            .unwrap();
    }
    assert_eq!(
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        ContentCollectionStatus::Completed
    );
    let detail = f.db.capture_followup("logs").unwrap().load().unwrap();
    assert!(serde_json::to_string(&detail.registration_trigger)
        .unwrap()
        .contains("aba"));
    assert!(!serde_json::to_string(&detail.followup)
        .unwrap()
        .contains("\"literal\""));
    f.cleanup();
}
#[test]
fn ended_all_leaf_keeps_queued_facts_until_the_original_fifo_pairs_are_consumed() {
    let mut f = Fixture::new();
    let b = job(&mut f, "all-logs", true);
    register(
        &mut f,
        "all",
        FollowupRegistrationTrigger::All {
            sources: vec![literal(&b), literal(&b)],
        },
        FollowupRepeat::Each,
    );
    f.db.apply_log_observation(hit(work(&f, "all", 0), 0, 3, 1))
        .unwrap();
    f.db.apply_log_observation(hit(work(&f, "all", 0), 2, 5, 1))
        .unwrap();
    f.db.apply_log_observation(end(work(&f, "all", 0))).unwrap();
    assert!(!f.db.followup("all").unwrap().exhausted);
    let mut f = f.reopen();
    f.db.apply_log_observation(hit(work(&f, "all", 1), 0, 3, 1))
        .unwrap();
    assert!(!f.db.followup("all").unwrap().exhausted);
    f.db.apply_log_observation(hit(work(&f, "all", 1), 2, 5, 1))
        .unwrap();
    assert!(f.db.followup("all").unwrap().exhausted);
    assert_eq!(
        f.db.followup_occurrences("all", None)
            .unwrap()
            .occurrences
            .len(),
        2
    );
    f.cleanup();
}
#[test]
fn log_late_pages_are_fenced_and_resume_retries_failure_without_rewinding() {
    let mut f = Fixture::new();
    let b = job(&mut f, "fences", true);
    register(
        &mut f,
        "fences",
        FollowupRegistrationTrigger::Any {
            sources: vec![literal(&b)],
        },
        FollowupRepeat::Each,
    );
    let stale = hit(work(&f, "fences", 0), 0, 3, 1);
    let paused =
        f.db.control_followup("fences", 1, FollowupControlAction::Pause)
            .unwrap();
    assert!(!f.db.apply_log_observation(stale.clone()).unwrap());
    f.db.control_followup("fences", paused.revision, FollowupControlAction::Resume)
        .unwrap();
    let mut failed = hit(work(&f, "fences", 0), 0, 3, 1);
    failed.next = FollowupLogState {
        failure_code: Some("source_unavailable".into()),
        ..failed.expected.clone()
    };
    failed.evidence = None;
    f.db.apply_log_observation(failed).unwrap();
    assert!(f.db.followup_research_works(None).unwrap().0.is_empty());
    let revision = f.db.followup("fences").unwrap().revision;
    f.db.control_followup("fences", revision, FollowupControlAction::Resume)
        .unwrap();
    assert_eq!(work(&f, "fences", 0).log.as_ref().unwrap().offset, 0);
    let old = hit(work(&f, "fences", 0), 0, 3, 1);
    let mut f = f.reopen();
    assert!(!f.db.apply_log_observation(old).unwrap());
    f.db.apply_log_observation(hit(work(&f, "fences", 0), 0, 3, 1))
        .unwrap();
    let late = hit(work(&f, "fences", 0), 2, 5, 1);
    let revision = f.db.followup("fences").unwrap().revision;
    f.db.control_followup("fences", revision, FollowupControlAction::Cancel)
        .unwrap();
    assert!(!f.db.apply_log_observation(late).unwrap());
    assert!(!f.db.operation(&b.operation_id).unwrap().cancel_requested);
    f.cleanup();
}
#[test]
fn literal_from_beyond_final_end_exhausts_without_rewinding_or_creating_an_occurrence() {
    let mut f = Fixture::new();
    let b = job(&mut f, "short-log", true);
    register(
        &mut f,
        "short",
        FollowupRegistrationTrigger::LogLiteral {
            operation_id: b.operation_id,
            stream: LogStream::Stderr,
            literal: "needle".into(),
            from_offset: Some(100),
        },
        FollowupRepeat::Once,
    );
    let mut before_start = hit(work(&f, "short", 0), 95, 101, 0);
    if let Some(FollowupLogEvidence::LogLiteral {
        stream,
        published_bytes,
        ..
    }) = &mut before_start.evidence
    {
        *stream = LogStream::Stderr;
        *published_bytes = 120;
    }
    assert!(f.db.apply_log_observation(before_start).is_err());
    f.db.apply_log_observation(end(work(&f, "short", 0)))
        .unwrap();
    let actual = f.db.followup("short").unwrap();
    assert!(actual.exhausted);
    assert!(actual.occurrence.is_none());
    assert_eq!(actual.sources[0].log.as_ref().unwrap().offset, 100);
    let f = f.reopen();
    assert!(f.db.followup("short").unwrap().exhausted);
    f.cleanup();
}

#[test]
fn exhausted_mixed_all_releases_original_file_watch_and_rejects_late_domain_pages() {
    let mut f = Fixture::new();
    let b = job(&mut f, "mixed", true);
    super::files::register_file_repeating(
        &mut f,
        "mixed",
        FollowupRegistrationTrigger::All {
            sources: vec![
                literal(&b),
                FollowupRegistrationSource::File {
                    path: "out".into(),
                    condition: FileCondition::Changed,
                },
                FollowupRegistrationSource::Artifact {
                    operation_id: b.operation_id.clone(),
                    artifact_id: None,
                    name: None,
                },
            ],
        },
        super::files::body("before"),
        false,
        FollowupRepeat::Each,
    );
    let stale_file = super::files::work(&f, "mixed", 1);
    let stale_artifact = work(&f, "mixed", 2);
    let prepared =
        f.db.prepare_research_observation(FollowupResearchObservation {
            key: stale_artifact.key,
            evidence: FollowupLeafEvidence::Artifact {
                binding: b.clone(),
                fact: FollowupArtifactFact::ArtifactAvailable {
                    artifact_id: "late".into(),
                    record_revision: 1,
                },
                gap: false,
            },
            content: json!({"original":"late fact"}),
        })
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    f.db.apply_log_observation(end(work(&f, "mixed", 0)))
        .unwrap();
    assert!(f.db.followup("mixed").unwrap().exhausted);
    assert!(f.db.followup_research_works(None).unwrap().0.is_empty());
    assert!(!f.db.apply_research_observation(prepared).unwrap());
    assert!(!f
        .db
        .apply_file_observation(
            &stale_file,
            super::files::update(&stale_file, super::files::body("late"), 1, true, false)
        )
        .unwrap());
    let release = super::files::work(&f, "mixed", 1);
    assert!(release.release_required);
    f.db.confirm_file_observation_released(&release.key)
        .unwrap();
    assert!(f.db.followup_file_works(None).unwrap().0.is_empty());
    assert!(f
        .db
        .followup_occurrences("mixed", None)
        .unwrap()
        .occurrences
        .is_empty());
    f.cleanup();
}

#[test]
fn impossible_log_all_removes_its_clock_deadline_without_observing_more_facts() {
    let mut f = Fixture::new();
    let b = job(&mut f, "clock", true);
    register(
        &mut f,
        "clock",
        FollowupRegistrationTrigger::All {
            sources: vec![
                literal(&b),
                FollowupRegistrationSource::At {
                    at_ms: u64::MAX / 2_000_000,
                },
            ],
        },
        FollowupRepeat::Once,
    );
    assert!(f.db.nearest_followup_deadline().unwrap().is_some());
    f.db.apply_log_observation(end(work(&f, "clock", 0)))
        .unwrap();
    assert!(f.db.nearest_followup_deadline().unwrap().is_none());
    f.db.reconcile_followup_facts_at(u64::MAX).unwrap();
    assert!(f.db.followup("clock").unwrap().occurrence.is_none());
    assert!(f.db.followup("clock").unwrap().sources[1]
        .observed
        .is_none());
    f.cleanup();
}
