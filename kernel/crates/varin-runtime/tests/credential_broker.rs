use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use varin_runtime::execution::CancellationToken;
use varin_runtime::providers::{auth::*, CredentialResolver};
fn scope(reference: &str) -> CredentialScope {
    CredentialScope {
        reference: reference.into(),
        authority: "https://issuer.fixture".into(),
        account: format!("account-{reference}"),
        generation: 1,
    }
}
fn record(reference: &str) -> CredentialRecord {
    CredentialRecord {
        scope: scope(reference),
        material: CredentialMaterial::OAuth(OAuthTokens {
            access: Secret::new("expired-fixture").unwrap(),
            refresh: Secret::new("refresh-fixture").unwrap(),
            expires_at_ms: 0,
        }),
    }
}
struct Store {
    records: BTreeMap<String, Mutex<CredentialRecord>>,
    entered: Option<mpsc::Sender<String>>,
    committed: Option<mpsc::Sender<String>>,
    fail: AtomicBool,
}
impl Store {
    fn new(references: &[&str]) -> Self {
        Self {
            records: references
                .iter()
                .map(|id| (id.to_string(), Mutex::new(record(id))))
                .collect(),
            entered: None,
            committed: None,
            fail: AtomicBool::new(false),
        }
    }
}
impl CredentialStore for Store {
    fn transaction(
        &self,
        reference: &str,
        cancel: &CancellationToken,
        update: &mut dyn FnMut(&mut CredentialRecord) -> Result<(), CredentialError>,
    ) -> Result<CredentialRecord, CredentialError> {
        if let Some(tx) = &self.entered {
            let _ = tx.send(reference.into());
        }
        let record = self
            .records
            .get(reference)
            .ok_or(CredentialError::Missing)?;
        let mut held = record.lock().unwrap();
        if cancel.is_cancelled() {
            return Err(CredentialError::Cancelled);
        }
        let mut candidate = held.clone();
        update(&mut candidate)?;
        if self.fail.load(Ordering::SeqCst) {
            return Err(CredentialError::PersistenceFailed);
        }
        *held = candidate.clone();
        if let Some(tx) = &self.committed {
            let _ = tx.send(reference.into());
        }
        Ok(candidate)
    }
}
struct Refresh {
    calls: AtomicUsize,
    entered: Option<mpsc::Sender<()>>,
    release: Option<Mutex<mpsc::Receiver<()>>>,
}
impl Refresh {
    fn immediate() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            entered: None,
            release: None,
        }
    }
}
impl OAuthRefresher for Refresh {
    fn refresh(
        &self,
        scope: &CredentialScope,
        _: &OAuthTokens,
        _: Duration,
    ) -> Result<OAuthRefresh, CredentialError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = &self.entered {
            tx.send(()).unwrap();
        }
        if let Some(rx) = &self.release {
            rx.lock().unwrap().recv().unwrap();
        }
        Ok(OAuthRefresh {
            account: scope.account.clone(),
            tokens: OAuthTokens {
                access: Secret::new("rotated-fixture").unwrap(),
                refresh: Secret::new("rotated-refresh-fixture").unwrap(),
                expires_at_ms: u64::MAX,
            },
        })
    }
}
fn binding(reference: &str, refresh: Arc<Refresh>) -> CredentialBinding {
    let mut binding = CredentialBinding::bearer(scope(reference));
    binding.refresher = Some(refresh);
    binding
}
#[test]
fn same_reference_refresh_is_single_flight_and_headers_follow_commit() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (mut_store_tx, mut_store_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let mut store = Store::new(&["one"]);
    store.entered = Some(mut_store_tx);
    let store = Arc::new(store);
    let refresh = Arc::new(Refresh {
        calls: AtomicUsize::new(0),
        entered: Some(entered_tx),
        release: Some(Mutex::new(release_rx)),
    });
    let broker = Arc::new(
        CredentialBroker::new(store.clone(), vec![binding("one", refresh.clone())]).unwrap(),
    );
    let first = broker.clone();
    let one = std::thread::spawn(move || first.headers(Some("one"), &CancellationToken::default()));
    entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    mut_store_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let second = broker.clone();
    let two =
        std::thread::spawn(move || second.headers(Some("one"), &CancellationToken::default()));
    mut_store_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    release_tx.send(()).unwrap();
    for result in [one.join().unwrap(), two.join().unwrap()] {
        let headers = result.unwrap();
        assert_eq!(headers["authorization"], "Bearer rotated-fixture");
        assert!(!format!("{headers:?}").contains("rotated-fixture"));
    }
    assert_eq!(refresh.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn cancelled_waiter_does_not_discard_rotated_credentials_or_block_other_references() {
    let (start_tx, start_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (commit_tx, commit_rx) = mpsc::channel();
    let mut store = Store::new(&["slow", "fast"]);
    store.committed = Some(commit_tx);
    let store = Arc::new(store);
    let slow = Arc::new(Refresh {
        calls: AtomicUsize::new(0),
        entered: Some(start_tx),
        release: Some(Mutex::new(release_rx)),
    });
    let fast = Arc::new(Refresh::immediate());
    let broker = Arc::new(
        CredentialBroker::new(
            store.clone(),
            vec![binding("slow", slow.clone()), binding("fast", fast)],
        )
        .unwrap(),
    );
    let cancel = CancellationToken::default();
    let waiting_cancel = cancel.clone();
    let pending = broker.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        done_tx
            .send(pending.headers(Some("slow"), &waiting_cancel))
            .unwrap()
    });
    start_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let other = broker.clone();
    let (other_tx, other_rx) = mpsc::channel();
    let other_worker = std::thread::spawn(move || {
        other_tx
            .send(other.headers(Some("fast"), &CancellationToken::default()))
            .unwrap()
    });
    let other_result = other_rx.recv_timeout(Duration::from_secs(3));
    cancel.cancel();
    let cancelled = done_rx.recv_timeout(Duration::from_secs(3));
    release_tx.send(()).unwrap();
    assert!(other_result.unwrap().is_ok());
    assert_eq!(cancelled.unwrap().unwrap_err().code, "cancelled");
    waiter.join().unwrap();
    other_worker.join().unwrap();
    let mut commits = vec![
        commit_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
        commit_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
    ];
    commits.sort();
    assert_eq!(commits, vec!["fast", "slow"]);
    let saved = store.records["slow"].lock().unwrap().clone();
    assert!(
        matches!(saved.material,CredentialMaterial::OAuth(ref tokens) if tokens.refresh.expose()=="rotated-refresh-fixture")
    );
    assert_eq!(
        broker
            .headers(Some("slow"), &CancellationToken::default())
            .unwrap()["authorization"],
        "Bearer rotated-fixture"
    );
    assert_eq!(slow.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn scope_mismatch_and_store_failure_never_release_headers() {
    let store = Arc::new(Store::new(&["one"]));
    store.records["one"].lock().unwrap().scope.account = "different-account".into();
    let refresh = Arc::new(Refresh::immediate());
    let broker =
        CredentialBroker::new(store.clone(), vec![binding("one", refresh.clone())]).unwrap();
    assert_eq!(
        broker
            .headers(Some("one"), &CancellationToken::default())
            .unwrap_err()
            .code,
        "credential_scope_changed"
    );
    assert_eq!(refresh.calls.load(Ordering::SeqCst), 0);
    store.records["one"].lock().unwrap().scope = scope("one");
    store.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        broker
            .headers(Some("one"), &CancellationToken::default())
            .unwrap_err()
            .code,
        "credential_persistence_failed"
    );
    let original = store.records["one"].lock().unwrap();
    assert!(
        matches!(original.material,CredentialMaterial::OAuth(ref tokens) if tokens.access.expose()=="expired-fixture")
    );
    assert_eq!(
        broker
            .headers(Some("unregistered"), &CancellationToken::default())
            .unwrap_err()
            .code,
        "unknown_credential_ref"
    );
}
#[test]
fn oauth_registration_retains_standard_static_query_but_rejects_fragments() {
    assert!(HttpOAuthRefresher::new(
        reqwest::blocking::Client::builder(),
        "https://issuer.fixture/token?api-version=1",
        "fixture-client",
        RefreshEncoding::Form
    )
    .is_ok());
    assert!(HttpOAuthRefresher::new(
        reqwest::blocking::Client::builder(),
        "https://issuer.fixture/token#fragment",
        "fixture-client",
        RefreshEncoding::Form
    )
    .is_err());
}

#[test]
fn injected_factory_uses_authoritative_broker_without_environment_fallback() {
    use std::io::{Read, Write};
    use varin_runtime::execution::{FinishReason, RequestSnapshot, RequestView};
    use varin_runtime::{model_session, ModelSessionConfiguration};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/responses", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = [0u8; 8192];
        let size = socket.read(&mut bytes).unwrap();
        let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
        let data = format!(
            "data: {}\n\n",
            serde_json::json!({"type":"response.completed","response":{"output":[{"id":"answer","type":"message","content":[{"type":"output_text","text":"broker fixture"}]}]}})
        );
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len()).as_bytes()).unwrap();
        request
    });
    let store = Arc::new(Store::new(&["one"]));
    store.records["one"].lock().unwrap().material =
        CredentialMaterial::ApiKey(Secret::new("broker-only-fixture").unwrap());
    let broker = Arc::new(
        CredentialBroker::new(store, vec![CredentialBinding::bearer(scope("one"))]).unwrap(),
    );
    let config:ModelSessionConfiguration=serde_json::from_value(serde_json::json!({"providerFamily":"openai-responses","model":"fixture-model","endpoint":endpoint,"credentialEnvironment":"VARIN_NONEXISTENT_IGNORED_BOOTSTRAP_REF","allowAnonymous":false,"configurationGeneration":1,"maxOutputTokens":100})).unwrap();
    let start =
        model_session::bind_with_credentials(config.clone(), broker.clone(), scope("one")).unwrap();
    let identity = start.binding.connection_identity.clone();
    assert_eq!(start.binding.credential_ref.as_deref(), Some("one"));
    let mut next = config;
    next.configuration_generation = 2;
    assert_eq!(
        model_session::bind_with_credentials(next, broker, scope("one"))
            .unwrap()
            .binding
            .connection_identity,
        identity
    );
    let view = RequestView {
        request_id: "request".into(),
        run_id: "run".into(),
        origin: varin_runtime::execution::RequestOrigin::Conversation { step: 1, history_range: start.binding.history_range.clone() },
        binding: start.binding,
        history: vec![],
    };
    let serialized = start.provider.serialize(&view).unwrap();
    assert!(!serialized.to_string().contains("broker-only-fixture"));
    let result = start.provider.generate(
        &RequestSnapshot { view, serialized },
        &CancellationToken::default(),
        &mut |_| Ok(()),
    );
    assert_eq!(result.unwrap(), FinishReason::Stop);
    assert!(server
        .join()
        .unwrap()
        .contains("authorization: Bearer broker-only-fixture"));
}
