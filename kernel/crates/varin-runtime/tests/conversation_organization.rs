use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;
use varin_runtime::catalog::{bot, organization::*, Catalog, RuntimeError};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn raw(f: &Fixture) -> Connection {
    Connection::open(f.0.join("conversation.sqlite")).unwrap()
}
fn siblings(c: &Catalog) -> Vec<OrganizationObject> {
    let s = snap(c);
    let mut objects = s
        .containers
        .into_iter()
        .filter(|c| c.parent_id.is_none())
        .map(|c| (c.order, OrganizationObject::Container { id: c.id }))
        .collect::<Vec<_>>();
    objects.extend(
        s.conversations
            .into_iter()
            .filter(|c| c.position.container_id.is_none())
            .map(|c| {
                (
                    c.position.order,
                    match c.conversation {
                        ConversationRef::Native { id } => OrganizationObject::Native { id },
                        ConversationRef::External { id } => OrganizationObject::External { id },
                    },
                )
            }),
    );
    objects.sort_by_key(|(order, _)| *order);
    objects.into_iter().map(|(_, o)| o).collect()
}
fn remove_for_legacy_fixture(db: &Connection) {
    db.execute_batch("DROP TABLE organization_retired_containers;DROP TABLE organization_positions;DROP TABLE organization_containers;DROP TABLE organization_commands;DROP TABLE organization_spaces;").unwrap();
}
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("varin-organization-{}", id())))
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn snap(c: &Catalog) -> OrganizationSnapshot {
    c.organization_snapshot(
        Some("alice"),
        OrganizationQuery {
            archived: Some("include".into()),
            ..Default::default()
        },
    )
    .unwrap()
}
fn parent(c: &Catalog, id: Option<&str>) -> ParentVersion {
    ParentVersion {
        container_id: id.map(str::to_owned),
        children_revision: if let Some(id) = id {
            c.resolve_organization_container(Some("alice"), id)
                .unwrap()
                .children_revision
        } else {
            snap(c).root_revision
        },
    }
}
fn group(c: &mut Catalog, id: &str, p: Option<&str>) -> OrganizationReceipt {
    let parents = vec![parent(c, p)];
    c.organization_command(
        Some("alice"),
        OrganizationCommand {
            key: format!("create-{id}"),
            operation: OrganizationOperation::Create {
                id: id.into(),
                kind: ContainerKind::Group,
                parent_id: p.map(str::to_owned),
                name: Some(id.into()),
                icon: None,
                color: None,
                project_id: None,
                parents,
                before: None,
            },
        },
    )
    .unwrap()
}
fn native(id: &str) -> ConversationRef {
    ConversationRef::Native { id: id.into() }
}
fn move_command(
    c: &Catalog,
    key: &str,
    objects: Vec<OrganizationObject>,
    target: Option<&str>,
) -> OrganizationCommand {
    let mut affected = BTreeSet::from([target.map(str::to_owned)]);
    let items = objects
        .into_iter()
        .map(|object| {
            let (revision, p) = match &object {
                OrganizationObject::Container { id } => {
                    let c = c.resolve_organization_container(Some("alice"), id).unwrap();
                    (c.revision, c.parent_id)
                }
                _ => {
                    let p = c
                        .organization_conversation(
                            Some("alice"),
                            &match &object {
                                OrganizationObject::Native { id } => {
                                    ConversationRef::Native { id: id.clone() }
                                }
                                OrganizationObject::External { id } => {
                                    ConversationRef::External { id: id.clone() }
                                }
                                _ => unreachable!(),
                            },
                        )
                        .unwrap()
                        .position;
                    (p.revision, p.container_id)
                }
            };
            affected.insert(p.clone());
            MoveItem {
                object,
                expected_revision: revision,
                expected_parent_id: p,
            }
        })
        .collect();
    OrganizationCommand {
        key: key.into(),
        operation: OrganizationOperation::Move {
            items,
            parent_id: target.map(str::to_owned),
            before: None,
            parents: affected.iter().map(|p| parent(c, p.as_deref())).collect(),
        },
    }
}
#[test]
fn mixed_tree_moves_are_atomic_scoped_and_leave_execution_identity_unchanged() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "work", None);
    group(&mut c, "release", Some("work"));
    c.create_thread_with_placement(
        "thread",
        "branch",
        Some("alice"),
        Some(Placement {
            container_id: Some("release".into()),
        }),
    )
    .unwrap();
    let original = c.inspect_thread("thread").unwrap();
    let branch = c.head("branch").unwrap();
    let command = move_command(
        &c,
        "move",
        vec![OrganizationObject::Native {
            id: "thread".into(),
        }],
        Some("work"),
    );
    let receipt = c
        .organization_command(Some("alice"), command.clone())
        .unwrap();
    assert_eq!(c.inspect_thread("thread").unwrap(), original);
    assert_eq!(c.head("branch").unwrap(), branch);
    assert_eq!(receipt.positions[0].container_id.as_deref(), Some("work"));
    assert!(c
        .organization_snapshot(Some("bob"), OrganizationQuery::default())
        .unwrap()
        .containers
        .is_empty());
    assert!(c
        .organization_conversation(Some("bob"), &native("thread"))
        .is_err());
    let old = c
        .resolve_organization_container(Some("alice"), "work")
        .unwrap();
    let cycle = move_command(
        &c,
        "cycle",
        vec![OrganizationObject::Container { id: "work".into() }],
        Some("release"),
    );
    assert!(matches!(
        c.organization_command(Some("alice"), cycle),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(
        c.resolve_organization_container(Some("alice"), "work")
            .unwrap(),
        old
    );
    drop(c);
    let mut c = f.open();
    assert_eq!(
        serde_json::to_value(c.organization_command(Some("alice"), command).unwrap()).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
}
#[test]
fn branch_local_versions_allow_independent_work_and_fence_stale_batch() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    group(&mut c, "b", None);
    group(&mut c, "aa", Some("a"));
    group(&mut c, "bb", Some("b"));
    c.create_thread_with_placement(
        "one",
        "one-main",
        Some("alice"),
        Some(Placement {
            container_id: Some("a".into()),
        }),
    )
    .unwrap();
    c.create_thread_with_placement(
        "two",
        "two-main",
        Some("alice"),
        Some(Placement {
            container_id: Some("b".into()),
        }),
    )
    .unwrap();
    let first = move_command(
        &c,
        "first",
        vec![OrganizationObject::Native { id: "one".into() }],
        Some("aa"),
    );
    let second = move_command(
        &c,
        "second",
        vec![OrganizationObject::Native { id: "two".into() }],
        Some("bb"),
    );
    c.organization_command(Some("alice"), first.clone())
        .unwrap();
    c.organization_command(Some("alice"), second).unwrap();
    let mut late = first;
    late.key = "late".into();
    assert!(matches!(
        c.organization_command(Some("alice"), late),
        Err(RuntimeError::Conflict(_))
    ));
    let before = serde_json::to_value(snap(&c)).unwrap();
    let mut batch = move_command(
        &c,
        "batch",
        vec![
            OrganizationObject::Native { id: "one".into() },
            OrganizationObject::Native { id: "two".into() },
        ],
        None,
    );
    if let OrganizationOperation::Move { items, .. } = &mut batch.operation {
        items[1].expected_revision -= 1;
    }
    assert!(c.organization_command(Some("alice"), batch).is_err());
    assert_eq!(serde_json::to_value(snap(&c)).unwrap(), before);
}
#[test]
fn dissolution_promotes_mixed_children_in_order_and_replay_returns_original_receipt() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "left", None);
    group(&mut c, "middle", None);
    group(&mut c, "right", None);
    group(&mut c, "nested", Some("middle"));
    c.create_thread_with_placement(
        "one",
        "one-main",
        Some("alice"),
        Some(Placement {
            container_id: Some("middle".into()),
        }),
    )
    .unwrap();
    let command = OrganizationCommand {
        key: "dissolve".into(),
        operation: OrganizationOperation::Dissolve {
            id: "middle".into(),
            expected_revision: 1,
            parents: vec![parent(&c, None), parent(&c, Some("middle"))],
        },
    };
    let receipt = c
        .organization_command(Some("alice"), command.clone())
        .unwrap();
    let order = siblings(&c);
    assert_eq!(
        order,
        vec![
            OrganizationObject::Container { id: "left".into() },
            OrganizationObject::Container {
                id: "nested".into()
            },
            OrganizationObject::Native { id: "one".into() },
            OrganizationObject::Container { id: "right".into() }
        ]
    );
    group(&mut c, "later", None);
    let retry = c.organization_command(Some("alice"), command).unwrap();
    assert_eq!(retry.cursor, receipt.cursor);
    assert!(!retry.containers.iter().any(|c| c.id == "later"));
}
#[test]
fn admission_retries_do_not_follow_moved_containers_or_silently_change_intent() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    group(&mut c, "b", None);
    let placement = Some(Placement {
        container_id: Some("a".into()),
    });
    c.create_thread_with_placement("one", "main", Some("alice"), placement.clone())
        .unwrap();
    let move_it = move_command(
        &c,
        "manual-move",
        vec![OrganizationObject::Native { id: "one".into() }],
        Some("b"),
    );
    c.organization_command(Some("alice"), move_it).unwrap();
    c.create_thread_with_placement("one", "main", Some("alice"), placement)
        .unwrap();
    assert_eq!(
        c.organization_conversation(Some("alice"), &native("one"))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("b")
    );
    assert!(matches!(
        c.create_thread_with_placement("one", "main", Some("alice"), None),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(c
        .create_thread_with_placement(
            "bad",
            "bad-main",
            Some("alice"),
            Some(Placement {
                container_id: Some("missing".into())
            })
        )
        .is_err());
    assert!(c.inspect_thread("bad").is_err());
}
#[test]
fn stable_references_survive_rename_and_move_but_never_cross_principals() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    group(&mut c, "b", None);
    let reference = c
        .organization_container_reference(Some("alice"), "a", "read-one")
        .unwrap();
    c.organization_command(
        Some("alice"),
        OrganizationCommand {
            key: "rename".into(),
            operation: OrganizationOperation::Update {
                id: "a".into(),
                expected_revision: 1,
                name: Some("new name".into()),
                icon: Some(Some("folder".into())),
                color: Some(Some("blue".into())),
            },
        },
    )
    .unwrap();
    let command = move_command(
        &c,
        "move",
        vec![OrganizationObject::Container { id: "a".into() }],
        Some("b"),
    );
    c.organization_command(Some("alice"), command).unwrap();
    assert_eq!(
        c.resolve_organization_container(Some("alice"), &reference)
            .unwrap()
            .id,
        "a"
    );
    assert_eq!(
        c.organization_container_reference(Some("alice"), "a", "read-two")
            .unwrap(),
        reference
    );
    assert!(c
        .resolve_organization_container(Some("bob"), &reference)
        .is_err());
    c.create_thread_with_placement(
        "one",
        "main",
        Some("alice"),
        Some(Placement {
            container_id: Some(reference.clone()),
        }),
    )
    .unwrap();
    assert_eq!(snap(&c).conversations[0].path, vec!["b", "a"]);
    drop(c);
    let c = f.open();
    assert_eq!(
        c.resolve_organization_container(Some("alice"), &reference)
            .unwrap()
            .name
            .as_deref(),
        Some("new name")
    );
}
#[test]
fn continuation_is_bound_to_scope_query_and_actual_generation() {
    let f = Fixture::new();
    let mut c = f.open();
    for id in ["a", "b", "c"] {
        c.create_thread_with_principal(id, &format!("branch-{id}"), Some("alice"))
            .unwrap();
    }
    let q = OrganizationQuery {
        limit: Some(1),
        ..Default::default()
    };
    let one = c.organization_snapshot(Some("alice"), q.clone()).unwrap();
    assert_eq!(one.conversations.len(), 1);
    let mut next = q.clone();
    next.cursor = one.next_cursor;
    let two = c
        .organization_snapshot(Some("alice"), next.clone())
        .unwrap();
    assert_ne!(
        one.conversations[0].conversation,
        two.conversations[0].conversation
    );
    assert!(c.organization_snapshot(Some("bob"), next.clone()).is_err());
    group(&mut c, "new", None);
    assert!(matches!(
        c.organization_snapshot(Some("alice"), next),
        Err(RuntimeError::Conflict(_))
    ));
}
#[test]
fn organization_events_are_visible_only_to_original_principal() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "alice-group", None);
    let alice = c.events_after_for_principal(0, 100, Some("alice")).unwrap();
    assert!(alice.iter().any(|e| e.kind == "organization.changed"));
    assert!(!c
        .events_after_for_principal(0, 100, Some("bob"))
        .unwrap()
        .iter()
        .any(|e| e.kind == "organization.changed"));
    assert!(!c
        .events_after_for_principal(0, 100, None)
        .unwrap()
        .iter()
        .any(|e| e.kind == "organization.changed"));
}
#[test]
fn initialization_publishes_once_and_does_not_overwrite_user_organization() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "user-group", None);
    c.create_thread_with_principal("one", "main", Some("alice"))
        .unwrap();
    // A real pre-95 object has no navigation receipt or explicit position.
    raw(&f)
        .execute("DELETE FROM organization_positions WHERE id='one'", [])
        .unwrap();
    let initial = OrganizationInitialization {
        key: "initialize".into(),
        projects: vec![
            InitialProject { id: "p1".into() },
            InitialProject { id: "p2".into() },
        ],
        positions: vec![InitialPosition {
            conversation: native("one"),
            project_id: Some("p1".into()),
        }],
    };
    let receipt = c
        .initialize_organization(Some("alice"), initial.clone())
        .unwrap();
    assert!(snap(&c).initialized);
    assert_eq!(snap(&c).containers.len(), 3);
    let again = c
        .initialize_organization(
            Some("alice"),
            OrganizationInitialization {
                key: "different-open".into(),
                projects: Vec::new(),
                positions: Vec::new(),
            },
        )
        .unwrap();
    assert_eq!(receipt.cursor, again.cursor);
    assert_eq!(snap(&c).containers.len(), 3);
    drop(c);
    let mut c = f.open();
    assert_eq!(
        c.initialize_organization(Some("alice"), initial)
            .unwrap()
            .cursor,
        receipt.cursor
    );
    assert_eq!(c.inspect_thread("one").unwrap()["main_branch_id"], "main");
}

