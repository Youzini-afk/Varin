//! Trusted standalone text admission. Generation remains the original inference executor.
use super::*;
use varin_runtime::catalog::model_text::{ModelTextAdmit, ModelTextReadParams};
pub(super) fn execute(
    runtime: Arc<RunSupervisor>,
    method: &str,
    params: Value,
    cancelled: &AtomicBool,
) -> Result<Value, KernelError> {
    let owner = runtime.catalog();
    let lock = || {
        owner
            .lock()
            .map_err(|_| KernelError::Storage("Catalog owner failed".into()))
    };
    match method {
        "runtime.model_text.admit" => {
            let p: ModelTextAdmit = serde_json::from_value(params)?;
            let prep = lock()?.prepare_inference_content();
            let body = prep
                .write(&serde_json::to_value(&p.generation)?)
                .map_err(domain)?;
            if cancelled.load(Ordering::Acquire) {
                return Err(KernelError::Cancelled);
            }
            let id = lock()?.admit_model_text(&p, body).map_err(domain)?;
            Ok(json!({"requestId":id}))
        }
        "runtime.model_text.read" => {
            let p: ModelTextReadParams = serde_json::from_value(params)?;
            let read = lock()?.capture_model_text(&p.request_id);
            match read {
                Ok(read) => Ok(serde_json::to_value(read.load().map_err(domain)?)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.model_text.status" => {
            let p: ModelTextReadParams = serde_json::from_value(params)?;
            match lock()?.model_text_status(&p.request_id) {
                Ok(status) => Ok(serde_json::to_value(status)?),
                Err(varin_runtime::RuntimeError::NotFound(_)) if p.allow_missing => Ok(Value::Null),
                Err(error) => Err(domain(error)),
            }
        }
        "runtime.model_text.cancel" => {
            let p: ModelTextReadParams = serde_json::from_value(params)?;
            lock()?.cancel_model_text(&p.request_id).map_err(domain)?;
            runtime.cancel_operation_control(&p.request_id);
            Ok(serde_json::to_value(
                lock()?.model_text_status(&p.request_id).map_err(domain)?,
            )?)
        }
        _ => Err(KernelError::Protocol(
            "Unknown standalone text method".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_native_preparation_failure_is_retained_and_cancel_is_exact() {
        let root =
            std::env::temp_dir().join(format!("varin-model-text-kernel-{}", uuid::Uuid::new_v4()));
        let runtime = Arc::new(RunSupervisor::new(Catalog::open(&root).unwrap()));
        let generation = json!({"parentOperationId":"model-text:original","callerOwner":{"kind":"external","identity":"model.text.v1","epoch":"host"},"ordinal":1,
   "configuration":{"providerId":"chosen","providerFamily":"openai-responses","model":"original","endpoint":"https://never-called.invalid/v1/responses","configurationGeneration":1,"allowAnonymous":false},
   "credentialScope":{"reference":"provider:chosen","authority":"host","account":"original","generation":1},"purpose":"git-commit","systemPrompt":"Original instruction","user":"Original prompt"});
        let cancelled = AtomicBool::new(false);
        execute(runtime.clone(),"runtime.model_text.admit",json!({"key":"original","requestFingerprint":"original-input","retryOf":null,"generation":generation}),&cancelled).unwrap();
        let (output, _read) = mpsc::sync_channel(8);
        // No credential channel is initialized: the original native executor must record no dispatch.
        let credentials = crate::credential_bridge::CredentialBridge::new(output);
        super::super::inference_generation_commands::generate(
            runtime.clone(),
            credentials,
            generation,
            &cancelled,
        )
        .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let view = execute(
                runtime.clone(),
                "runtime.model_text.read",
                json!({"requestId":"model-text:original"}),
                &cancelled,
            )
            .unwrap();
            if view["inference"]["phase"] == "terminal" {
                assert_eq!(
                    view["inference"]["result"]["value"]["receipt"]["requestStarted"],
                    false
                );
                assert_eq!(
                    view["inference"]["result"]["value"]["receipt"]["localExecutorStopped"],
                    true
                );
                assert_eq!(view["retryAllowed"], true);
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        execute(
            runtime.clone(),
            "runtime.model_text.cancel",
            json!({"requestId":"model-text:original"}),
            &cancelled,
        )
        .unwrap();
        assert!(
            runtime
                .catalog()
                .lock()
                .unwrap()
                .list_threads()
                .unwrap()
                .is_empty()
        );
    }
}
