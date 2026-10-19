use super::*;
use varin_runtime::execution::*;
fn with_disclosure(mut tools: Vec<ToolSchema>) -> Vec<ToolSchema> {
    tools.extend(varin_runtime::tool_disclosure::schemas());
    tools
}
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
        ChildSourceRequirement::None
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
    let retrieval = metadata
        .iter()
        .find(|tool| tool.name == "code_retrieval")
        .unwrap();
    assert_eq!(retrieval.source_requirement, ChildSourceRequirement::Source);
    assert!(!retrieval.process);
    assert_eq!(
        retrieval.default_presets,
        vec![
            varin_runtime::catalog::dispatch::ChildPresetDefault::Worker,
            varin_runtime::catalog::dispatch::ChildPresetDefault::Retrieval,
            varin_runtime::catalog::dispatch::ChildPresetDefault::Verifier,
        ]
    );
    for name in [
        "language_definition",
        "language_references",
        "language_diagnostics",
    ] {
        let capability = metadata.iter().find(|tool| tool.name == name).unwrap();
        assert_eq!(
            capability.source_requirement,
            ChildSourceRequirement::Source
        );
        assert!(
            !capability.process,
            "Host language service is not a child process-tool grant"
        );
        assert_eq!(
            capability.default_presets,
            vec![varin_runtime::catalog::dispatch::ChildPresetDefault::Worker, varin_runtime::catalog::dispatch::ChildPresetDefault::Retrieval, varin_runtime::catalog::dispatch::ChildPresetDefault::Verifier]
        );
        let schema = directory.iter().find(|tool| tool.name == name).unwrap();
        let requirements = schema.requirements.as_ref().unwrap();
        assert!(requirements.accepts_mode(varin_runtime::SourceMode::FixedBranch));
        assert!(requirements.accepts_mode(varin_runtime::SourceMode::Materialized));
        assert!(requirements.accepts_mode(varin_runtime::SourceMode::LiveRoot));
    }
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
    let text = context.iter().find_map(|item| match (&item.provenance, &item.content) {
        (Provenance::SystemInstruction { source }, Content::Text { text })
            if source == "child_dispatch_configuration" => Some(text),
        _ => None,
    }).expect("expected visible selection");
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

