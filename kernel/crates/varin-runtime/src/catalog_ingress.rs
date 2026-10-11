//! Shared occurrence/message ingress mechanics. Domain definitions retain their own meaning;
//! this module never owns a second queue, Run, or delivery state.
use super::*;
use inputs::{InputActivation, InputOrigin, QueuedInputMetadata};

pub(super) fn hold(
    db: &Connection,
    row: &QueuedInputMetadata,
    run: Option<&Run>,
) -> Result<Option<String>> {
    match row.origin {
        InputOrigin::Followup { .. } => {
            Ok(followups::ingress_hold(db, row, run)?.map(|reason| format!("{reason:?}")))
        }
        InputOrigin::Calendar { .. } => calendar::ingress_hold(db, row, run),
        InputOrigin::ComputerRequest { .. } => computer_requests::ingress_hold(db, row),
        InputOrigin::ComputerEvent { .. } => computer_events::ingress_hold(db, row),
        _ => Ok(None),
    }
}
pub(super) fn refresh_goal(tx: &Transaction<'_>, row: &mut QueuedInputMetadata) -> Result<()> {
    followups::refresh_ingress_goal(tx, row)
}
pub(super) fn delivered(tx: &Transaction<'_>, row: &QueuedInputMetadata) -> Result<()> {
    match row.origin {
        InputOrigin::Followup { .. } => followups::delivered(tx, row),
        InputOrigin::Calendar { .. } => calendar::delivered(tx, row),
        _ => Ok(()),
    }
}
pub(super) fn insert_occurrence(
    tx: &Transaction<'_>,
    id: String,
    thread: String,
    branch: String,
    cursor: u64,
    origin: InputOrigin,
    history: &Value,
) -> Result<QueuedInputMetadata> {
    let origin_name = match origin {
        InputOrigin::Followup { .. } => "followup",
        InputOrigin::Calendar { .. } => "calendar",
        InputOrigin::ComputerRequest { .. } => "computer_request",
        InputOrigin::ComputerEvent { .. } => "computer_event",
        _ => {
            return Err(RuntimeError::Invalid(
                "occurrence input requires its actual domain origin".into(),
            ))
        }
    };
    let run_id = match &origin {
        InputOrigin::Followup { activation, .. } | InputOrigin::Calendar { activation, .. } | InputOrigin::ComputerRequest { activation, .. } | InputOrigin::ComputerEvent { activation, .. } => {
            activation.run_id().map(str::to_owned)
        }
        _ => unreachable!(),
    };
    let passive = matches!(&origin, InputOrigin::ComputerEvent { activation: activation::IngressActivationFact::Passive, .. });
    let row = QueuedInputMetadata {
        id,
        thread_id: thread,
        branch_id: branch,
        run_id,
        mode: InputMode::Boundary,
        state: InputState::Queued,
        revision: 1,
        cursor,
        origin,
        activation: if passive { InputActivation::Passive } else { InputActivation::Activating },
        delivered_cursor: None,
    };
    tx.execute("INSERT INTO input_queue(id,branch_id,run_id,mode,state,cursor,origin,activation,sender_thread_id,sender_branch_id,body) VALUES(?1,?2,?3,'boundary','queued',?4,?5,?6,NULL,NULL,?7)",params![row.id,row.branch_id,row.run_id,sql_number(cursor)?,origin_name,if passive { "passive" } else { "activating" },encode(&row)?])?;
    tx.execute(
        "INSERT INTO input_history_content(input_id,body) VALUES(?1,?2)",
        params![row.id, encode(history)?],
    )?;
    Ok(row)
}