#[test]
fn format_94_upgrade_keeps_original_assets_and_unknown_or_partial_layout_stays_untouched() {
    let f = Fixture::new();
    let mut c = f.open();
    c.create_thread_with_principal("original", "main", Some("alice"))
        .unwrap();
    let original = c.inspect_thread("original").unwrap();
    remove_for_legacy_fixture(&raw(&f));
    raw(&f).pragma_update(None, "user_version", 94).unwrap();
    drop(c);
    let c = f.open();
    assert_eq!(c.inspect_thread("original").unwrap(), original);
    assert_eq!(
        raw(&f)
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        95
    );
    assert!(snap(&c).containers.is_empty());
    drop(c);
    let raw = Connection::open(f.0.join("conversation.sqlite")).unwrap();
    raw.execute_batch("DROP TABLE organization_commands")
        .unwrap();
    let version: i64 = raw
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    drop(raw);
    let bytes = std::fs::read(f.0.join("conversation.sqlite")).unwrap();
    assert!(Catalog::open(&f.0).is_err());
    assert_eq!(
        std::fs::read(f.0.join("conversation.sqlite")).unwrap(),
        bytes
    );
    assert_eq!(version, 95);
}
#[test]
fn dissolved_container_identity_is_retired_and_cannot_retarget_a_stable_reference() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    let reference = c
        .organization_container_reference(Some("alice"), "a", "test")
        .unwrap();
    let command = OrganizationCommand {
        key: "remove".into(),
        operation: OrganizationOperation::Dissolve {
            id: "a".into(),
            expected_revision: 1,
            parents: vec![parent(&c, None), parent(&c, Some("a"))],
        },
    };
    c.organization_command(Some("alice"), command).unwrap();
    let create = OrganizationCommand {
        key: "replacement".into(),
        operation: OrganizationOperation::Create {
            id: "a".into(),
            kind: ContainerKind::Group,
            parent_id: None,
            name: Some("different".into()),
            icon: None,
            color: None,
            project_id: None,
            parents: vec![parent(&c, None)],
            before: None,
        },
    };
    assert!(c.organization_command(Some("alice"), create).is_err());
    assert!(c
        .resolve_organization_container(Some("alice"), &reference)
        .is_err());
}
#[test]
fn bot_sessions_keep_original_principal_and_fallback_does_not_cross_user_scope() {
    let f = Fixture::new();
    let mut c = f.open();
    c.publish_bot_gate(bot::BotGate {
        bot_id: "bot".into(),
        profile_revision: 1,
        activity_operation_id: None,
        permitted: true,
    })
    .unwrap();
    c.create_bot_thread_with_placement("alice-one", "alice-main", "bot", Some("alice"), None)
        .unwrap();
    c.create_bot_thread_with_placement("bob-one", "bob-main", "bot", Some("bob"), None)
        .unwrap();
    raw(&f)
        .execute("UPDATE threads SET archived=1 WHERE id='alice-one'", [])
        .unwrap();
    let fallback = c
        .resolve_bot_entry_with_principal("alice-one", "alice-main", "bot", Some("alice"))
        .unwrap();
    assert_ne!(fallback.thread_id, "bob-one");
    assert_eq!(
        c.thread_principal(&fallback.thread_id).unwrap().as_deref(),
        Some("alice")
    );
    assert!(c
        .resolve_bot_entry_with_principal("bob-one", "bob-main", "bot", Some("alice"))
        .is_err());
    assert_eq!(
        c.resolve_bot_entry("bob-one", "bob-main", "bot")
            .unwrap()
            .thread_id,
        "bob-one"
    );
}
#[test]
fn nearest_project_is_navigation_only_and_uses_innermost_registered_project() {
    let f = Fixture::new();
    let mut c = f.open();
    let initial = OrganizationInitialization {
        key: "initial".into(),
        projects: vec![
            InitialProject {
                id: "outer-project".into(),
            },
            InitialProject {
                id: "inner-project".into(),
            },
        ],
        positions: vec![],
    };
    c.initialize_organization(Some("alice"), initial).unwrap();
    let nodes = snap(&c).containers;
    let outer = nodes
        .iter()
        .find(|c| c.project_id.as_deref() == Some("outer-project"))
        .unwrap()
        .id
        .clone();
    let inner = nodes
        .iter()
        .find(|c| c.project_id.as_deref() == Some("inner-project"))
        .unwrap()
        .id
        .clone();
    group(&mut c, "group", Some(&outer));
    let command = move_command(
        &c,
        "nest-project",
        vec![OrganizationObject::Container { id: inner.clone() }],
        Some("group"),
    );
    c.organization_command(Some("alice"), command).unwrap();
    group(&mut c, "inner-group", Some(&inner));
    assert_eq!(
        c.organization_nearest_project(Some("alice"), "group")
            .unwrap()
            .as_deref(),
        Some("outer-project")
    );
    assert_eq!(
        c.organization_nearest_project(Some("alice"), "inner-group")
            .unwrap()
            .as_deref(),
        Some("inner-project")
    );
    assert!(c
        .organization_nearest_project(Some("bob"), "group")
        .is_err());
}

