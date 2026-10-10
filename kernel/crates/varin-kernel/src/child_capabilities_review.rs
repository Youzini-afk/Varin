use super::*;
use varin_runtime::execution::*;
#[path = "../../varin-runtime/tests/fixtures/child_dispatch.rs"]
mod fixture;

#[test]
fn available_metadata_is_the_actual_native_directory_and_classifies_real_source_handoffs() {
    let directory = schemas();
    let metadata = descriptors();
    assert_eq!(directory.len(), metadata.len());
    for entry in &metadata {
        assert!(directory
            .iter()
            .any(|tool| tool.name == entry.name && tool.version == entry.version));
    }
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "dispatch")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::Source
    );
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "process_write")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::Physical
    );
    assert_eq!(
        metadata
            .iter()
            .find(|tool| tool.name == "question_status")
            .unwrap()
            .source_requirement,
        ChildSourceRequirement::None
    );
    for name in ["goal_report", "computer", "pi-only"] {
        assert!(select(&[name.into()]).is_err());
    }
}

#[test]
fn explicit_normal_narrowing_keeps_frozen_extensions_and_checks_exact_owning_schema() {
    let available = schemas();
    let read = available
        .iter()
        .find(|tool| tool.name == "file_read")
        .unwrap()
        .clone();
    let dispatch = available
        .iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap()
        .clone();
    let wait = available
        .iter()
        .find(|tool| tool.name == "wait_child")
        .unwrap()
        .clone();
    let f =
        fixture::Fixture::new_extended_parent_with_schemas(read.clone(), dispatch.clone(), wait);
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert!(selected
        .frozen
        .allowed_delegation
        .iter()
        .any(|tool| tool.name == "helper"));
    assert!(crate::collaboration::resolve_selection(&selected, &f.input).is_ok());
    let mut all = f.input.clone();
    all.tools = None;
    let (resolved, full) = crate::collaboration::resolve_selection(&selected, &all).unwrap();
    assert_eq!(resolved.extension_bindings, selected.extension_bindings);
    assert!(full.contains(&selected.extension_bindings[0].tool));
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
    let mut changed = read;
    changed.version = "different-owner-version".into();
    let f = fixture::Fixture::new_with_schemas(0, changed, dispatch);
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert!(crate::collaboration::resolve_selection(&selected, &f.input).is_err());
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn binding_hook_freezes_model_visible_configuration_without_changing_tool_schemas() {
    let directory = schemas();
    let read = directory
        .iter()
        .find(|tool| tool.name == "file_read")
        .unwrap()
        .clone();
    let dispatch = directory
        .iter()
        .find(|tool| tool.name == "dispatch")
        .unwrap()
        .clone();
    let f = fixture::Fixture::new_with_schemas(0, read, dispatch);
    let snapshot: RequestSnapshot = serde_json::from_value(
        f.db.capture_model_step_read("parent-request")
            .unwrap()
            .load_request()
            .unwrap(),
    )
    .unwrap();
    let mut binding = snapshot.view.binding;
    let original_tools = binding.tools.clone();
    let run = f.context.run_id.clone();
    let epoch = f.db.epoch();
    let root = f.root.clone();
    let catalog = std::sync::Arc::new(std::sync::Mutex::new(f.db));
    let hook = BindingPreparation {
        inner: std::sync::Arc::new(NoopContextPreparation),
        catalog: catalog.clone(),
    };
    let context = hook
        .prepare_binding(&run, epoch, &mut binding, &CancellationToken::default())
        .unwrap();
    assert_eq!(binding.tools, original_tools);
    assert!(binding.child_dispatch.is_some());
    assert_eq!(context.len(), 1);
    let Content::Text { text } = &context[0].content else {
        panic!("expected visible selection")
    };
    assert!(text.contains("allowed_delegation"));
    assert!(text.contains("fixture-catalog"));
    assert!(!text.contains("credential-ref"));
    assert!(!text.contains("credential-owner"));
    assert!(!text.contains("127.0.0.1"));
    let selected = catalog
        .lock()
        .unwrap()
        .capture_child_dispatch(binding.child_dispatch.as_ref().unwrap());
    assert_eq!(
        selected.load().unwrap().frozen.allowed_delegation,
        original_tools
    );
    drop(hook);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn normal_child_inherits_actual_parent_note_and_plan_declarations() {
    let native = schemas();
    let get = |name: &str| {
        native
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let mut f = fixture::Fixture::new_parent_custom(
        0,
        get("file_read"),
        get("dispatch"),
        false,
        false,
        false,
        |input, launch| {
            input.tools = None;
            launch.tools.retain(|tool| tool.name != "wait_child");
            launch
                .tools
                .extend([get("wait_child"), get("memory"), get("todo")]);
        },
    );
    let selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let (_, tools) = crate::collaboration::resolve_selection(&selected, &f.input).unwrap();
    assert_eq!(delegated(&tools), tools);
    assert!(tools.contains(&crate::memory::schema(true)));
    assert!(tools.contains(&crate::plan::schema()));
    f.launch.tools = tools.clone();
    let child = f.accept();
    let child = f.db.capture_child_read(child).load().unwrap();
    assert_eq!(child.launch.tools, tools);
    assert_eq!(
        child.selected_profile.work_mode,
        varin_runtime::catalog::dispatch::ChildWorkMode::ReadOnly
    );
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}
