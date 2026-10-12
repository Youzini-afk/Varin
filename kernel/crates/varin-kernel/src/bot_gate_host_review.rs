//! Original BotService gate writes and same-Host scoped-grant epoch invalidation.
use super::web_domain_review::{Fixture, Host, EPOCH, HOST};
use super::*;
use crate::host_tools::ToolBridge;
use crate::storage::Storage;
use std::time::{Duration, Instant};
fn receive(f: &mut Fixture, epoch: &str, kind: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        assert!(Instant::now() < deadline, "Bot gate Host did not settle");
        if let Some(frame) = f.pump_epoch(epoch) {
            assert_eq!(frame["kind"], kind, "{frame}");
            return frame;
        }
    }
}
#[test]
fn bot_service_publishes_original_lifecycle_and_refreshes_same_instance_grant_after_epoch_loss() {
    let root = std::env::temp_dir().join(format!("varin-bot-gate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let catalog_root = root.join("catalog");
    let storage_root = root.join("storage");
    let runtime = Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap()));
    let (send, outgoing) = mpsc::sync_channel(64);
    let bridge = ToolBridge::new(send.into());
    bridge.initialize(EPOCH);
    let mut f = Fixture {
        host: Host::with_script(
            "packages/web/application-host/lib/kernel/bot-gate-host.test-helper.ts",
        ),
        runtime,
        storage: Mutex::new(Storage::open(&storage_root, HOST).unwrap()),
        storage_root: storage_root.clone(),
        bridge,
        outgoing,
    };
    f.host.send(
        json!({"kind":"fixture-initialize","epoch":EPOCH,"root":root,"storageRoot":storage_root}),
    );
    let first = receive(&mut f, EPOCH, "fixture-prepared");
    let bot = first["bot"]["id"].as_str().unwrap().to_string();
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("bot-main", "main", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-sleep"}));
    receive(&mut f, EPOCH, "fixture-stop-entered");
    assert!(f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("sleep-blocked", "sleep-blocked", &bot)
        .is_err());
    f.host.send(json!({"kind":"fixture-release-stop"}));
    receive(&mut f, EPOCH, "fixture-asleep");
    f.host.send(json!({"kind":"fixture-wake"}));
    receive(&mut f, EPOCH, "fixture-awake");
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("wake-open", "wake-open", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-preparation-drain"}));
    receive(&mut f, EPOCH, "fixture-preparation-drained");
    f.runtime.shutdown().unwrap();
    let old = std::mem::replace(
        &mut f.runtime,
        Arc::new(RunSupervisor::new(
            Catalog::open(root.join("replacement")).unwrap(),
        )),
    );
    drop(old);
    f.runtime = Arc::new(RunSupervisor::new(Catalog::open(&catalog_root).unwrap()));
    assert!(f
        .runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("epoch-blocked", "epoch-blocked", &bot)
        .is_err());
    let second = "bot-gate-second-epoch";
    f.host
        .send(json!({"kind":"fixture-reset-epoch","epoch":second}));
    let restored = receive(&mut f, second, "fixture-republished");
    assert_eq!(restored["bot"]["id"], bot);
    assert_eq!(restored["bot"]["entrySessionId"], Value::Null);
    f.runtime
        .catalog()
        .lock()
        .unwrap()
        .create_bot_thread("epoch-open", "epoch-open", &bot)
        .unwrap();
    f.host.send(json!({"kind":"fixture-close"}));
    receive(&mut f, second, "fixture-closed");
    f.runtime.shutdown().unwrap();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