#[test]
fn creation_defaults_remain_frozen_when_navigation_moves_or_dissolves() {
    let f = Fixture::new();
    let mut c = f.open();
    let initial = OrganizationInitialization {
        key: "initial".into(),
        projects: vec![InitialProject {
            id: "original-project".into(),
        }],
        positions: vec![],
    };
    c.initialize_organization(Some("alice"), initial).unwrap();
    let project = snap(&c).containers[0].id.clone();
    group(&mut c, "group", Some(&project));
    c.create_thread_with_placement(
        "one",
        "main",
        Some("alice"),
        Some(Placement {
            container_id: Some("group".into()),
        }),
    )
    .unwrap();
    assert_eq!(
        c.organization_creation_defaults("one").unwrap(),
        Some(CreationDefaults {
            project_id: Some("original-project".into())
        })
    );
    let command = move_command(
        &c,
        "move",
        vec![OrganizationObject::Native { id: "one".into() }],
        None,
    );
    c.organization_command(Some("alice"), command).unwrap();
    let remove = OrganizationCommand {
        key: "dissolve".into(),
        operation: OrganizationOperation::Dissolve {
            id: project.clone(),
            expected_revision: 1,
            parents: vec![parent(&c, None), parent(&c, Some(&project))],
        },
    };
    c.organization_command(Some("alice"), remove).unwrap();
    drop(c);
    let mut c = f.open();
    assert_eq!(
        c.organization_creation_defaults("one")
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some("original-project")
    );
    c.create_thread_with_placement(
        "root",
        "root-main",
        Some("alice"),
        Some(Placement { container_id: None }),
    )
    .unwrap();
    assert_eq!(
        c.organization_creation_defaults("root").unwrap(),
        Some(CreationDefaults { project_id: None })
    );
    c.create_thread_with_principal("ordinary", "ordinary-main", Some("alice"))
        .unwrap();
    assert_eq!(c.organization_creation_defaults("ordinary").unwrap(), None);
}
#[test]
fn explicit_legacy_claim_transfers_navigation_once_without_first_read_claiming_public_work() {
    let f = Fixture::new();
    let mut c = f.open();
    c.create_thread("public", "main").unwrap();
    assert!(c
        .organization_snapshot(Some("alice"), OrganizationQuery::default())
        .unwrap()
        .conversations
        .is_empty());
    c.initialize_principals("alice", true).unwrap();
    assert_eq!(snap(&c).conversations.len(), 1);
    assert!(c
        .organization_snapshot(None, OrganizationQuery::default())
        .unwrap()
        .conversations
        .is_empty());
    c.create_thread("later-public", "later-main").unwrap();
    c.initialize_principals("alice", true).unwrap();
    assert_eq!(snap(&c).conversations.len(), 1);
    assert_eq!(c.thread_principal("later-public").unwrap(), None);
}

