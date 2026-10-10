//! Real Catalog selections and closed boundaries; no provider request or credential lookup.
#[path = "fixtures/child_dispatch.rs"]
mod fixture;
use fixture::Fixture;
use serde_json::json;
use varin_runtime::catalog::dispatch::*;
use varin_runtime::execution::*;
use varin_runtime::*;

fn model(f: &Fixture) -> ChildModelBinding {
    let run = f.db.run(&f.context.run_id).unwrap();
    let launch = f.db.launch_intent(&run.id).unwrap().unwrap();
    ChildModelBinding {
        configuration: serde_json::from_value(run.configuration).unwrap(),
        credential_scope: launch.selection.credential_scope,
    }
}
fn install(
    f: &mut Fixture,
    model: ChildModelBinding,
    catalog: ChildDispatchCatalog,
    key: &str,
) -> serde_json::Value {
    let prepared = f.db.prepare_child_catalog(Some(catalog)).load().unwrap();
    let selected =
        f.db.select_model_prepared(
            &f.context.run_id,
            key,
            model.configuration.clone(),
            model.credential_scope.clone(),
            Some(prepared),
        )
        .unwrap();
    let epoch = f.db.epoch();
    f.db.prepare_model_selection(&selected, epoch, None)
        .unwrap();
    let snapshot: RequestSnapshot = serde_json::from_value(
        f.db.capture_model_step_read("parent-request")
            .unwrap()
            .load_request()
            .unwrap(),
    )
    .unwrap();
    let mut binding = snapshot.view.binding;
    binding.connection_identity = model.connection_identity().unwrap();
    binding.provider_family = model.configuration.provider_family.clone();
    binding.model = model.configuration.model.clone();
    binding.configuration_generation = model.configuration.configuration_generation;
    f.db.activate_model_selection(&selected, epoch, &binding)
        .unwrap();
    let prepared =
        f.db.prepare_child_dispatch_binding(&f.context.run_id, model, binding.tools)
            .unwrap()
            .load()
            .unwrap();
    f.db.bind_child_dispatch(&f.context.run_id, prepared)
        .unwrap()
        .unwrap()
}
fn preset(id: &str, model: Option<ChildModelBinding>) -> ChildPreset {
    ChildPreset {
        id: id.into(),
        name: format!("Configured {id}"),
        instructions: "Original selected instructions".into(),
        tools: vec!["file_read".into()],
        work_mode: ChildWorkMode::ReadOnly,
        model_source: if model.is_some() {
            ChildModelSource::Selected
        } else {
            ChildModelSource::Inherit
        },
        inherit_base: None,
        model,
        unavailable: None,
    }
}
fn input() -> DispatchInput {
    DispatchInput {
        task: "Perform the selected task".into(),
        preset: None,
        work_mode: None,
        tools: None,
    }
}

