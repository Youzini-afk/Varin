//! Actual child assembly, frozen directories and original Model/Policy Wait consumers.
use super::*;
use varin_runtime::catalog::followups::*;
#[test]
fn real_child_metric_waits_use_both_origins_and_deliver_the_first_edge_once() {
    for model in [true, false] {
        let f = Fixture::with_tools(
            false,
            vec![crate::followup_tools::schema()],
            vec!["follow_up".into()],
        );
        wait_review::waiting(
            &f,
            model,
            vec![ToolCall {
                call_id: "await-metric".into(),
                name: "follow_up".into(),
                schema_version: crate::followup_tools::schema().version,
                arguments: json!({"action":"register","repeat":"each","trigger":{"kind":"metric","machineId":"local","metric":"cpu_percent","predicate":"above","threshold":90},"instruction":"Inspect original machine pressure","wait":{}}),
            }],
        );
        let owner = f.catalog();
        let mut db = owner.lock().unwrap();
        let w = db.followup_metric_works(None).unwrap().0.remove(0);
        let id = w.key.followup_id.clone();
        assert!(
            matches!(
                db.followup(&id).unwrap().actor,
                FollowupActor::Agent {
                    origin: ToolOrigin::ModelStep { .. },
                    ..
                }
            ) == model
        );
        assert!(
            db.apply_metric_observation(FollowupMetricObservation {
                key: w.key,
                expected: w.metric,
                gap: false,
                snapshot: FollowupMetricSnapshot {
                    identity: Some(MetricMachineIdentity {
                        host_id: "host".into(),
                        machine_id: "local".into(),
                        kind: "local".into(),
                        backend: None,
                        target_host_id: None
                    }),
                    machine_revision: Some(1),
                    sample_revision: Some(1),
                    observed_at_ms: Some(1),
                    status: MetricAvailability::Available,
                    failure_code: None,
                    value: Some(99.into())
                }
            })
            .unwrap()
        );
        drop(db);
        drop(owner);
        f.assembly.runtime.reconcile_observations().unwrap();
        let owner = f.catalog();
        let db = owner.lock().unwrap();
        assert!(db.followup(&id).unwrap().observation.unwrap().delivered);
        assert_eq!(
            db.execution_history(&f.run.branch_id)
                .unwrap()
                .iter()
                .filter(|i| i.id.starts_with("followup-observation-result:"))
                .count(),
            1
        );
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
            1
        );
        drop(db);
        drop(owner);
        f.finish();
    }
}
