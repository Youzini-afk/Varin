//! The native close result is the only admission to installation. Keeping this
//! sequence outside platform APIs lets cancellation and failure be exercised.
use std::future::Future;
#[derive(Debug)]
pub enum Failure {
    Drain(String),
    Installation(String),
}
pub async fn after_drain<F, Fut, I>(drain: F, install: I) -> Result<(), Failure>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
    I: FnOnce() -> Result<(), String>,
{
    drain().await.map_err(Failure::Drain)?;
    install().map_err(Failure::Installation)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn canceled_frontend_close_never_installs() {
        let called = Arc::new(Mutex::new(false));
        let mark = called.clone();
        assert!(
            after_drain(
                || async { Err("User kept editing".into()) },
                move || {
                    *mark.lock().unwrap() = true;
                    Ok(())
                }
            )
            .await
            .is_err()
        );
        assert!(!*called.lock().unwrap());
    }
    #[tokio::test]
    async fn actual_scope_end_must_precede_installer() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let drain = events.clone();
        let install = events.clone();
        after_drain(
            || async move {
                drain.lock().unwrap().push("scope ended");
                Ok(())
            },
            move || {
                install.lock().unwrap().push("installer");
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(*events.lock().unwrap(), vec!["scope ended", "installer"]);
    }
    #[tokio::test]
    async fn failed_scope_drain_and_failed_installer_remain_errors() {
        assert!(
            after_drain(
                || async { Err("Scope still running".into()) },
                || panic!("must not install")
            )
            .await
            .is_err()
        );
        assert!(
            after_drain(|| async { Ok(()) }, || Err("Installer refused".into()))
                .await
                .is_err()
        );
    }
}