#[test]
fn selected_presets_freeze_real_model_and_instructions_normal_disabled_is_independent() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let parent = model(&f);
    let mut other = parent.clone();
    other.configuration.model = "selected-worker".into();
    other.configuration.model_options = Some(json!({"temperature":0}));
    let selected = preset("worker-custom", Some(other.clone()));
    let catalog = ChildDispatchCatalog {
        identity: "configuration-1".into(),
        normal_unavailable: Some(ChildCapabilityFailure {
            code: "worker_disabled".into(),
            capabilities: vec![],
        }),
        presets: vec![selected],
    };
    let reference = install(&mut f, parent, catalog, "choose-1");
    let selection = f.db.capture_child_dispatch(&reference).load().unwrap();
    assert!(selection
        .resolve(&input())
        .unwrap_err()
        .to_string()
        .contains("worker_disabled"));
    let mut request = input();
    request.preset = Some("worker-custom".into());
    let resolved = selection.resolve(&request).unwrap();
    assert_eq!(resolved.model, other);
    assert_eq!(
        resolved.profile.instructions,
        "Original selected instructions"
    );
    assert_ne!(
        resolved.model.connection_identity().unwrap(),
        model(&f).connection_identity().unwrap()
    );
    request.preset = Some("missing-preset".into());
    assert!(selection.resolve(&request).is_err());
    let root = f.root.clone();
    drop(selection);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn same_model_choice_key_preserves_first_catalog_and_original_request_never_uses_latest() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let original =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let original_ref = original.reference.clone();
    drop(original);
    let parent = model(&f);
    let catalog = ChildDispatchCatalog {
        identity: "first".into(),
        normal_unavailable: None,
        presets: vec![preset("first", None)],
    };
    let reference = install(&mut f, parent.clone(), catalog, "model-choice");
    let current =
        f.db.model_selections(&f.context.run_id)
            .unwrap()
            .active
            .unwrap();
    let changed =
        f.db.prepare_child_catalog(Some(ChildDispatchCatalog {
            identity: "later-settings".into(),
            normal_unavailable: None,
            presets: vec![preset("later", None)],
        }))
        .load()
        .unwrap();
    let replay =
        f.db.select_model_prepared(
            &f.context.run_id,
            "model-choice",
            parent.configuration,
            parent.credential_scope,
            Some(changed),
        )
        .unwrap();
    assert_eq!(replay.child_dispatch_ref, current.child_dispatch_ref);
    assert_eq!(
        f.db.capture_child_dispatch(&reference)
            .load()
            .unwrap()
            .catalog
            .identity,
        "first"
    );
    let original =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(original.reference, original_ref);
    assert_eq!(original.catalog.identity, "fixture-catalog");
    drop(original);
    let root = f.root.clone();
    drop(f);
    let db = Catalog::open(&root).unwrap();
    assert_eq!(
        db.model_selections(&current.run_id)
            .unwrap()
            .active
            .unwrap()
            .child_dispatch_ref,
        current.child_dispatch_ref
    );
    assert_eq!(
        db.capture_child_dispatch(&reference)
            .load()
            .unwrap()
            .catalog
            .identity,
        "first"
    );
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn inherited_settings_require_original_parent_basis_and_unavailable_cannot_be_narrowed_away() {
    let mut f = Fixture::new();
    f.accept();
    f.settle_exchange();
    let parent = model(&f);
    let mut inherited = preset("precise", None);
    inherited.model_source = ChildModelSource::Inherit;
    inherited.inherit_base = Some(parent.clone());
    let mut configured = parent.clone();
    configured.configuration.model_options = Some(json!({"temperature":0.1}));
    inherited.model = Some(configured);
    let mut unavailable = preset("unsupported", None);
    unavailable.tools = vec!["pi-only".into()];
    unavailable.unavailable = Some(ChildCapabilityFailure {
        code: "unsupported".into(),
        capabilities: unavailable.tools.clone(),
    });
    let catalog = ChildDispatchCatalog {
        identity: "inherit".into(),
        normal_unavailable: None,
        presets: vec![inherited, unavailable],
    };
    let reference = install(&mut f, parent.clone(), catalog.clone(), "original-model");
    let mut request = input();
    request.preset = Some("precise".into());
    assert_eq!(
        f.db.capture_child_dispatch(&reference)
            .load()
            .unwrap()
            .resolve(&request)
            .unwrap()
            .model
            .configuration
            .model_options,
        Some(json!({"temperature":0.1}))
    );
    request.preset = Some("unsupported".into());
    request.tools = Some(Vec::new());
    request.work_mode = Some(ChildWorkMode::ReadOnly);
    assert!(f
        .db
        .capture_child_dispatch(&reference)
        .load()
        .unwrap()
        .resolve(&request)
        .is_err());
    let mut new_parent = parent;
    new_parent.configuration.model = "different-actual-parent".into();
    new_parent.configuration.configuration_generation += 1;
    let new_reference = install(&mut f, new_parent, catalog, "next-model");
    request.preset = Some("precise".into());
    request.tools = None;
    assert!(f
        .db
        .capture_child_dispatch(&new_reference)
        .load()
        .unwrap()
        .resolve(&request)
        .is_err());
    assert!(f
        .db
        .capture_child_dispatch(&reference)
        .load()
        .unwrap()
        .resolve(&request)
        .is_ok());
    let root = f.root.clone();
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn normal_modes_preserve_private_text_path_and_missing_configuration_never_falls_back() {
    let f = Fixture::new();
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let mut request = input();
    request.work_mode = Some(ChildWorkMode::IsolatedWrite);
    let writable = selected.resolve(&request).unwrap();
    assert!(writable.profile.tools.contains(&"file_write".into()));
    assert!(!writable.source_delegation().process);
    request.work_mode = None;
    request.tools = Some(vec!["file_read".into()]);
    assert_eq!(
        selected.resolve(&request).unwrap().profile.work_mode,
        ChildWorkMode::ReadOnly
    );
    request.tools = Some(vec!["process_spawn".into()]);
    assert!(selected.resolve(&request).is_err());
    assert!(serde_json::from_value::<DispatchInput>(
        json!({"task":"old","model":"parent","profile":"read_only"})
    )
    .is_err());
    let mut anonymous = model(&f);
    anonymous.credential_scope = None;
    assert!(anonymous.connection_identity().is_err());
    anonymous.configuration.allow_anonymous = true;
    assert!(anonymous.connection_identity().is_ok());
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
