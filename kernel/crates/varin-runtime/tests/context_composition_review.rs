use varin_runtime::composition::context::{ContextComposition, ContextCompositions, ContextFragment, FragmentKind};
use varin_runtime::execution::{Content, Provenance};

#[test]
fn unchanged_bindings_are_reused_old_pins_survive_replacement_and_data_stays_data() {
    let owner = ContextCompositions::default();
    let mut declaration = ContextComposition {
        provider_id: "first-generation".into(), content_version: "first-content".into(),
        scope_id: "session".into(), selection_revision: 1,
        sections: vec![ContextFragment { name: "evidence".into(), kind: FragmentKind::Data, content: "quoted source".into() }],
    };
    let first = owner.bind("branch", Some(&declaration)).unwrap().unwrap();
    let mut prepared_ids = std::collections::BTreeSet::new();
    for _ in 0..5 {
        let again = owner.bind("branch", Some(&declaration)).unwrap().unwrap();
        assert_eq!(first.binding_id().unwrap(), again.binding_id().unwrap());
        prepared_ids.insert(again.binding_id().unwrap().0);
    }
    assert_eq!(prepared_ids.len(), 1);
    let original = first.apply("checkpoint-old").unwrap();
    assert!(matches!(&original[0].provenance, Provenance::ExternalData { .. }));
    declaration.provider_id = "second-generation".into(); declaration.content_version = "second-content".into();
    declaration.sections[0].content = "replacement".into(); declaration.selection_revision += 1;
    let second = owner.bind("branch", Some(&declaration)).unwrap().unwrap();
    assert_ne!(first.binding_id().unwrap(), second.binding_id().unwrap());
    assert_eq!(first.apply("checkpoint-old").unwrap(), original);
    assert!(matches!(&second.apply("checkpoint-new").unwrap()[0].content, Content::Text { text } if text == "replacement"));
    assert!(owner.bind("branch", None).unwrap().is_none());
    assert_eq!(first.apply("checkpoint-old").unwrap(), original);
    assert!(matches!(&second.apply("checkpoint-new").unwrap()[0].provenance, Provenance::ExternalData { .. }));
}
