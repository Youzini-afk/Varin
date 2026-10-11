//! Original ordinary-tool and Wait consumers, with explicit domain log receipts.
use super::*;
use varin_runtime::catalog::followups::*;
use varin_runtime::OperationPhase;
#[test]
fn real_child_log_waits_settle_matches_or_exhaustion_once_from_both_origins() {
    for model in [true, false] {
        for (matched, failed_original_run) in [(true, false), (false, false), (false, true)] {
            let f = Fixture::with_tools(
                false,
                vec![crate::followup_tools::schema()],
                vec!["follow_up".into()],
            );
            let job = accepted_family_job(&f, "log-wait");
            let repeat = if failed_original_run { "once" } else { "each" };
            wait_review::waiting(
                &f,
                model,
                vec![ToolCall {
                    call_id: "await-log".into(),
                    name: "follow_up".into(),
                    schema_version: crate::followup_tools::schema().version,
                    arguments: json!({"action":"register","repeat":repeat,"trigger":{"kind":"log_literal","operationId":job.operation_id,"stream":"stdout","literal":"aba"},"instruction":"Inspect original matching log bytes","wait":{}}),
                }],
            );
            let owner = f.catalog();
            let mut db = owner.lock().unwrap();
            let mut work = db.followup_research_works(None).unwrap().0.remove(0);
            let id = work.key.followup_id.clone();
            let observation = db.followup(&id).unwrap().observation.unwrap();
            assert!(observation.delivery_pending);
            assert!(!observation.delivered);
            if failed_original_run {
                let epoch = db.epoch();
                db.commit_execution(
                    &f.run.id,
                    epoch,
                    &ExecutionRecord::StateChanged {
                        state: RunState::Failed,
                        waiting_on: None,
                    },
                )
                .unwrap();
                assert!(db.capture_followup_waits().unwrap().is_empty());
                assert_eq!(
                    db.operation(&observation.operation_id).unwrap().phase,
                    OperationPhase::Terminal
                );
            }
            if matched {
                let expected = work.log.clone().unwrap();
                assert!(db
                    .apply_log_observation(FollowupLogObservation {
                        key: work.key.clone(),
                        binding: job.clone(),
                        expected,
                        next: FollowupLogState {
                            offset: 3,
                            matched_prefix: 1,
                            ended: false,
                            failure_code: None
                        },
                        evidence: Some(FollowupLogEvidence::LogLiteral {
                            binding: job.clone(),
                            stream: LogStream::Stdout,
                            start_offset: 0,
                            end_offset: 3,
                            published_bytes: 3,
                            job_revision: 2
                        })
                    })
                    .unwrap());
                // Deliberately do not reconcile the original Wait between match and EOF.
                work = db.followup_research_works(None).unwrap().0.remove(0);
            }
            let expected = work.log.unwrap();
            assert!(db
                .apply_log_observation(FollowupLogObservation {
                    key: work.key,
                    binding: job.clone(),
                    next: FollowupLogState {
                        ended: true,
                        ..expected.clone()
                    },
                    expected,
                    evidence: None
                })
                .unwrap());
            let projection = db.followup(&id).unwrap();
            let observation = projection.observation.unwrap();
            assert_eq!(observation.delivery_pending, !failed_original_run);
            assert!(!observation.delivered);
            assert_eq!(
                observation.state,
                if failed_original_run {
                    observation::FollowupObservationState::Cancelled
                } else if matched {
                    observation::FollowupObservationState::Triggered
                } else {
                    observation::FollowupObservationState::Exhausted
                }
            );
            assert_eq!(projection.occurrence.is_some(), matched);
            assert!(projection.exhausted);
            assert_eq!(projection.pending_occurrences, usize::from(matched) as u64);
            drop(db);
            drop(owner);
            f.assembly.runtime.reconcile_observations().unwrap();
            let owner = f.catalog();
            let db = owner.lock().unwrap();
            let definition = db.followup(&id).unwrap();
            let observation = definition.observation.unwrap();
            assert_eq!(observation.delivered, !failed_original_run);
            assert!(!observation.delivery_pending);
            let history = db.execution_history(&f.run.branch_id).unwrap();
            let results = history
                .iter()
                .filter(|i| i.id.starts_with("followup-observation-result:"))
                .collect::<Vec<_>>();
            assert_eq!(results.len(), usize::from(!failed_original_run));
            if let Some(result) = results.first() {
                let text = serde_json::to_string(result).unwrap();
                assert!(text.contains(if matched { "triggered" } else { "exhausted" }));
            }
            assert!(!db.operation(&job.operation_id).unwrap().cancel_requested);
            drop(db);
            drop(owner);
            let f = f.reopen();
            f.assembly.runtime.reconcile_observations().unwrap();
            let owner = f.catalog();
            let db = owner.lock().unwrap();
            assert_eq!(
                db.execution_history(&f.run.branch_id)
                    .unwrap()
                    .iter()
                    .filter(|i| i.id.starts_with("followup-observation-result:"))
                    .count(),
                usize::from(!failed_original_run)
            );
            let observation = db.followup(&id).unwrap().observation.unwrap();
            assert_eq!(observation.delivered, !failed_original_run);
            assert!(!observation.delivery_pending);
            drop(db);
            drop(owner);
            f.finish();
        }
    }
}
