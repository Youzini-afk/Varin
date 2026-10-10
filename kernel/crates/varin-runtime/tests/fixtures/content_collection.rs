//! Existing retention fixtures use the same owned maintenance pass as the production worker.
//! The closure returns admission before run(), dropping temporary Catalog mutex guards.
use varin_runtime::{ContentCollectionStatus, RuntimeError, content::ContentCollectionAdmission};
pub fn collect(admit: impl FnOnce() -> ContentCollectionAdmission) -> Result<u64, RuntimeError> {
    let report = admit().run();
    match report.status {
        ContentCollectionStatus::Completed | ContentCollectionStatus::Deferred => {
            Ok(report.removed_objects)
        }
        ContentCollectionStatus::Cancelled => {
            Err(RuntimeError::Conflict("collection cancelled".into()))
        }
        ContentCollectionStatus::Failed => Err(RuntimeError::Invalid(
            report.reason.expect("failure reason"),
        )),
    }
}
