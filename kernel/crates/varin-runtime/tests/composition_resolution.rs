use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use varin_runtime::composition::resolver::*;
use varin_runtime::composition::{BindingSpec, CompositionRegistry};
fn capability(id: &str) -> Capability {
    Capability {
        id: id.into(),
        version: 1,
    }
}
fn requirement(id: &str) -> Requirement {
    Requirement {
        binding: id.into(),
        capability: capability(id),
        cardinality: Cardinality::One,
        optional: false,
    }
}
fn descriptor(id: &str, cap: &str, deps: Vec<Requirement>) -> ProviderDescriptor {
    ProviderDescriptor {
        preparation: PreparationKey {
            provider_id: id.into(),
            content_version: "1".into(),
            instance_key: format!("local:{id}"),
            configuration: Value::Null,
        },
        provides: BTreeSet::from([capability(cap)]),
        requires: deps,
    }
}
fn scope() -> ScopedSelection {
    ScopedSelection {
        scope_id: "scope".into(),
        revision: 1,
        selected: BTreeMap::new(),
    }
}
fn ready(p: &ProviderDescriptor) -> ReadyProvider<String> {
    ReadyProvider {
        preparation: p.preparation.clone(),
        capabilities: p
            .provides
            .iter()
            .map(|c| {
                (
                    c.clone(),
                    PreparedCapability {
                        schema: json!({}),
                        implementation: Arc::new(p.preparation.provider_id.clone()),
                    },
                )
            })
            .collect(),
    }
}
#[test]
fn unselected_cycle_does_not_block_requested_work_and_independent_preparation_is_not_a_barrier() {
    let providers = vec![
        descriptor("reader", "read", vec![requirement("disk")]),
        descriptor("disk", "disk", vec![]),
        descriptor("slow", "slow", vec![]),
        descriptor("cycle-a", "a", vec![requirement("b")]),
        descriptor("cycle-b", "b", vec![requirement("a")]),
    ];
    let graph = resolve(
        &scope(),
        &providers,
        &[requirement("read"), requirement("slow")],
    )
    .unwrap();
    assert_eq!(graph.providers().len(), 3);
    let next = graph.preparable(
        &BTreeSet::from(["disk".into()]),
        &BTreeSet::from(["slow".into()]),
    );
    assert_eq!(
        next.iter()
            .map(|n| n.descriptor.preparation.provider_id.as_str())
            .collect::<Vec<_>>(),
        vec!["reader"]
    );
}
#[test]
fn optional_absence_does_not_hide_a_selected_providers_required_failure() {
    let mut optional = requirement("read");
    optional.optional = true;
    let empty = resolve(&scope(), &[], &[optional.clone()]).unwrap();
    assert_eq!(empty.missing_optional().len(), 1);
    let selected = descriptor("reader", "read", vec![requirement("missing-disk")]);
    assert!(matches!(
        resolve(&scope(), &[selected], &[optional]),
        Err(ResolveError::MissingRequired(_))
    ));
}
#[test]
fn actual_cycle_and_ambiguous_single_provider_are_rejected() {
    let providers = vec![
        descriptor("a", "a", vec![requirement("b")]),
        descriptor("b", "b", vec![requirement("a")]),
    ];
    assert!(
        matches!(resolve(&scope(),&providers,&[requirement("a")]),Err(ResolveError::DependencyCycle(path)) if path==vec!["a","b","a"])
    );
    assert!(matches!(
        resolve(
            &scope(),
            &[
                descriptor("one", "read", vec![]),
                descriptor("two", "read", vec![])
            ],
            &[requirement("read")]
        ),
        Err(ResolveError::Ambiguous(_))
    ));
}
#[test]
fn stale_preparation_and_changed_scope_cannot_publish_candidate() {
    let provider = descriptor("reader", "read", vec![]);
    let selected = scope();
    let graph = resolve(&selected, &[provider.clone()], &[requirement("read")]).unwrap();
    let mut registry = CompositionRegistry::<String>::new();
    let mut stale = ready(&provider);
    stale.preparation.instance_key = "different-machine".into();
    let result = registry.prepare_resolved(
        0,
        &graph,
        &BTreeMap::from([("reader".into(), stale)]),
        |_, _| panic!("not a collection"),
    );
    assert!(matches!(result, Err(ResolveError::NotReady(_))));
    assert_eq!(registry.active().revision(), 0);
    let candidate = registry
        .prepare_resolved(
            0,
            &graph,
            &BTreeMap::from([("reader".into(), ready(&provider))]),
            |_, _| panic!("not a collection"),
        )
        .unwrap();
    let mut changed = selected.clone();
    changed.revision += 1;
    assert!(matches!(
        registry.publish_resolved(candidate, &changed),
        Err(ResolveError::ScopeChanged)
    ));
    assert_eq!(registry.active().revision(), 0);
}
#[test]
fn collection_is_explicit_and_preserves_selection_order() {
    let one = descriptor("one", "read", vec![]);
    let two = descriptor("two", "read", vec![]);
    let mut selected = scope();
    selected
        .selected
        .insert(capability("read"), vec!["two".into(), "one".into()]);
    let mut root = requirement("read");
    root.cardinality = Cardinality::Collection;
    let graph = resolve(&selected, &[one.clone(), two.clone()], &[root]).unwrap();
    let mut registry = CompositionRegistry::new();
    let candidates = BTreeMap::from([("one".into(), ready(&one)), ("two".into(), ready(&two))]);
    let candidate = registry
        .prepare_resolved(0, &graph, &candidates, |binding, members| {
            assert_eq!(
                members
                    .iter()
                    .map(|m| m.capability.as_str())
                    .collect::<Vec<_>>(),
                vec!["two", "one"]
            );
            Ok(BindingSpec {
                capability: binding.requirement.binding.clone(),
                content_version: "aggregate".into(),
                schema: json!({}),
                implementation: Arc::new(
                    members
                        .iter()
                        .map(|m| m.implementation.as_str())
                        .collect::<Vec<_>>()
                        .join("+"),
                ),
            })
        })
        .unwrap();
    let plan = registry.publish_resolved(candidate, &selected).unwrap();
    assert_eq!(
        plan.bind("read")
            .unwrap()
            .begin_call()
            .unwrap()
            .implementation()
            .unwrap(),
        "two+one"
    );
}