#[path = "fixtures/child_dispatch.rs"]
mod child_fixture;
fn public_group(c: &mut Catalog, id: &str) {
    let root = c
        .organization_snapshot(None, OrganizationQuery::default())
        .unwrap()
        .root_revision;
    c.organization_command(
        None,
        OrganizationCommand {
            key: format!("group-{id}"),
            operation: OrganizationOperation::Create {
                id: id.into(),
                kind: ContainerKind::Group,
                parent_id: None,
                name: Some(id.into()),
                icon: None,
                color: None,
                project_id: None,
                before: None,
                parents: vec![ParentVersion {
                    container_id: None,
                    children_revision: root,
                }],
            },
        },
    )
    .unwrap();
}
fn public_move(c: &mut Catalog, key: &str, id: &str, target: Option<&str>) {
    let p = c
        .organization_conversation(None, &native(id))
        .unwrap()
        .position;
    let parents = BTreeSet::from([p.container_id.clone(), target.map(str::to_owned)])
        .into_iter()
        .map(|id| ParentVersion {
            children_revision: if let Some(id) = &id {
                c.resolve_organization_container(None, id)
                    .unwrap()
                    .children_revision
            } else {
                c.organization_snapshot(None, OrganizationQuery::default())
                    .unwrap()
                    .root_revision
            },
            container_id: id,
        })
        .collect();
    c.organization_command(
        None,
        OrganizationCommand {
            key: key.into(),
            operation: OrganizationOperation::Move {
                items: vec![MoveItem {
                    object: OrganizationObject::Native { id: id.into() },
                    expected_revision: p.revision,
                    expected_parent_id: p.container_id,
                }],
                parent_id: target.map(str::to_owned),
                before: None,
                parents,
            },
        },
    )
    .unwrap();
}
#[test]
fn real_bot_dispatch_freezes_main_task_location_at_original_admission() {
    let mut f = child_fixture::Fixture::new_in_bot("origin-bot");
    public_group(&mut f.db, "a");
    public_group(&mut f.db, "b");
    public_move(&mut f.db, "parent-a", "thread:parent", Some("a"));
    let child = f.accept();
    let source = serde_json::to_value(&child.source).unwrap();
    let first =
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap();
    assert!(first.position.explicit);
    assert_eq!(first.position.container_id.as_deref(), Some("a"));
    assert_eq!(first.origin.bot_id.as_deref(), Some("origin-bot"));
    public_move(&mut f.db, "parent-b", "thread:parent", Some("b"));
    let replay = f.accept();
    assert_eq!(replay.operation_id, child.operation_id);
    assert_eq!(serde_json::to_value(&replay.source).unwrap(), source);
    let latest =
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap();
    assert_eq!(latest.position.container_id.as_deref(), Some("a"));
    assert_eq!(latest.origin.conversation, Some(native("thread:parent")));
}
#[test]
fn real_nested_dispatch_inherits_until_an_explicit_move_without_rewriting_execution_tree() {
    let mut f = child_fixture::Fixture::new();
    public_group(&mut f.db, "a");
    public_group(&mut f.db, "b");
    public_move(&mut f.db, "parent-a", "thread:parent", Some("a"));
    let child = f.accept();
    let first =
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap();
    assert!(!first.position.explicit);
    assert_eq!(first.position.inherited_from, Some(native("thread:parent")));
    assert_eq!(first.position.container_id.as_deref(), Some("a"));
    public_move(&mut f.db, "parent-b", "thread:parent", Some("b"));
    assert_eq!(
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("b")
    );
    public_move(&mut f.db, "child-a", &child.child_thread_id, Some("a"));
    public_move(&mut f.db, "parent-root", "thread:parent", None);
    assert_eq!(
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        f.db.child_task(&child.operation_id)
            .unwrap()
            .parent_thread_id,
        "thread:parent"
    );
}
fn external(c: &mut Catalog, value: serde_json::Value) -> serde_json::Value {
    let command = serde_json::from_value(value).unwrap();
    let prepared = c.prepare_external(command).load().unwrap();
    c.execute_external(prepared).unwrap().load().unwrap()
}
#[test]
fn external_product_position_is_typed_and_delete_receipt_survives_tombstone() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    c.create_thread_with_principal("same-id", "native-main", Some("alice"))
        .unwrap();
    external(
        &mut c,
        json!({"action":"create","id":"same-id","key":"external-create","configurationId":"codex","harness":"codex","title":"External","cwd":"/original","principalId":"alice","organization":{"containerId":"a"}}),
    );
    let snapshot = snap(&c);
    assert_eq!(snapshot.conversations.len(), 2);
    let entry = c
        .organization_conversation(
            Some("alice"),
            &ConversationRef::External {
                id: "same-id".into(),
            },
        )
        .unwrap();
    assert_eq!(entry.position.container_id.as_deref(), Some("a"));
    let command = move_command(
        &c,
        "external-move",
        vec![OrganizationObject::External {
            id: "same-id".into(),
        }],
        None,
    );
    c.organization_command(Some("alice"), command).unwrap();
    assert_eq!(
        external(&mut c, json!({"action":"inspect","id":"same-id"}))["cwd"],
        "/original"
    );
    let update = json!({"action":"update","id":"same-id","key":"delete","expectedRevision":1,"deleted":true});
    let deleted = external(&mut c, update.clone());
    assert_eq!(deleted["deleted"], true);
    assert_eq!(external(&mut c, update.clone()), deleted);
    assert_eq!(
        external(&mut c, json!({"action":"update_receipt","command":update})),
        deleted
    );
    assert_eq!(
        external(&mut c, json!({"action":"inspect","id":"same-id"}))["principalId"],
        "alice"
    );
    assert_eq!(snap(&c).conversations.len(), 1);
}
