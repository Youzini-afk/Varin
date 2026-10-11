//! Domain-owner facts exercise the real Catalog occurrence and input owners, without Host IPC.
use super::jobs::job;
use super::*;
use varin_runtime::catalog::host_jobs::HostJobBinding;
fn register(
    f: &mut Fixture,
    id: &str,
    b: &HostJobBinding,
    repeat: FollowupRepeat,
    collection: bool,
) {
    let trigger = if collection {
        FollowupRegistrationTrigger::Collection {
            operation_id: b.operation_id.clone(),
        }
    } else {
        FollowupRegistrationTrigger::Artifact {
            operation_id: b.operation_id.clone(),
            artifact_id: None,
            name: None,
        }
    };
    let p =
        f.db.prepare_followup_registration(
            id,
            &f.run,
            FollowupRegistration {
                repeat,
                trigger,
                instruction: "Read these original research facts".into(),
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
fn evidence(b: &HostJobBinding, id: &str, revision: u64) -> FollowupLeafEvidence {
    FollowupLeafEvidence::Artifact {
        binding: b.clone(),
        fact: FollowupArtifactFact::ArtifactAvailable {
            artifact_id: id.into(),
            record_revision: revision,
        },
        gap: false,
    }
}
fn accept(f: &mut Fixture, w: FollowupResearchWork, e: FollowupLeafEvidence, value: &str) -> bool {
    let Some(p) =
        f.db.prepare_research_observation(FollowupResearchObservation {
            key: w.key,
            evidence: e,
            content: json!({"original":value}),
        })
        .unwrap()
    else {
        return false;
    };
    f.db.apply_research_observation(p.load().unwrap()).unwrap()
}
fn occurrences(f: &Fixture, id: &str) -> Vec<FollowupOccurrence> {
    f.db.followup_occurrences(id, None).unwrap().occurrences
}
#[test]
fn research_revisions_deduplicate_per_entity_and_retain_exact_prepared_metadata_through_gc() {
    let mut f = Fixture::new();
    let b = job(&mut f, "research-edge", true);
    register(&mut f, "research", &b, FollowupRepeat::Each, false);
    let w = work(&f, "research", 0);
    assert!(accept(&mut f, w, evidence(&b, "a", 2), "a2"));
    let first = occurrences(&f, "research").remove(0);
    let prepared =
        f.db.capture_followup_continuations()
            .unwrap()
            .remove(0)
            .load()
            .unwrap();
    let w = work(&f, "research", 0);
    assert!(accept(&mut f, w, evidence(&b, "a", 3), "a3"));
    for revision in [3, 2, 1] {
        let w = work(&f, "research", 0);
        assert!(!accept(&mut f, w, evidence(&b, "a", revision), "stale"));
    }
    let w = work(&f, "research", 0);
    assert!(accept(&mut f, w, evidence(&b, "b", 1), "b1"));
    assert_eq!(occurrences(&f, "research").len(), 3);
    assert!(matches!(
        f.db.admit_followup_continuation(prepared).unwrap(),
        ContinuationAdmission::Admitted(_)
    ));
    let f = f.reopen();
    assert_eq!(
        f.db.prepare_content_collection(Arc::new(AtomicBool::new(false)))
            .run()
            .status,
        ContentCollectionStatus::Completed
    );
    let detail =
        f.db.capture_followup_occurrence("research", &first.id)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(detail.facts[0].content, json!({"original":"a2"}));
    let events = f.db.capture_events_read(0, 10000).unwrap().load().unwrap();
    let event = events
        .iter()
        .find(|e| e.cursor == first.accepted_cursor)
        .unwrap();
    assert!(event.data.get("content_ref").is_none());
    assert_eq!(event.data["content"]["original"], "a2");
    f.cleanup();
}
#[test]
fn research_collection_is_distinct_once_and_each_facts_are_not_job_stop_receipts() {
    let mut f = Fixture::new();
    let b = job(&mut f, "collect", true);
    register(&mut f, "once", &b, FollowupRepeat::Once, true);
    assert!(occurrences(&f, "once").is_empty());
    let w = work(&f, "once", 0);
    let key = w.key.clone();
    let e = FollowupLeafEvidence::Collection {
        binding: b.clone(),
        completion_revision: 9,
        outcome: ResearchCollectionOutcome::Failed,
        counts: ResearchArtifactCounts::default(),
        gap: false,
    };
    assert!(accept(&mut f, w, e.clone(), "failed empty collection"));
    let retry =
        f.db.prepare_research_observation(FollowupResearchObservation {
            key,
            evidence: e,
            content: json!("late"),
        })
        .unwrap();
    assert!(retry.is_none());
    assert_eq!(occurrences(&f, "once").len(), 1);
    register(&mut f, "each", &b, FollowupRepeat::Each, true);
    for revision in [9, 9, 13] {
        let w = work(&f, "each", 0);
        accept(
            &mut f,
            w,
            FollowupLeafEvidence::Collection {
                binding: b.clone(),
                completion_revision: revision,
                outcome: ResearchCollectionOutcome::Done,
                counts: ResearchArtifactCounts::default(),
                gap: false,
            },
            "collection result",
        );
    }
    assert_eq!(occurrences(&f, "each").len(), 2);
    assert!(
        f.db.operation(&b.operation_id)
            .unwrap()
            .external_receipt
            .is_none(),
        "collection observations do not manufacture executor stop"
    );
    f.cleanup();
}
#[test]
fn research_all_pairs_fifo_across_reopen_and_cancel_fences_the_original_observer() {
    let mut f = Fixture::new();
    let b = job(&mut f, "all", true);
    let p =
        f.db.prepare_followup_registration(
            "all",
            &f.run,
            FollowupRegistration {
                repeat: FollowupRepeat::Each,
                trigger: FollowupRegistrationTrigger::All {
                    sources: vec![
                        FollowupRegistrationSource::Artifact {
                            operation_id: b.operation_id.clone(),
                            artifact_id: Some("a".into()),
                            name: None,
                        },
                        FollowupRegistrationSource::Artifact {
                            operation_id: b.operation_id.clone(),
                            artifact_id: Some("b".into()),
                            name: None,
                        },
                    ],
                },
                instruction: "pair original revisions".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.admit_followup_registration(p).unwrap();
    for revision in [1, 2] {
        let w = work(&f, "all", 0);
        assert!(accept(
            &mut f,
            w,
            evidence(&b, "a", revision),
            &format!("a{revision}")
        ));
    }
    assert!(occurrences(&f, "all").is_empty());
    let mut f = f.reopen();
    let w = work(&f, "all", 1);
    assert!(accept(&mut f, w, evidence(&b, "b", 1), "b1"));
    let first = occurrences(&f, "all").remove(0);
    let detail =
        f.db.capture_followup_occurrence("all", &first.id)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(detail.facts[0].content["original"], "a1");
    let old = work(&f, "all", 1);
    let prepared =
        f.db.prepare_research_observation(FollowupResearchObservation {
            key: old.key,
            evidence: evidence(&b, "b", 2),
            content: json!("b2"),
        })
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    let d = f.db.followup("all").unwrap();
    f.db.control_followup("all", d.revision, FollowupControlAction::Pause)
        .unwrap();
    assert!(!f.db.apply_research_observation(prepared).unwrap());
    assert!(f.db.followup_research_works(None).unwrap().0.is_empty());
    let d = f.db.followup("all").unwrap();
    f.db.control_followup("all", d.revision, FollowupControlAction::Resume)
        .unwrap();
    let w = work(&f, "all", 1);
    assert!(accept(&mut f, w, evidence(&b, "b", 2), "b2"));
    assert_eq!(occurrences(&f, "all").len(), 2);
    let w = work(&f, "all", 0);
    let p =
        f.db.prepare_research_observation(FollowupResearchObservation {
            key: w.key,
            evidence: evidence(&b, "a", 3),
            content: json!("cancelled"),
        })
        .unwrap()
        .unwrap()
        .load()
        .unwrap();
    let d = f.db.followup("all").unwrap();
    f.db.control_followup("all", d.revision, FollowupControlAction::Cancel)
        .unwrap();
    assert!(!f.db.apply_research_observation(p).unwrap());
    assert!(!f.db.operation(&b.operation_id).unwrap().cancel_requested);
    f.cleanup();
}
#[test]
fn research_observation_rejects_mismatched_owner_entity_and_unaccepted_target() {
    let mut f = Fixture::new();
    let b = job(&mut f, "legal", true);
    register(&mut f, "target", &b, FollowupRepeat::Each, false);
    let mut bad = b.clone();
    bad.workspace_id = "other".into();
    let w = work(&f, "target", 0);
    assert!(f
        .db
        .prepare_research_observation(FollowupResearchObservation {
            key: w.key,
            evidence: evidence(&bad, "a", 1),
            content: json!({})
        })
        .is_err());
    let b = job(&mut f, "planned", false);
    let p =
        f.db.prepare_followup_registration(
            "planned",
            &f.run,
            FollowupRegistration {
                repeat: FollowupRepeat::Once,
                trigger: FollowupRegistrationTrigger::Collection {
                    operation_id: b.operation_id,
                },
                instruction: "do not admit".into(),
                wait: None,
            },
        )
        .unwrap()
        .load()
        .unwrap();
    assert!(f.db.admit_followup_registration(p).is_err());
    f.cleanup();
}

#[test]
fn research_metadata_continues_a_completed_root_in_a_new_run_after_reopen() {
    for collection in [false, true] {
        let mut f = Fixture::new();
        let binding = job(&mut f, "idle-root", true);
        register(
            &mut f,
            "idle-root-followup",
            &binding,
            FollowupRepeat::Once,
            collection,
        );
        let source_run = f.run.clone();
        f.state(RunState::Completed);
        let mut f = f.reopen();
        let source = work(&f, "idle-root-followup", 0);
        let fact = if collection {
            FollowupLeafEvidence::Collection {
                binding: binding.clone(),
                completion_revision: 8,
                outcome: ResearchCollectionOutcome::Done,
                counts: ResearchArtifactCounts::default(),
                gap: true,
            }
        } else {
            evidence(&binding, "original-result", 8)
        };
        assert!(accept(
            &mut f,
            source,
            fact,
            "original metadata after root completed"
        ));
        let runs = f.reconcile();
        assert_eq!(runs.len(), 1);
        assert_ne!(runs[0], source_run);
        assert_eq!(f.db.run(&source_run).unwrap().state, RunState::Completed);
        assert_eq!(
            f.db.launch_intent(&runs[0])
                .unwrap()
                .unwrap()
                .selection
                .source,
            f.db.launch_intent(&source_run)
                .unwrap()
                .unwrap()
                .selection
                .source
        );
        let occurrence =
            f.db.followup("idle-root-followup")
                .unwrap()
                .occurrence
                .unwrap();
        assert_eq!(
            occurrence.delivery.as_ref().unwrap().run_id.as_ref(),
            Some(&runs[0])
        );
        let history = f.db.execution_history("branch").unwrap();
        assert!(serde_json::to_string(&history)
            .unwrap()
            .contains("original metadata after root completed"));
        assert!(f
            .db
            .operation(&binding.operation_id)
            .unwrap()
            .external_receipt
            .is_none());
        f.cleanup();
    }
}