#[test]
fn shipped_defaults_resolve_actual_declarations_with_their_required_sources() {
    use varin_runtime::catalog::dispatch::{
        ChildModelSource, ChildPreset, ChildPresetDefault, ChildWorkMode,
    };
    let directory = schemas();
    let metadata = descriptors();
    let get = |name: &str| {
        directory
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let f = fixture::Fixture::new_parent_custom(0, get("file_read"), get("dispatch"), false, false, false, |_, launch| {
        // Shipped presets must compare against the owning wait declaration, not the
        // generic fixture's intentionally minimal placeholder schema.
        launch.tools.retain(|tool| tool.name != "wait_child");
        launch.tools.push(get("wait_child"));
    });
    let mut selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    selected.catalog.native_capabilities = metadata.clone();
    for (id, member, mode) in [
        (
            "worker",
            ChildPresetDefault::Worker,
            ChildWorkMode::IsolatedWrite,
        ),
        (
            "retrieval",
            ChildPresetDefault::Retrieval,
            ChildWorkMode::ReadOnly,
        ),
    ] {
        // The profile owner projects these members; no second available-name list.
        let tools: Vec<_> = metadata
            .iter()
            .filter(|tool| tool.default_presets.contains(&member))
            .map(|tool| tool.name.clone())
            .collect();
        assert!(!tools.is_empty());
        selected.catalog.presets.push(ChildPreset {
            tools_source: varin_runtime::catalog::dispatch::ChildPresetToolsSource::Default,
            id: id.into(),
            name: id.into(),
            instructions: String::new(),
            tools: tools.clone(),
            work_mode: mode,
            model_source: ChildModelSource::Inherit,
            inherit_base: None,
            model: None,
            unavailable: None,
        });
        let mut input = f.input.clone();
        input.preset = Some(id.into());
        input.tools = None;
        input.work_mode = None;
        let (resolved, executable) =
            crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(resolved.profile.work_mode, mode);
        assert_eq!(executable.len(), tools.len());
        assert!(executable.iter().all(|tool| directory.contains(tool)));
        assert!(executable.contains(&get("code_retrieval")));
        // An explicit source capability selection stays exact when a preset evolves.
        input.tools = Some(vec!["file_read".into()]);
        let (_, explicit) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(explicit, with_disclosure(vec![get("file_read")]));
        input.tools = Some(vec!["code_retrieval".into()]);
        let (_, explicit) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert_eq!(explicit, with_disclosure(vec![get("code_retrieval")]));
        input.tools = None;
        assert!(resolved.source_delegation().configured_preset);
        if member == ChildPresetDefault::Worker {
            assert!(executable.contains(&get("file_write")));
            assert!(executable.contains(&get("file_edit")));
            assert!(resolved.source_delegation().process);
            input.work_mode = Some(ChildWorkMode::ReadOnly);
            assert!(crate::collaboration::resolve_selection(&selected, &input).is_err());
        } else {
            assert!(!resolved.source_delegation().process);
            assert!(metadata
                .iter()
                .filter(|tool| tools.contains(&tool.name))
                .all(|tool| tool.source_requirement != ChildSourceRequirement::Physical));
        }
    }
    selected.catalog.presets[0].tools = vec!["read".into(), "bash".into()];
    let mut input = f.input.clone();
    input.preset = Some("worker".into());
    input.tools = None;
    input.work_mode = None;
    assert!(crate::collaboration::resolve_selection(&selected, &input).is_err());
    assert_eq!(selected.catalog.presets[0].tools, vec!["read", "bash"]);
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn absent_source_defaults_derive_from_frozen_declarations_but_explicit_domain_tools_remain_exact() {
    use varin_runtime::catalog::dispatch::{
        ChildModelSource, ChildPreset, ChildPresetDefault, ChildPresetToolsSource, ChildWorkMode,
    };
    let native = schemas();
    let get = |name: &str| {
        native
            .iter()
            .find(|tool| tool.name == name)
            .unwrap()
            .clone()
    };
    let f = fixture::Fixture::new_parent_custom(
        0,
        get("memory"),
        get("dispatch"),
        false,
        false,
        true,
        |input, launch| {
            input.tools = Some(vec!["helper".into()]);
            launch.source = None;
            launch.tools.retain(|tool| tool.name != "wait_child");
            launch.tools.push(get("wait_child"));
        },
    );
    let mut selected =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    selected.catalog.native_capabilities = descriptors();
    let mut input = f.input.clone();
    for (id, member, mode) in [
        (
            "worker",
            ChildPresetDefault::Worker,
            ChildWorkMode::IsolatedWrite,
        ),
        (
            "retrieval",
            ChildPresetDefault::Retrieval,
            ChildWorkMode::ReadOnly,
        ),
    ] {
        let all: Vec<_> = selected
            .catalog
            .native_capabilities
            .iter()
            .filter(|descriptor| descriptor.default_presets.contains(&member))
            .map(|descriptor| descriptor.name.clone())
            .collect();
        let index = selected.catalog.presets.len();
        selected.catalog.presets.push(ChildPreset {
            id: id.into(),
            name: id.into(),
            instructions: String::new(),
            tools: all.clone(),
            tools_source: ChildPresetToolsSource::Default,
            work_mode: mode,
            model_source: ChildModelSource::Inherit,
            inherit_base: None,
            model: None,
            unavailable: None,
        });
        input.preset = Some(id.into());
        input.work_mode = None;
        input.tools = None;
        let (resolved, tools) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
        assert!(!tools.is_empty());
        assert!(tools
            .iter()
            .all(|tool| selected.source_requirement(&tool.name)
                == Some(ChildSourceRequirement::None)));
        assert_eq!(
            selected.catalog.presets[index].tools, all,
            "a source projection does not mutate the configured snapshot"
        );
        assert_eq!(resolved.profile.work_mode, mode);
        input.tools = Some(vec!["code_retrieval".into()]);
        let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
        assert!(error.message.contains("exceed the frozen delegation"), "{error}");
        input.tools = None;
        input.work_mode = Some(ChildWorkMode::ReadOnly);
        assert!(crate::collaboration::resolve_selection(&selected, &input).is_ok());
        input.work_mode = None;
        input.tools = Some(if member == ChildPresetDefault::Worker {
            vec!["file_read".into(), "process_spawn".into()]
        } else {
            vec!["file_read".into()]
        });
        let error = crate::collaboration::resolve_selection(&selected, &input).unwrap_err();
        assert!(error.message.contains("exceed the frozen delegation"), "{error}");
        input.tools = None;
        selected.catalog.presets[index].tools_source = ChildPresetToolsSource::Explicit;
        assert!(crate::collaboration::resolve_selection(&selected, &input)
            .unwrap_err()
            .message
            .contains("file_read"));
    }
    input.preset = None;
    input.tools = Some(vec!["helper".into()]);
    input.work_mode = Some(ChildWorkMode::ReadOnly);
    let (_, tools) = crate::collaboration::resolve_selection(&selected, &input).unwrap();
    assert_eq!(tools, with_disclosure(vec![selected.extension_bindings[0].tool.clone()]));
    let root = f.root.clone();
    drop(selected);
    drop(f);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn durable_tree_cancel_reaches_original_binding_token_before_physical_notification() {
    let directory = schemas();
    let read = directory.iter().find(|tool| tool.name == "file_read").unwrap().clone();
    let dispatch = directory.iter().find(|tool| tool.name == "dispatch").unwrap().clone();
    let mut fixture = fixture::Fixture::new_with_schemas(0, read, dispatch);
    let snapshot: RequestSnapshot = serde_json::from_value(
        fixture.db.capture_model_step_read("parent-request").unwrap().load_request().unwrap(),
    ).unwrap();
    let mut binding = snapshot.view.binding;
    let run = fixture.context.run_id.clone();
    let epoch = fixture.db.epoch();
    let thread = fixture.db.run(&run).unwrap().thread_id;
    // This is ControlCommands' real durable-first interval: the tree command is
    // committed, but cancel_control has not notified the original worker yet.
    fixture.db.cancel_tree(varin_runtime::catalog::dispatch::TreeCancelTarget::Thread {
        thread_id: thread,
    }).unwrap();
    let cancel = CancellationToken::default();
    assert!(!cancel.is_cancelled());
    let root = fixture.root.clone();
    let catalog = std::sync::Arc::new(std::sync::Mutex::new(fixture.db));
    let hook = BindingPreparation {
        inner: std::sync::Arc::new(NoopContextPreparation),
        catalog: catalog.clone(),
    };
    let result = hook.prepare_binding(&run, epoch, &mut binding, &cancel);
    assert!(result.is_err(), "cancelled Run cannot publish a new binding");
    assert!(catalog.lock().unwrap().run(&run).unwrap().cancel_requested);
    assert!(cancel.is_cancelled(), "binding rejection must propagate the original durable cancellation before Engine handles its error");
    drop(hook);
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}
