//! Original Catalog metric predicates, durable queues and lifecycle fences.
use super::*;
fn leaf() -> FollowupRegistrationSource {
    FollowupRegistrationSource::Metric {
        machine_id: "local".into(),
        metric: MetricKind::CpuPercent,
        gpu_uuid: None,
        predicate: MetricPredicate::Above,
        threshold: 90.into(),
    }
}
fn register(f: &mut Fixture, id: &str, all: bool) {
    let trigger = if all {
        FollowupRegistrationTrigger::All {
            sources: vec![leaf(), leaf()],
        }
    } else {
        FollowupRegistrationTrigger::Metric {
            machine_id: "local".into(),
            metric: MetricKind::CpuPercent,
            gpu_uuid: None,
            predicate: MetricPredicate::Above,
            threshold: 90.into(),
        }
    };
    let p =
        f.db.prepare_followup_registration(
            id,
            &f.run,
            FollowupRegistration {
                repeat: FollowupRepeat::Each,
                trigger,
                instruction: "Inspect original machine measurements".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_followup_registration(p).unwrap();
}
fn work(f: &Fixture, id: &str, index: usize) -> FollowupMetricWork {
    f.db.followup_metric_works(None)
        .unwrap()
        .0
        .into_iter()
        .find(|w| w.key.followup_id == id && w.key.source_index == index)
        .unwrap()
}
fn sample(w: FollowupMetricWork, revision: u64, value: Option<u64>) -> FollowupMetricObservation {
    FollowupMetricObservation {
        key: w.key,
        expected: w.metric,
        gap: false,
        snapshot: FollowupMetricSnapshot {
            identity: Some(MetricMachineIdentity {
                host_id: "host".into(),
                machine_id: "local".into(),
                kind: "local".into(),
                backend: None,
                target_host_id: None,
            }),
            machine_revision: Some(1),
            sample_revision: Some(revision),
            observed_at_ms: Some(100),
            status: if value.is_some() {
                MetricAvailability::Available
            } else {
                MetricAvailability::Missing
            },
            failure_code: value.is_none().then(|| "dimension_missing".into()),
            value: value.map(Into::into),
        },
    }
}
fn observe(f: &mut Fixture, id: &str, index: usize, revision: u64, value: Option<u64>) {
    let input = sample(work(f, id, index), revision, value);
    assert!(f.db.apply_metric_observation(input).unwrap());
}
#[test]
fn metric_edges_use_revisions_preserve_unknown_holding_and_survive_reopen() {
    let mut f = Fixture::new();
    register(&mut f, "metric", false);
    observe(&mut f, "metric", 0, 1, Some(95));
    let first =
        f.db.followup_occurrences("metric", None)
            .unwrap()
            .occurrences
            .remove(0);
    observe(&mut f, "metric", 0, 2, None);
    observe(&mut f, "metric", 0, 3, Some(99));
    assert_eq!(
        f.db.followup_occurrences("metric", None)
            .unwrap()
            .occurrences
            .len(),
        1
    );
    let mut f = f.reopen();
    let unchanged = sample(work(&f, "metric", 0), 3, Some(99));
    assert!(!f.db.apply_metric_observation(unchanged).unwrap());
    observe(&mut f, "metric", 0, 4, Some(90)); // strict comparison re-arms at equality
    let crossing = sample(work(&f, "metric", 0), 5, Some(91));
    assert!(f.db.apply_metric_observation(crossing.clone()).unwrap());
    assert!(!f.db.apply_metric_observation(crossing).unwrap());
    let all =
        f.db.followup_occurrences("metric", None)
            .unwrap()
            .occurrences;
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, first.id);
    let TriggerEvidence::Metric { fact } = &all[1].evidence else {
        panic!("metric fact")
    };
    assert_eq!(fact.sample_revision, 5);
    assert_eq!(fact.observed_at_ms, 100);
    assert_eq!(fact.value, 91.into());
    let original = f.run.clone();
    f.state(RunState::Completed);
    let runs = f.reconcile();
    assert_eq!(runs.len(), 1);
    assert_ne!(runs[0], original);
    assert_eq!(f.db.run(&original).unwrap().state, RunState::Completed);
    assert_eq!(
        f.db.launch_intent(&runs[0])
            .unwrap()
            .unwrap()
            .selection
            .source,
        f.db.launch_intent(&original)
            .unwrap()
            .unwrap()
            .selection
            .source
    );
    let next = &runs[0];
    let pending =
        f.db.prepare_input_delivery(next, f.db.epoch(), f.db.head("branch").unwrap().as_deref())
            .unwrap()
            .load()
            .unwrap();
    f.db.admit_input_delivery(pending).unwrap();
    let history = f.db.execution_history("branch").unwrap();
    for occurrence in &all {
        let items = history
            .iter()
            .filter(|item| item.id == format!("followup-input:{}", occurrence.id))
            .collect::<Vec<_>>();
        assert_eq!(items.len(), 1);
        let Content::Text { text } = &items[0].content else {
            panic!("metric continuation input")
        };
        assert!(text.contains("Inspect original machine measurements"));
        let facts: serde_json::Value = serde_json::from_str(text.lines().nth(1).unwrap()).unwrap();
        assert_eq!(
            facts["evidence"],
            serde_json::to_value(&occurrence.evidence).unwrap()
        );
        assert_eq!(facts["sourceRunId"], original);
    }
    let mut f = f.reopen();
    assert!(f.reconcile().is_empty());
    assert_eq!(
        f.db.execution_history("branch")
            .unwrap()
            .iter()
            .filter(|item| item.id.starts_with("followup-input:"))
            .count(),
        2
    );
    f.cleanup();
}
#[test]
fn metric_all_pairs_original_fifo_and_control_fences_late_samples() {
    let mut f = Fixture::new();
    register(&mut f, "all", true);
    observe(&mut f, "all", 0, 1, Some(95));
    observe(&mut f, "all", 0, 2, Some(10));
    observe(&mut f, "all", 0, 3, Some(99));
    observe(&mut f, "all", 1, 1, Some(98));
    assert_eq!(
        f.db.followup_occurrences("all", None)
            .unwrap()
            .occurrences
            .len(),
        1
    );
    let mut f = f.reopen();
    observe(&mut f, "all", 1, 2, Some(10));
    observe(&mut f, "all", 1, 3, Some(97));
    assert_eq!(
        f.db.followup_occurrences("all", None)
            .unwrap()
            .occurrences
            .len(),
        2
    );
    let late = sample(work(&f, "all", 0), 4, Some(1));
    let d = f.db.followup("all").unwrap();
    f.db.control_followup("all", d.revision, FollowupControlAction::Pause)
        .unwrap();
    assert!(!f.db.apply_metric_observation(late).unwrap());
    assert!(f.db.followup_metric_works(None).unwrap().0.is_empty());
    let d = f.db.followup("all").unwrap();
    f.db.control_followup("all", d.revision, FollowupControlAction::Resume)
        .unwrap();
    let foreign = sample(work(&f, "all", 0), 4, Some(99));
    let mut foreign = foreign;
    foreign.snapshot.identity.as_mut().unwrap().host_id = "another-host".into();
    assert!(f.db.apply_metric_observation(foreign).unwrap());
    assert_eq!(
        f.db.followup("all").unwrap().sources[0]
            .metric
            .as_ref()
            .unwrap()
            .failure_code
            .as_deref(),
        Some("source_identity_changed")
    );
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
fn metric_registration_rejects_shape_errors_and_requires_original_scope_even_with_ready_any() {
    for trigger in [
        json!({"kind":"metric","machineId":"local","metric":"cpu_percent","gpuUuid":"gpu","predicate":"above","threshold":1}),
        json!({"kind":"metric","machineId":"local","metric":"gpu_percent","predicate":"above","threshold":1}),
        json!({"kind":"metric","machineId":"local","metric":"loss","predicate":"above","threshold":1}),
        json!({"kind":"metric","machineId":"local","metric":"memory_mb","predicate":"above","threshold":1,"extra":true}),
    ] {
        let input = serde_json::from_value::<FollowupRegistration>(
            json!({"trigger":trigger,"instruction":"x"}),
        );
        assert!(input.is_err() || input.unwrap().validate().is_err());
    }
    let mut f = Fixture::with_source(serde_json::Value::Null);
    let p =
        f.db.prepare_followup_registration(
            "no-scope",
            &f.run,
            FollowupRegistration {
                repeat: FollowupRepeat::Once,
                trigger: FollowupRegistrationTrigger::Any {
                    sources: vec![FollowupRegistrationSource::At { at_ms: 0 }, leaf()],
                },
                instruction: "x".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(f.db.admit_followup_registration(p).is_err());
    f.cleanup();
}
