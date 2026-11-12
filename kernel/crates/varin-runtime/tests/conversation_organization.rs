use rusqlite::Connection;
use serde_json::json;
use std::collections::BTreeSet;
use varin_runtime::catalog::{bot, organization::*, Catalog, RuntimeError};

#[test]
fn recent_directory_orders_across_containers_and_keeps_manual_cursors_independent_of_activity() {
    let fixture = Fixture::new();
    let mut catalog = fixture.open();
    group(&mut catalog, "first-category", None);
    group(&mut catalog, "second-category", None);
    let db = raw(&fixture);
    for (id, updated, pinned, principal) in [
        ("pinned", 10, true, "alice"),
        ("latest-native", 30, false, "alice"),
        ("older-native", 20, false, "alice"),
        ("another-user", 100, true, "bob"),
    ] {
        db.execute("INSERT INTO threads(id,principal_id,agent_code,title,updated_at_ms,pinned) VALUES(?1,?2,?1,?1,?3,?4)", rusqlite::params![id, principal, updated, pinned]).unwrap();
    }
    db.execute("INSERT INTO external_conversations(id,body) VALUES('latest-external',?1)", [json!({"id":"latest-external","title":"External","principalId":"alice","revision":1,"updatedAt":40}).to_string()]).unwrap();
    db.execute("INSERT INTO organization_positions(scope,kind,id,container_id,sort_order,revision,is_explicit) VALUES(?1,'native','latest-native','first-category',0,1,1)", [serde_json::to_string(&Some("alice")).unwrap()]).unwrap();
    let query = OrganizationQuery { page_nodes: true, kind: Some("conversations".into()), sort: Some("recent".into()), limit: Some(2), ..Default::default() };
    let first = catalog.organization_snapshot(Some("alice"), query.clone()).unwrap();
    assert_eq!(first.conversations.iter().map(|entry| entry.conversation.id()).collect::<Vec<_>>(), vec!["pinned", "latest-external"]);
    assert_eq!(first.conversations[1].updated_at_ms, Some(40));
    let next = catalog.organization_snapshot(Some("alice"), OrganizationQuery { cursor: first.next_cursor.clone(), ..query.clone() }).unwrap();
    assert_eq!(next.conversations.iter().map(|entry| entry.conversation.id()).collect::<Vec<_>>(), vec!["latest-native", "older-native"]);
    assert!(next.next_cursor.is_none());
    assert!(first.items.as_ref().unwrap().iter().all(|item| !matches!(item, OrganizationObject::Container { .. })));
    let containers = OrganizationQuery { page_nodes: true, kind: Some("containers".into()), limit: Some(1), ..Default::default() };
    let category_page = catalog.organization_snapshot(Some("alice"), containers.clone()).unwrap();
    assert!(category_page.conversations.is_empty());
    assert_eq!(category_page.items.as_ref().unwrap().len(), 1);
    let manual = OrganizationQuery { sort: None, ..query.clone() };
    let manual_page = catalog.organization_snapshot(Some("alice"), manual.clone()).unwrap();
    db.execute("UPDATE threads SET updated_at_ms=200 WHERE id='pinned'", []).unwrap();
    assert!(catalog.organization_snapshot(Some("alice"), OrganizationQuery { cursor: category_page.next_cursor, ..containers }).is_ok());
    assert!(catalog.organization_snapshot(Some("alice"), OrganizationQuery { cursor: manual_page.next_cursor, ..manual }).is_ok());
    assert!(matches!(catalog.organization_snapshot(Some("alice"), OrganizationQuery { cursor: first.next_cursor, ..query }), Err(RuntimeError::Conflict(_))));
}

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
        97
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
    assert_eq!(version, 97);
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
            source: None,
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
        Some(CreationDefaults {
            project_id: None,
            source: None
        })
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
    assert_eq!(c
        .organization_snapshot(Some("alice"), OrganizationQuery::default())
        .unwrap()
        .conversations
        .len(), 1);
    assert_eq!(c.thread_principal("public").unwrap(), None);
    c.initialize_principals("alice", true).unwrap();
    assert_eq!(snap(&c).conversations.len(), 1);
    assert!(c
        .organization_snapshot(None, OrganizationQuery::default())
        .unwrap()
        .conversations
        .is_empty());
    c.create_thread("later-public", "later-main").unwrap();
    c.initialize_principals("alice", true).unwrap();
    assert_eq!(snap(&c).conversations.len(), 2);
    assert_eq!(c.thread_principal("later-public").unwrap(), None);
}

#[test]
fn format_96_restores_readable_legacy_project_membership_without_reassigning_users_or_overwriting_moves() {
    let f = Fixture::new();
    let mut c = f.open();
    c.initialize_principals("alice", false).unwrap();
    c.create_thread("public", "public-main").unwrap();
    c.create_thread_with_principal("own", "own-main", Some("alice")).unwrap();
    c.create_thread_with_principal("foreign", "foreign-main", Some("bob")).unwrap();
    c.initialize_organization(Some("alice"), OrganizationInitialization {
        key: "initial-project-generation".into(), projects: vec![InitialProject { id: "project".into() }],
        positions: vec![InitialPosition { conversation: native("own"), project_id: Some("project".into()) }],
    }).unwrap();
    let moved = move_command(&c, "keep-user-move", vec![OrganizationObject::Native { id: "own".into() }], None);
    let receipt = c.organization_command(Some("alice"), moved.clone()).unwrap();
    let original = c.inspect_thread("public").unwrap();
    raw(&f).pragma_update(None, "user_version", 96).unwrap();
    drop(c);
    let mut c = f.open();
    assert!(!c.organization_initialized(Some("alice")).unwrap());
    assert_eq!(c.inspect_thread("public").unwrap(), original);
    c.initialize_organization(Some("alice"), OrganizationInitialization {
        key: "visible-project-generation".into(), projects: vec![InitialProject { id: "project".into() }],
        positions: vec![InitialPosition { conversation: native("public"), project_id: Some("project".into()) }, InitialPosition { conversation: native("own"), project_id: Some("project".into()) }],
    }).unwrap();
    let restored = c.organization_conversation(Some("alice"), &native("public")).unwrap();
    assert!(restored.position.container_id.is_some());
    assert_eq!(c.organization_conversation(Some("alice"), &native("own")).unwrap().position.container_id, None);
    assert_eq!(c.organization_receipt(Some("alice"), &moved).unwrap().unwrap().cursor, receipt.cursor);
    assert_eq!(c.thread_principal("public").unwrap(), None);
    assert!(c.organization_conversation(Some("alice"), &native("foreign")).is_err());
    assert_eq!(c.organization_snapshot(Some("bob"), OrganizationQuery::default()).unwrap().conversations.len(), 2);
    assert_eq!(c.organization_conversation(Some("bob"), &native("public")).unwrap().position.container_id, None);
    drop(c);
    let c = f.open();
    assert!(c.organization_initialized(Some("alice")).unwrap());
    assert_eq!(c.organization_conversation(Some("alice"), &native("public")).unwrap().position.container_id, restored.position.container_id);
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
    let projection=f.db.organization_snapshot(None,OrganizationQuery::default()).unwrap();
    for entry in projection.conversations {
        let single=f.db.organization_conversation(None,&entry.conversation).unwrap();
        assert_eq!(serde_json::to_value(entry).unwrap(),serde_json::to_value(single).unwrap());
    }
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

#[test]
fn restoring_inherited_subtask_keeps_monotonic_revision_and_does_not_overwrite_later_moves() {
    let mut f = child_fixture::Fixture::new();
    public_group(&mut f.db, "a");
    public_group(&mut f.db, "b");
    public_move(&mut f.db, "parent-a", "thread:parent", Some("a"));
    let child = f.accept();
    public_move(&mut f.db, "child-b", &child.child_thread_id, Some("b"));
    let p =
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position;
    let restore = OrganizationCommand {
        key: "restore-inherited".into(),
        operation: OrganizationOperation::Restore {
            items: vec![RestoreItem {
                object: OrganizationObject::Native {
                    id: child.child_thread_id.clone(),
                },
                expected_revision: p.revision,
                expected_parent_id: p.container_id,
                parent_id: Some("a".into()),
                before: None,
                inherit: true,
            }],
            parents: ["a", "b"]
                .iter()
                .map(|id| ParentVersion {
                    container_id: Some((*id).into()),
                    children_revision: f
                        .db
                        .resolve_organization_container(None, id)
                        .unwrap()
                        .children_revision,
                })
                .collect(),
        },
    };
    f.db.organization_command(None, restore.clone()).unwrap();
    let inherited =
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position;
    assert!(!inherited.explicit);
    assert_eq!(inherited.revision, p.revision + 1);
    assert_eq!(inherited.inherited_from, Some(native("thread:parent")));
    public_move(&mut f.db, "parent-b", "thread:parent", Some("b"));
    assert_eq!(
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("b")
    );
    public_move(&mut f.db, "child-back", &child.child_thread_id, Some("b"));
    let mut stale = restore;
    stale.key = "stale-undo".into();
    assert!(matches!(
        f.db.organization_command(None, stale),
        Err(RuntimeError::Conflict(_))
    ));
    assert!(
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position
            .explicit
    );
}
#[test]
fn multi_parent_restore_is_atomic_and_checks_the_final_candidate_graph() {
    let f = Fixture::new();
    let mut c = f.open();
    for id in ["a", "b", "target"] {
        group(&mut c, id, None);
    }
    for (id, parent) in [("one", "a"), ("two", "b")] {
        c.create_thread_with_placement(
            id,
            &format!("{id}-main"),
            Some("alice"),
            Some(Placement {
                container_id: Some(parent.into()),
            }),
        )
        .unwrap();
    }
    let move_both = move_command(
        &c,
        "move-both",
        vec![
            OrganizationObject::Native { id: "one".into() },
            OrganizationObject::Native { id: "two".into() },
        ],
        Some("target"),
    );
    c.organization_command(Some("alice"), move_both).unwrap();
    let restore = OrganizationCommand {
        key: "restore-both".into(),
        operation: OrganizationOperation::Restore {
            items: [("one", "a"), ("two", "b")]
                .iter()
                .map(|(id, parent)| {
                    let p = c
                        .organization_conversation(Some("alice"), &native(id))
                        .unwrap()
                        .position;
                    RestoreItem {
                        object: OrganizationObject::Native { id: (*id).into() },
                        expected_revision: p.revision,
                        expected_parent_id: p.container_id,
                        parent_id: Some((*parent).into()),
                        before: None,
                        inherit: false,
                    }
                })
                .collect(),
            parents: ["a", "b", "target"]
                .iter()
                .map(|id| parent(&c, Some(id)))
                .collect(),
        },
    };
    let mut stale = restore.clone();
    stale.key = "bad-batch".into();
    if let OrganizationOperation::Restore { items, .. } = &mut stale.operation {
        items[1].expected_revision += 1;
    }
    assert!(c.organization_command(Some("alice"), stale).is_err());
    assert_eq!(
        c.organization_conversation(Some("alice"), &native("one"))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("target")
    );
    c.organization_command(Some("alice"), restore).unwrap();
    assert_eq!(
        c.organization_conversation(Some("alice"), &native("one"))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        c.organization_conversation(Some("alice"), &native("two"))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("b")
    );
    let cycle = OrganizationCommand {
        key: "cycle-batch".into(),
        operation: OrganizationOperation::Restore {
            items: [("a", "b"), ("b", "a")]
                .iter()
                .map(|(id, target)| RestoreItem {
                    object: OrganizationObject::Container { id: (*id).into() },
                    expected_revision: 1,
                    expected_parent_id: None,
                    parent_id: Some((*target).into()),
                    before: None,
                    inherit: false,
                })
                .collect(),
            parents: vec![
                parent(&c, None),
                parent(&c, Some("a")),
                parent(&c, Some("b")),
            ],
        },
    };
    assert!(matches!(
        c.organization_command(Some("alice"), cycle),
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(
        c.resolve_organization_container(Some("alice"), "a")
            .unwrap()
            .parent_id,
        None
    );
}
#[test]
fn nullable_group_appearance_patch_clears_metadata_instead_of_ignoring_it() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "a", None);
    let add=serde_json::from_value(json!({"key":"decorate","operation":{"action":"update","id":"a","expectedRevision":1,"icon":"folder","color":"blue"}})).unwrap();
    c.organization_command(Some("alice"), add).unwrap();
    let clear=serde_json::from_value(json!({"key":"clear","operation":{"action":"update","id":"a","expectedRevision":2,"icon":null,"color":null}})).unwrap();
    c.organization_command(Some("alice"), clear).unwrap();
    let a = c
        .resolve_organization_container(Some("alice"), "a")
        .unwrap();
    assert_eq!(a.icon, None);
    assert_eq!(a.color, None);
    assert_eq!(a.name.as_deref(), Some("a"));
}

#[test]
fn trusted_creation_source_descriptor_is_frozen_with_original_placement_and_identity() {
    use varin_runtime::catalog::launches::SourceResourceOwner;
    let f = Fixture::new();
    let mut c = f.open();
    c.initialize_organization(
        Some("alice"),
        OrganizationInitialization {
            key: "init".into(),
            projects: vec![InitialProject {
                id: "project".into(),
            }],
            positions: vec![],
        },
    )
    .unwrap();
    let project = snap(&c).containers[0].id.clone();
    let placement = Some(Placement {
        container_id: Some(project.clone()),
    });
    let defaults = CreationDefaults {
        project_id: Some("project".into()),
        source: Some(CreationSource {
            selection: Some(ProjectSourceSelection::NativeWorkspace {
                workspace_id: "original-workspace".into(), execution_workspace_id: "adopted-view".into(),
                branch_id: "adopted-branch".into(), adoption_operation_id: "original-adoption".into(), native_scope: None,
            }),
            resource_owner: SourceResourceOwner::ManagedHost {
                host_id: "resource-host".into(),
                connection_id: "connection".into(),
                endpoint_identity: "pinned-endpoint".into(),
            },
            path: "/original/project".into(),
            workspace_id: Some("original-workspace".into()),
        }),
    };
    c.create_thread_with_organization_defaults(
        "one",
        "main",
        Some("alice"),
        placement.clone(),
        Some(defaults.clone()),
    )
    .unwrap();
    let move_it = move_command(
        &c,
        "move",
        vec![OrganizationObject::Native { id: "one".into() }],
        None,
    );
    c.organization_command(Some("alice"), move_it).unwrap();
    c.create_thread_with_organization_defaults(
        "one",
        "main",
        Some("alice"),
        placement.clone(),
        Some(defaults.clone()),
    )
    .unwrap();
    assert_eq!(
        c.organization_creation_defaults("one").unwrap(),
        Some(defaults.clone())
    );
    let mut changed_adoption = defaults.clone();
    changed_adoption.source.as_mut().unwrap().selection = Some(ProjectSourceSelection::LiveRoot);
    assert!(matches!(c.create_thread_with_organization_defaults("one", "main", Some("alice"), placement.clone(), Some(changed_adoption)), Err(RuntimeError::Conflict(_))));
    let mut different = defaults.clone();
    different.source.as_mut().unwrap().path = "/changed/project".into();
    assert!(matches!(
        c.create_thread_with_organization_defaults(
            "one",
            "main",
            Some("alice"),
            placement,
            Some(different)
        ),
        Err(RuntimeError::Conflict(_))
    ));
    drop(c);
    let c = f.open();
    assert_eq!(
        c.organization_creation_defaults("one").unwrap(),
        Some(defaults)
    );
}
#[test]
fn external_receipt_read_rejects_changed_intent_and_non_metadata_commands() {
    let f = Fixture::new();
    let mut c = f.open();
    external(
        &mut c,
        json!({"action":"create","id":"external","key":"create","configurationId":"codex","harness":"codex","title":"External","cwd":"/original","principalId":"alice"}),
    );
    external(
        &mut c,
        json!({"action":"update","id":"external","key":"pin","expectedRevision":1,"pinned":true}),
    );
    for command in [
        json!({"action":"update","id":"external","key":"pin","expectedRevision":1,"pinned":false}),
        json!({"action":"update","id":"external","expectedRevision":1,"pinned":true}),
        json!({"action":"inspect","id":"external"}),
    ] {
        let parsed =
            serde_json::from_value(json!({"action":"update_receipt","command":command})).unwrap();
        let prepared = c.prepare_external(parsed).load().unwrap();
        assert!(c.execute_external(prepared).is_err());
    }
}

#[test]
fn navigation_default_project_is_frozen_without_rewriting_the_original_dispatch_call() {
    use varin_runtime::execution::ToolCall;
    let mut f = child_fixture::Fixture::new_project_dispatch();
    f.db.initialize_organization(
        None,
        OrganizationInitialization {
            key: "initial".into(),
            projects: vec![InitialProject {
                id: "project-B".into(),
            }],
            positions: vec![],
        },
    )
    .unwrap();
    let project =
        f.db.organization_snapshot(None, OrganizationQuery::default())
            .unwrap()
            .containers[0]
            .id
            .clone();
    public_group(&mut f.db, "target");
    let snapshot =
        f.db.organization_snapshot(None, OrganizationQuery::default())
            .unwrap();
    f.db.organization_command(
        None,
        OrganizationCommand {
            key: "put-group-in-project".into(),
            operation: OrganizationOperation::Move {
                items: vec![MoveItem {
                    object: OrganizationObject::Container {
                        id: "target".into(),
                    },
                    expected_revision: 1,
                    expected_parent_id: None,
                }],
                parent_id: Some(project.clone()),
                before: None,
                parents: vec![
                    ParentVersion {
                        container_id: None,
                        children_revision: snapshot.root_revision,
                    },
                    ParentVersion {
                        container_id: Some(project.clone()),
                        children_revision: f
                            .db
                            .resolve_organization_container(None, &project)
                            .unwrap()
                            .children_revision,
                    },
                ],
            },
        },
    )
    .unwrap();
    f.accept();
    f.settle_exchange();
    f.input.project_id = None;
    f.input.organization = Some(Placement {
        container_id: Some("target".into()),
    });
    let original = serde_json::to_value(&f.input).unwrap();
    f.context = f.admit_policy_call(ToolCall {
        call_id: "organization-default".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: original.clone(),
    });
    f.db.freeze_dispatch_organization_default(&f.context, &f.input)
        .unwrap();
    let directory =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(
        directory.project(&f.input).unwrap().unwrap().id,
        "project-B"
    );
    assert_eq!(serde_json::to_value(&f.input).unwrap(), original);
    let snapshot =
        f.db.organization_snapshot(None, OrganizationQuery::default())
            .unwrap();
    let target = f.db.resolve_organization_container(None, "target").unwrap();
    f.db.organization_command(
        None,
        OrganizationCommand {
            key: "move-group-out".into(),
            operation: OrganizationOperation::Move {
                items: vec![MoveItem {
                    object: OrganizationObject::Container {
                        id: "target".into(),
                    },
                    expected_revision: target.revision,
                    expected_parent_id: Some(project.clone()),
                }],
                parent_id: None,
                before: None,
                parents: vec![
                    ParentVersion {
                        container_id: None,
                        children_revision: snapshot.root_revision,
                    },
                    ParentVersion {
                        container_id: Some(project.clone()),
                        children_revision: f
                            .db
                            .resolve_organization_container(None, &project)
                            .unwrap()
                            .children_revision,
                    },
                ],
            },
        },
    )
    .unwrap();
    f.db.freeze_dispatch_organization_default(&f.context, &f.input)
        .unwrap();
    let directory =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    assert_eq!(
        directory.project(&f.input).unwrap().unwrap().id,
        "project-B"
    );
    let selected = directory.resolve(&f.input).unwrap();
    let mut launch = f.launch.clone();
    launch.tools = directory
        .frozen
        .allowed_delegation
        .iter()
        .filter(|tool| selected.profile.tools.contains(&tool.name))
        .cloned()
        .collect();
    let prepared =
        f.db.prepare_child_launch(&f.context.run_id, launch, selected)
            .unwrap()
            .load()
            .unwrap();
    let admission =
        f.db.prepare_child_admission(&f.context, f.input.clone(), None, prepared)
            .unwrap()
            .load()
            .unwrap();
    let child = f.db.accept_child_references(admission).unwrap();
    assert_eq!(child.project_id.as_deref(), Some("project-B"));
    assert_eq!(
        f.db.organization_conversation(None, &native(&child.child_thread_id))
            .unwrap()
            .position
            .container_id
            .as_deref(),
        Some("target")
    );
}

#[path = "fixtures/input_admission.rs"]
mod organization_input_admission;
#[test]
fn deeply_nested_real_dispatch_reports_its_immediate_parent_not_the_placement_ancestor() {
    use organization_input_admission::InputAdmission;
    use varin_runtime::catalog::{context::ContextProposal, dispatch::ChildModelBinding};
    use varin_runtime::execution::{ToolCall, ToolSchema};
    let schema = |name: &str| ToolSchema {
        name: name.into(),
        version: "1".into(),
        description: String::new(),
        schema: json!({"type":"object"}),
        requirements: None,
        output_schema: None,
        metadata: None,
    };
    let mut f = child_fixture::Fixture::new_parent_custom(
        7,
        schema("file_read"),
        schema("dispatch"),
        false,
        false,
        false,
        |input, _| {
            input.tools = None;
        },
    );
    public_group(&mut f.db, "a");
    public_move(&mut f.db, "place-root", "thread:parent", Some("a"));
    let directory =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let selected = directory.resolve(&f.input).unwrap();
    f.launch.agent = selected.agent;
    f.launch.tools = directory.frozen.allowed_delegation.clone();
    drop(directory);
    let child = f.accept();
    let mut source = child.source.pin().unwrap().source.clone();
    source.branch_id = Some(format!("child-source:{}", child.operation_id));
    source.revision = Some(0);
    let proposal = ContextProposal {
        key: format!("child-context:{}", child.operation_id),
        branch_id: child.child_branch_id.clone(),
        through_id: None,
        expected_revision: 0,
        summary: String::new(),
        effective_system_prompt: "Read-only child".into(),
        instruction_sources: vec!["review:child".into()],
        memory_checkpoint: None,
    };
    let basis=serde_json::from_value(json!({"mode":"agent","threadRole":"worker","revision":0,"configurationDigest":"review:child-profile:0","memorySnapshot":{"revision":0,"memories":[]},"threadId":child.child_thread_id,"projectId":child.project_id,"originalSections":[{"name":"preamble","content":"Read-only child"}],"instructionSources":["review:child"]})).unwrap();
    let child =
        f.db.prepare_child(&child.operation_id, source, proposal, basis)
            .unwrap();
    let run_id = child.receipt.as_ref().unwrap().run_id.clone();
    let launch = f.db.launch_intent(&run_id).unwrap().unwrap().selection;
    let prepared =
        f.db.prepare_child_dispatch_binding(
            &run_id,
            ChildModelBinding {
                configuration: serde_json::from_value(f.db.run(&run_id).unwrap().configuration)
                    .unwrap(),
                credential_scope: launch.credential_scope.clone(),
            },
            launch.tool_schema_generation,
            launch.tools.clone(),
        )
        .unwrap()
        .load()
        .unwrap();
    f.db.bind_child_dispatch(&run_id, prepared).unwrap();
    f.context.run_id = run_id;
    f.context = f.admit_policy_call(ToolCall {
        call_id: "nested-dispatch".into(),
        name: "dispatch".into(),
        schema_version: "1".into(),
        arguments: serde_json::to_value(&f.input).unwrap(),
    });
    f.pin.source = launch.source.clone().unwrap();
    f.launch = launch;
    let directory =
        f.db.capture_child_dispatch_invocation(&f.context)
            .unwrap()
            .load()
            .unwrap();
    let selected = directory.resolve(&f.input).unwrap();
    f.launch.agent = selected.agent;
    f.launch.tools = directory.frozen.allowed_delegation.clone();
    drop(directory);
    let grandchild = f.accept();
    let placement =
        f.db.organization_conversation(None, &native(&grandchild.child_thread_id))
            .unwrap();
    assert!(!placement.position.explicit);
    assert_eq!(placement.position.container_id.as_deref(), Some("a"));
    assert_eq!(
        placement.position.inherited_from,
        Some(native(&child.child_thread_id))
    );
    assert_eq!(
        placement.origin.conversation,
        Some(native(&child.child_thread_id))
    );
}

#[test]
fn published_foundation_95_upgrades_positions_without_rewriting_creation_receipts() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "group", None);
    c.create_thread_with_placement(
        "kept",
        "kept-main",
        Some("alice"),
        Some(Placement {
            container_id: Some("group".into()),
        }),
    )
    .unwrap();
    let thread = c.inspect_thread("kept").unwrap();
    let position = c
        .organization_conversation(Some("alice"), &native("kept"))
        .unwrap()
        .position;
    let commands = raw(&f)
        .prepare("SELECT scope,key,intent,receipt FROM organization_commands ORDER BY scope,key")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    raw(&f)
        .execute_batch(
            "ALTER TABLE organization_positions DROP COLUMN is_explicit;PRAGMA user_version=95;",
        )
        .unwrap();
    drop(c);
    let c = f.open();
    assert_eq!(c.inspect_thread("kept").unwrap(), thread);
    assert_eq!(
        c.organization_conversation(Some("alice"), &native("kept"))
            .unwrap()
            .position,
        position
    );
    let current = raw(&f)
        .prepare("SELECT scope,key,intent,receipt FROM organization_commands ORDER BY scope,key")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(commands, current);
    assert_eq!(
        raw(&f)
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        97
    );
}
#[test]
fn bot_public_scope_and_entry_resolution_never_claim_foreign_sessions() {
    let f=Fixture::new(); let mut c=f.open();
    c.publish_bot_gate(bot::BotGate{bot_id:"bot".into(),profile_revision:1,activity_operation_id:None,permitted:true}).unwrap();
    c.create_bot_thread_with_placement("alice","ab","bot",Some("alice"),None).unwrap();
    c.create_bot_thread_with_placement("bob","bb","bot",Some("bob"),None).unwrap();
    let public=c.resolve_bot_entry_scoped("alice","ab","bot",None).unwrap();
    assert_eq!(c.thread_principal(&public.thread_id).unwrap(),None);
    assert_ne!(public.thread_id,"alice");
    assert_eq!(c.resolve_bot_entry_scoped("alice","ab","bot",Some("bob".into())).unwrap().thread_id,"bob");
    assert_eq!(c.resolve_bot_entry_scoped("alice","ab","bot",None).unwrap().thread_id,public.thread_id);
    let alice=c.inspect_bot_scope_scoped("bot",false,Some(Some("alice".into()))).unwrap();
    assert_eq!(alice["sessions"],json!(["alice"])); assert_eq!(alice["threads"].as_array().unwrap().len(),1);
    let public_view=c.inspect_bot_scope_scoped("bot",false,Some(None)).unwrap();
    assert_eq!(public_view["sessions"],json!([public.thread_id]));
    assert_eq!(c.inspect_bot_scope("bot").unwrap()["sessions"].as_array().unwrap().len(),3);
    assert_eq!(c.thread_principal("alice").unwrap().as_deref(),Some("alice"));
    assert!(c.capture_bot_history_scoped("bot","alice","ab","missing","missing",Some(Some("bob".into()))).is_err());
    assert!(c.capture_bot_activity_scoped("bot",None,None,Some(Some("alice".into()))).unwrap().load(&||false).unwrap().events.is_empty());
}
#[test]
fn bot_matter_reads_and_updates_reject_foreign_and_mixed_metadata() {
    use varin_runtime::catalog::bot_work::{BotMatter,MatterThread,MatterUpdate};
    let f=Fixture::new();let mut c=f.open();
    c.publish_bot_gate(bot::BotGate{bot_id:"bot".into(),profile_revision:1,activity_operation_id:None,permitted:true}).unwrap();
    c.create_bot_thread_with_placement("alice","ab","bot",Some("alice"),None).unwrap();
    c.create_bot_thread_with_placement("bob","bb","bot",Some("bob"),None).unwrap();
    let input=MatterUpdate{bot_id:"bot".into(),key:"one".into(),expected_revision:0,matter:BotMatter{id:"m".into(),revision:0,title:"Alice secret".into(),description:"Private".into(),archived:false,threads:vec![MatterThread{thread_id:"alice".into(),branch_id:"ab".into(),send:false,memory:false}]}};
    c.update_bot_matter_scoped(input.clone(),Some("alice".into())).unwrap();
    assert!(c.bot_matters_scoped("bot",Some(Some("bob".into()))).unwrap().is_empty());
    assert!(c.bot_matters_scoped("bot",Some(None)).unwrap().is_empty());
    assert_eq!(c.bot_matters_scoped("bot",Some(Some("alice".into()))).unwrap().len(),1);
    assert!(c.update_bot_matter_scoped(input.clone(),Some("bob".into())).is_err());
    let mut mixed=input; mixed.key="mixed".into();mixed.expected_revision=1;mixed.matter.threads.push(MatterThread{thread_id:"bob".into(),branch_id:"bb".into(),send:false,memory:false});
    assert!(c.update_bot_matter_scoped(mixed.clone(),Some("alice".into())).is_err());
    c.update_bot_matter(mixed,None).unwrap();
    assert!(c.bot_matters_scoped("bot",Some(Some("alice".into()))).unwrap().is_empty());
    assert_eq!(c.bot_matters("bot").unwrap().len(),1);
}

#[test]
fn model_matter_update_checks_principal_before_receipt_and_preserves_grant_rules() {
    use varin_runtime::catalog::bot_work::{BotMatter,MatterThread,MatterUpdate};
    let mut f=child_fixture::Fixture::new_in_bot("bot");
    f.db.create_thread_with_placement("foreign","foreign-branch",Some("alice"),None).unwrap();
    f.db.create_thread_with_placement("ordinary","ordinary-branch",None,None).unwrap();
    let link=|thread:&str,branch:&str,send:bool,memory:bool|MatterThread{thread_id:thread.into(),branch_id:branch.into(),send,memory};
    let input=|key:&str,id:&str,links:Vec<MatterThread>|MatterUpdate{bot_id:"bot".into(),key:key.into(),expected_revision:0,matter:BotMatter{id:id.into(),revision:0,title:"Original private title".into(),description:"Private description".into(),archived:false,threads:links}};
    let foreign=input("foreign-key","foreign-matter",vec![link("foreign","foreign-branch",true,true)]);
    f.db.update_bot_matter(foreign.clone(),None).unwrap();
    // Exact original key cannot leak its receipt to a different principal's model.
    assert!(matches!(f.db.update_bot_matter(foreign.clone(),Some(&f.context)),Err(RuntimeError::Conflict(message)) if message.contains("principal")));
    let mut edit=foreign;edit.key="foreign-edit".into();edit.expected_revision=1;
    edit.matter.title="Hijack".into();
    assert!(matches!(f.db.update_bot_matter(edit.clone(),Some(&f.context)),Err(RuntimeError::Conflict(message)) if message.contains("principal")));
    // Replacing all foreign links with the caller's own family still cannot claim it.
    edit.matter.threads=vec![link("thread:parent","branch:parent",false,false)];
    assert!(matches!(f.db.update_bot_matter(edit,Some(&f.context)),Err(RuntimeError::Conflict(message)) if message.contains("principal")));
    // Same-principal discoverability is not a grant to send or use memory.
    let ordinary=input("grant","ordinary-matter",vec![link("ordinary","ordinary-branch",false,false)]);
    f.db.update_bot_matter(ordinary.clone(),None).unwrap();
    for (send,memory) in [(true,false),(false,true)] {
        let mut change=ordinary.clone();change.key=format!("escalate-{send}-{memory}");change.expected_revision=1;change.matter.threads=vec![link("ordinary","ordinary-branch",send,memory)];
        assert!(matches!(f.db.update_bot_matter(change,Some(&f.context)),Err(RuntimeError::Conflict(message)) if message.contains("explicit user link")));
    }
    let mut own=input("own","own-matter",vec![link("thread:parent","branch:parent",false,false)]);
    own.matter.title="Own work".into();
    f.db.update_bot_matter(own,Some(&f.context)).unwrap();
}

#[test]
fn large_metadata_directory_pages_and_moves_without_loading_history() {
    use std::time::Instant;
    let f=Fixture::new();let mut c=f.open();
    for n in 0..32 {
        let parent=(n%4!=0).then(||format!("scale-group-{}",n-1));
        group(&mut c,&format!("scale-group-{n}"),parent.as_deref());
    }
    // Seed pre-existing ordinary assets in one fixture transaction. The measured
    // production reads/moves remain public Catalog APIs, not synthetic projections.
    let mut db=raw(&f);let tx=db.transaction().unwrap();
    for n in 0..2048 {
        let name=format!("scale-thread-{n:04}");
        tx.execute("INSERT INTO threads(id,principal_id,agent_code,title) VALUES(?1,'alice',?1,?1)",[&name]).unwrap();
        tx.execute("INSERT INTO branches(id,thread_id) VALUES(?1,?2)",rusqlite::params![format!("scale-branch-{n:04}"),name]).unwrap();
        if n%2==0 { tx.execute("INSERT INTO organization_positions(scope,kind,id,container_id,sort_order,revision,is_explicit) VALUES(?1,'native',?2,?3,?4,1,1)",rusqlite::params![serde_json::to_string(&Some("alice")).unwrap(),name,format!("scale-group-{}",n%32),n]).unwrap(); }
    }
    tx.commit().unwrap();drop(db);
    let started=Instant::now();
    let query=OrganizationQuery{root_only:true,limit:Some(50),..Default::default()};
    let first=c.organization_snapshot(Some("alice"),query.clone()).unwrap();
    eprintln!("organization scale: 2048 threads, 32 containers, root first50 {:?}",started.elapsed());
    assert_eq!(first.conversations.len(),50);
    let old_cursor=first.next_cursor.clone().unwrap();
    let mut seen=BTreeSet::new();let mut page=first;
    loop {
        for item in page.conversations { let ConversationRef::Native{id}=item.conversation else {panic!("native fixture")}; assert!(seen.insert(id)); }
        let Some(cursor)=page.next_cursor else {break};
        page=c.organization_snapshot(Some("alice"),OrganizationQuery{cursor:Some(cursor),..query.clone()}).unwrap();
    }
    assert_eq!(seen.len(),1024);
    eprintln!("organization scale: all root pages {:?}",started.elapsed());
    let command=move_command(&c,"scale-move",vec![OrganizationObject::Native{id:"scale-thread-0001".into()}],Some("scale-group-3"));
    c.organization_command(Some("alice"),command).unwrap();
    assert!(c.organization_snapshot(Some("alice"),OrganizationQuery{cursor:Some(old_cursor),..query}).is_err());
    let subtree=c.organization_snapshot(Some("alice"),OrganizationQuery{container_id:Some("scale-group-0".into()),recursive:true,limit:Some(2048),..Default::default()}).unwrap();
    assert_eq!(subtree.conversations.len(),129);
    for entry in subtree.conversations.iter().take(8) {
        let single=c.organization_conversation(Some("alice"),&entry.conversation).unwrap();
        assert_eq!(serde_json::to_value(entry).unwrap(),serde_json::to_value(single).unwrap());
    }
    let moved=c.organization_conversation(Some("alice"),&native("scale-thread-0001")).unwrap();
    assert_eq!(moved.path,vec!["scale-group-0","scale-group-1","scale-group-2","scale-group-3"]);
    assert_eq!(raw(&f).query_row("SELECT count(*) FROM history",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    eprintln!("organization scale: paging, subtree and move {:?}",started.elapsed());
}

#[test]
fn mixed_node_pages_include_empty_containers_and_preserve_interleaved_order() {
    let f = Fixture::new();
    let mut c = f.open();
    for n in 0..9 {
        group(&mut c, &format!("empty-{n}"), None);
        if n % 3 == 0 {
            c.create_thread_with_placement(
                &format!("thread-{n}"),
                &format!("branch-{n}"),
                Some("alice"),
                Some(Placement { container_id: None }),
            )
            .unwrap();
        }
    }
    let expected = siblings(&c);
    let query = OrganizationQuery {
        page_nodes: true,
        root_only: true,
        limit: Some(2),
        ..Default::default()
    };
    let mut cursor = None;
    let mut items = Vec::new();
    let mut pages = 0;
    loop {
        let page = c
            .organization_snapshot(
                Some("alice"),
                OrganizationQuery {
                    cursor,
                    ..query.clone()
                },
            )
            .unwrap();
        let actual = page.items.unwrap();
        assert!(!actual.is_empty());
        assert!(actual.len() <= 2);
        assert_eq!(
            page.containers.len() + page.conversations.len(),
            actual.len()
        );
        items.extend(actual);
        pages += 1;
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(pages, 6);
    assert_eq!(items, expected);
    // Legacy mode remains the explicit full metadata index, even with a tiny conversation page.
    let old = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(old.items.is_none());
    assert_eq!(old.containers.len(), 9);
    assert_eq!(old.conversations.len(), 1);
    assert!(serde_json::to_value(old).unwrap().get("items").is_none());
}

#[test]
fn mixed_pages_keep_only_necessary_ancestors_and_search_does_not_expand_siblings() {
    let f = Fixture::new();
    let mut c = f.open();
    group(&mut c, "root", None);
    group(&mut c, "nested", Some("root"));
    group(&mut c, "needle-group", Some("nested"));
    group(&mut c, "unrelated-root", None);
    group(&mut c, "unrelated-child", Some("unrelated-root"));
    c.create_thread_with_placement(
        "ordinary",
        "ordinary-main",
        Some("alice"),
        Some(Placement {
            container_id: Some("needle-group".into()),
        }),
    )
    .unwrap();
    let page = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                page_nodes: true,
                container_id: Some("nested".into()),
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        page.items,
        Some(vec![OrganizationObject::Container {
            id: "needle-group".into()
        }])
    );
    assert_eq!(
        page.containers
            .iter()
            .map(|c| c.id.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["root", "nested", "needle-group"])
    );
    assert!(page.conversations.is_empty());
    assert!(page.next_cursor.is_none());
    let search = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                page_nodes: true,
                query: Some("needle-group".into()),
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(search.items, page.items);
    assert!(search.conversations.is_empty());
    assert!(search.next_cursor.is_none());
    let children = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                page_nodes: true,
                container_id: Some("needle-group".into()),
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        children.items,
        Some(vec![OrganizationObject::Native {
            id: "ordinary".into()
        }])
    );
    assert_eq!(children.containers.len(), 3);
    assert_eq!(children.conversations.len(), 1);
}

#[test]
fn mixed_page_continuation_rejects_reorder_and_preserves_query_and_legacy_modes() {
    let f = Fixture::new();
    let mut c = f.open();
    for id in ["a", "b", "c", "d"] {
        group(&mut c, id, None);
    }
    let query = OrganizationQuery {
        page_nodes: true,
        root_only: true,
        limit: Some(2),
        ..Default::default()
    };
    let page = c
        .organization_snapshot(Some("alice"), query.clone())
        .unwrap();
    let cursor = page.next_cursor.unwrap();
    assert!(
        c.organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                page_nodes: false,
                cursor: Some(cursor.clone()),
                ..query.clone()
            }
        )
        .is_err()
    );
    let mut command = move_command(
        &c,
        "reorder",
        vec![OrganizationObject::Container { id: "d".into() }],
        None,
    );
    if let OrganizationOperation::Move { before, .. } = &mut command.operation {
        *before = Some(OrganizationObject::Container { id: "a".into() });
    }
    c.organization_command(Some("alice"), command).unwrap();
    assert!(
        c.organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                cursor: Some(cursor),
                ..query.clone()
            }
        )
        .is_err()
    );
    let fresh = c
        .organization_snapshot(Some("alice"), query.clone())
        .unwrap();
    assert_eq!(
        fresh.items,
        Some(vec![
            OrganizationObject::Container { id: "d".into() },
            OrganizationObject::Container { id: "a".into() }
        ])
    );
    let rest = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                cursor: fresh.next_cursor,
                ..query
            },
        )
        .unwrap();
    assert_eq!(
        rest.items,
        Some(vec![
            OrganizationObject::Container { id: "b".into() },
            OrganizationObject::Container { id: "c".into() }
        ])
    );
    assert!(rest.next_cursor.is_none());
    let legacy: OrganizationQuery =
        serde_json::from_value(json!({"rootOnly":true,"limit":2})).unwrap();
    assert!(!legacy.page_nodes);
}

#[test]
fn mixed_bot_scope_exposes_only_matching_branches_and_exact_principal() {
    let f = Fixture::new();
    let mut c = f.open();
    c.publish_bot_gate(bot::BotGate {
        bot_id: "bot".into(),
        profile_revision: 1,
        activity_operation_id: None,
        permitted: true,
    })
    .unwrap();
    group(&mut c, "matched", None);
    group(&mut c, "deep", Some("matched"));
    group(&mut c, "empty-other", None);
    c.create_bot_thread_with_placement(
        "alice-session",
        "alice-branch",
        "bot",
        Some("alice"),
        Some(Placement {
            container_id: Some("deep".into()),
        }),
    )
    .unwrap();
    c.create_bot_thread_with_placement("bob-session", "bob-branch", "bot", Some("bob"), None)
        .unwrap();
    let query = OrganizationQuery {
        page_nodes: true,
        root_only: true,
        bot_id: Some("bot".into()),
        limit: Some(1),
        ..Default::default()
    };
    let root = c
        .organization_snapshot(Some("alice"), query.clone())
        .unwrap();
    assert_eq!(
        root.items,
        Some(vec![OrganizationObject::Container {
            id: "matched".into()
        }])
    );
    assert_eq!(root.containers.len(), 1);
    assert!(root.next_cursor.is_none());
    let folders = c.organization_snapshot(Some("alice"), OrganizationQuery {
        kind: Some("containers".into()), ..query.clone()
    }).unwrap();
    assert_eq!(folders.items, root.items);
    assert!(folders.conversations.is_empty());
    let deep = c
        .organization_snapshot(
            Some("alice"),
            OrganizationQuery {
                container_id: Some("deep".into()),
                ..query.clone()
            },
        )
        .unwrap();
    assert_eq!(
        deep.items,
        Some(vec![OrganizationObject::Native {
            id: "alice-session".into()
        }])
    );
    assert_eq!(deep.containers.len(), 2);
    let public = c.organization_snapshot(None, query).unwrap();
    assert_eq!(public.items, Some(vec![]));
    assert!(public.containers.is_empty());
}

#[test]
fn work_directory_excludes_direct_bot_chats_before_pagination_and_retains_dispatched_tasks() {
    let mut f = child_fixture::Fixture::new_in_bot("bot");
    let child = f.accept();
    f.db.create_thread("human-work", "human-main").unwrap();
    let query = OrganizationQuery {
        page_nodes: true,
        kind: Some("conversations".into()),
        sort: Some("recent".into()),
        exclude_bot_conversations: Some(true),
        limit: Some(1),
        ..Default::default()
    };
    let first = f.db.organization_snapshot(None, query.clone()).unwrap();
    assert_eq!(first.conversations.len(), 1);
    assert!(first.next_cursor.is_some());
    let second = f.db.organization_snapshot(None, OrganizationQuery { cursor: first.next_cursor, ..query }).unwrap();
    let ids = first.conversations.iter().chain(second.conversations.iter()).map(|entry| entry.conversation.id()).collect::<BTreeSet<_>>();
    assert_eq!(ids, BTreeSet::from(["human-work", child.child_thread_id.as_str()]));
    assert!(first.conversations.iter().chain(&second.conversations).all(|entry| entry.origin.direct_bot_id.is_none()));
    let delegated = f.db.organization_conversation(None, &native(&child.child_thread_id)).unwrap();
    assert_eq!(delegated.origin.bot_id.as_deref(), Some("bot"));
    assert!(second.next_cursor.is_none());
    assert_eq!(f.db.organization_snapshot(None, OrganizationQuery::default()).unwrap().conversations.len(), 3);
    let tree = f.db.organization_snapshot(None, OrganizationQuery {
        kind: Some("conversations".into()), sort: Some("recent".into()), exclude_bot_conversations: Some(true),
        conversation_tree: Some(ConversationTreeQuery::default()), ..Default::default()
    }).unwrap();
    assert_eq!(tree.conversations.len(), 2);
    assert!(tree.conversations.iter().any(|entry| entry.conversation.id() == child.child_thread_id));
}

#[test]
fn recent_task_tree_pages_parents_and_children_separately_and_keeps_real_dispatch_ancestry() {
    let mut f = child_fixture::Fixture::new();
    let child = f.accept();
    f.db.create_thread("standalone", "standalone-main").unwrap();
    public_group(&mut f.db, "moved-category");
    public_move(&mut f.db, "move-child", &child.child_thread_id, Some("moved-category"));
    let db = Connection::open(f.root.join("conversation.sqlite")).unwrap();
    for (thread, updated, title) in [("thread:parent", 10, "Parent"), (&child.child_thread_id, 90, "Needle child"), ("standalone", 50, "Standalone")] {
        db.execute("UPDATE threads SET updated_at_ms=?2,title=?3 WHERE id=?1", rusqlite::params![thread, updated, title]).unwrap();
    }
    let query = OrganizationQuery {
        page_nodes: true, kind: Some("conversations".into()), sort: Some("recent".into()),
        conversation_tree: Some(ConversationTreeQuery::default()), limit: Some(1), ..Default::default()
    };
    let first = f.db.organization_snapshot(None, query.clone()).unwrap();
    assert_eq!(first.conversations.len(), 1);
    assert_eq!(first.conversations[0].conversation.id(), "thread:parent");
    assert_eq!(first.conversations[0].updated_at_ms, Some(90));
    assert_eq!(first.conversations[0].has_children, Some(true));
    let next = f.db.organization_snapshot(None, OrganizationQuery { cursor: first.next_cursor.clone(), ..query.clone() }).unwrap();
    assert_eq!(next.conversations[0].conversation.id(), "standalone");
    assert!(next.next_cursor.is_none());
    let children = OrganizationQuery { conversation_tree: Some(ConversationTreeQuery { parent: Some(native("thread:parent")) }), ..query.clone() };
    let child_page = f.db.organization_snapshot(None, children.clone()).unwrap();
    assert_eq!(child_page.conversations.len(), 1);
    assert_eq!(child_page.conversations[0].conversation.id(), child.child_thread_id);
    assert!(child_page.conversations[0].position.explicit);
    assert_eq!(child_page.conversations[0].has_children, Some(false));
    assert!(child_page.next_cursor.is_none());
    let searched = f.db.organization_snapshot(None, OrganizationQuery { query: Some("Needle".into()), ..query.clone() }).unwrap();
    assert_eq!(searched.conversations[0].conversation.id(), "thread:parent");
    assert_eq!(f.db.organization_snapshot(None, OrganizationQuery { query: Some("Needle".into()), ..children }).unwrap().conversations[0].conversation.id(), child.child_thread_id);
    db.execute("UPDATE threads SET archived=1 WHERE id='thread:parent'", []).unwrap();
    let orphan = f.db.organization_snapshot(None, query).unwrap();
    assert_eq!(orphan.conversations[0].conversation.id(), child.child_thread_id);
    assert_eq!(orphan.conversations[0].has_children, Some(false));
}

#[test]
fn mixed_project_search_uses_ephemeral_owner_names_and_binds_name_generation() {
    let f=Fixture::new();let mut c=f.open();
    c.initialize_organization(Some("alice"),OrganizationInitialization{key:"project-index".into(),projects:vec![InitialProject{id:"project-a".into()},InitialProject{id:"project-b".into()}],positions:vec![]}).unwrap();
    let names=std::collections::BTreeMap::from([("project-a".into(),"Research alpha".into()),("project-b".into(),"Research beta".into()),("unrelated-host-project".into(),"Private unrelated name".into())]);
    let query=OrganizationQuery{page_nodes:true,query:Some("Research".into()),project_names:Some(names),limit:Some(1),..Default::default()};
    let first=c.organization_snapshot(Some("alice"),query.clone()).unwrap();
    assert_eq!(first.items.as_ref().unwrap().len(),1);assert_eq!(first.containers.len(),1);assert!(first.containers[0].name.is_none());
    let cursor=first.next_cursor.unwrap();
    assert!(!cursor.contains("unrelated-host-project"));assert!(!cursor.contains("Private unrelated name"));
    let mut unrelated=query.clone();unrelated.project_names.as_mut().unwrap().insert("unrelated-host-project".into(),"Changed unrelated name".into());unrelated.cursor=Some(cursor.clone());
    assert!(c.organization_snapshot(Some("alice"),unrelated).is_ok());
    let second=c.organization_snapshot(Some("alice"),OrganizationQuery{cursor:Some(cursor.clone()),..query.clone()}).unwrap();
    assert_eq!(second.items.as_ref().unwrap().len(),1);assert_ne!(first.items,second.items);assert!(second.next_cursor.is_none());
    let mut changed=query;changed.project_names.as_mut().unwrap().insert("project-a".into(),"Renamed elsewhere".into());changed.cursor=Some(cursor);
    assert!(c.organization_snapshot(Some("alice"),changed).is_err());
    assert!(c.organization_snapshot(Some("alice"),OrganizationQuery{page_nodes:true,query:Some("Research".into()),..Default::default()}).unwrap().items.unwrap().is_empty());
    assert_eq!(c.organization_project_ids(Some("alice")).unwrap(),vec!["project-a","project-b"]);
    assert!(c.organization_project_ids(Some("bob")).unwrap().is_empty());
}

#[test]
fn organization_observation_owner_enforces_principal_and_original_run_holder() {
    use varin_runtime::catalog::model_references::ReferenceKind;
    let mut f=child_fixture::Fixture::new_in_bot("bot");
    public_group(&mut f.db,"source");public_group(&mut f.db,"destination");
    let snapshot=f.db.organization_snapshot(None,OrganizationQuery{page_nodes:true,root_only:true,limit:Some(1),..Default::default()}).unwrap();
    let reference=f.db.register_model_reference(ReferenceKind::Read,"organization_observation",&json!({"principal":null,"snapshot":snapshot}),&f.context.run_id).unwrap();
    assert!(f.db.organization_observation(None,&reference,&f.context.run_id).is_ok());
    assert!(f.db.organization_observation(Some("alice"),&reference,&f.context.run_id).is_err());
    let foreign=f.db.register_model_reference(ReferenceKind::Read,"organization_observation",&json!({"principal":null,"snapshot":snapshot,"differentObservation":true}),"foreign-run").unwrap();
    assert!(f.db.organization_observation(None,&foreign,&f.context.run_id).is_err());
    let wrong=f.db.register_model_reference(ReferenceKind::Read,"organization_page",&json!({"principal":null,"snapshot":snapshot}),&f.context.run_id).unwrap();
    assert!(f.db.organization_observation(None,&wrong,&f.context.run_id).is_err());
}

fn dissolve_public(c:&mut Catalog,id:&str,key:&str) {
    let container=c.resolve_organization_container(None,id).unwrap();
    let root=c.organization_snapshot(None,OrganizationQuery::default()).unwrap().root_revision;
    c.organization_command(None,OrganizationCommand{key:key.into(),operation:OrganizationOperation::Dissolve{id:id.into(),expected_revision:container.revision,parents:vec![ParentVersion{container_id:Some(id.into()),children_revision:container.children_revision},ParentVersion{container_id:container.parent_id,children_revision:root}]}}).unwrap();
}
#[test]
fn actual_native_dispatch_explicit_project_classifies_atomically_and_placement_wins() {
    use varin_runtime::execution::ToolCall;
    let mut f=child_fixture::Fixture::new_project_dispatch();
    let project=f.db.organization_snapshot(None,OrganizationQuery::default()).unwrap().containers.into_iter().find(|c|c.project_id.as_deref()==Some("project-B")).unwrap();
    public_group(&mut f.db,"parent-group");public_group(&mut f.db,"explicit-group");
    public_move(&mut f.db,"parent-location","thread:parent",Some("parent-group"));
    let child=f.accept();
    let entry=f.db.organization_conversation(None,&native(&child.child_thread_id)).unwrap();
    assert!(entry.position.explicit);assert_eq!(entry.position.container_id,Some(project.id.clone()));
    public_move(&mut f.db,"parent-moved","thread:parent",Some("explicit-group"));
    assert_eq!(f.db.organization_conversation(None,&native(&child.child_thread_id)).unwrap().position.container_id,Some(project.id.clone()));
    dissolve_public(&mut f.db,&project.id,"remove-project-entry");
    // Original accepted operation returns before resolving today's missing project.
    assert_eq!(f.accept().operation_id,child.operation_id);
    f.settle_exchange();
    f.input.organization=Some(Placement{container_id:Some("explicit-group".into())});
    f.context=f.admit_policy_call(ToolCall{call_id:"explicit-organization".into(),name:"dispatch".into(),schema_version:"1".into(),arguments:serde_json::to_value(&f.input).unwrap()});
    let explicit=f.accept();
    assert_eq!(f.db.organization_conversation(None,&native(&explicit.child_thread_id)).unwrap().position.container_id.as_deref(),Some("explicit-group"));
    assert!(matches!(explicit.source,varin_runtime::catalog::collaboration::ChildSource::Project{project,..} if project.id=="project-B"));
}
#[test]
fn dispatch_missing_formal_explicit_project_rolls_back_original_child_admission() {
    let mut f=child_fixture::Fixture::new_project_dispatch();
    let project=f.db.organization_snapshot(None,OrganizationQuery::default()).unwrap().containers.into_iter().find(|c|c.project_id.as_deref()==Some("project-B")).unwrap();
    dissolve_public(&mut f.db,&project.id,"removed-before-admission");
    assert!(matches!(f.try_accept(),Err(RuntimeError::Conflict(message)) if message.contains("no registered navigation entry")));
    assert!(f.db.inspect_thread(&format!("thread:child:{}",f.context.operation_id)).is_err());
    assert!(f.db.organization_snapshot(None,OrganizationQuery::default()).unwrap().conversations.iter().all(|e|e.conversation==native("thread:parent")));
}

#[test]
fn actual_external_dispatch_explicit_project_and_original_receipt_share_admission() {
    use organization_input_admission::InputAdmission;
    use varin_runtime::{catalog::dispatch::*,execution::*,*};
    let mut f=child_fixture::Fixture::new_project_dispatch();
    let project=f.db.organization_snapshot(None,OrganizationQuery::default()).unwrap().containers.into_iter().find(|c|c.project_id.as_deref()==Some("project-B")).unwrap();
    let mut launch=f.db.launch_intent(&f.context.run_id).unwrap().unwrap().selection;
    launch.child_dispatch.as_mut().unwrap().presets.push(ChildPreset{work_focus:vec![],external:Some(ExternalChildBinding{configuration_id:"codex".into(),harness:"codex".into(),model:None,launch:ExternalLaunch{command:"codex".into(),args:vec![]}}),description:None,avatar:None,id:"external".into(),name:"External worker".into(),instructions:String::new(),tools:vec![],tools_source:ChildPresetToolsSource::Explicit,retired_work_mode:None,model_source:ChildModelSource::Inherit,inherit_base:None,model:None,unavailable:None});
    f.db.create_thread("external-parent","external-main").unwrap();
    let configuration=f.db.run(&f.context.run_id).unwrap().configuration;
    let run=f.db.submit_with_launch(&SubmitInput{key:"external-parent".into(),thread_id:"external-parent".into(),branch_id:"external-main".into(),expected_head:None,input:json!({"text":"Delegate external project work"}),configuration},Some(launch.clone())).unwrap();
    let model=ChildModelBinding{configuration:serde_json::from_value(f.db.run(&run.run_id).unwrap().configuration).unwrap(),credential_scope:launch.credential_scope.clone()};
    let prepared=f.db.prepare_child_dispatch_binding(&run.run_id,model,launch.tool_schema_generation,launch.tools.clone()).unwrap().load().unwrap();f.db.bind_child_dispatch(&run.run_id,prepared).unwrap();
    f.context.run_id=run.run_id.clone();f.launch=launch;
    let mut input=f.input.clone();input.preset=Some("external".into());input.tools=None;input.work_mode=Some(ChildWorkMode::Shared);
    let context=f.admit_policy_call(ToolCall{call_id:"external-project".into(),name:"dispatch".into(),schema_version:"1".into(),arguments:serde_json::to_value(&input).unwrap()});
    let selected=f.db.capture_child_dispatch_invocation(&context).unwrap().load().unwrap();let preset=selected.external_preset(&input).unwrap().unwrap();
    let prepared=f.db.prepare_external_child(&context,&input,&selected,&preset,None).unwrap().load().unwrap();let child=f.db.accept_external_child(prepared).unwrap();
    let command=serde_json::from_value(json!({"action":"create","id":child.conversation_id,"key":"external-conversation","configurationId":"codex","harness":"codex","title":"External worker","cwd":"/registered/project-B"})).unwrap();let prepared=f.db.prepare_external(command).load().unwrap();f.db.execute_external(prepared).unwrap().load().unwrap();
    let reference=ConversationRef::External{id:child.conversation_id.clone()};
    assert_eq!(f.db.organization_conversation(None,&reference).unwrap().position.container_id,Some(project.id.clone()));
    dissolve_public(&mut f.db,&project.id,"external-project-dissolved");
    let prepared=f.db.prepare_external_child(&context,&input,&selected,&preset,None).unwrap().load().unwrap();let replay=f.db.accept_external_child(prepared).unwrap();
    assert_eq!(replay.conversation_id,child.conversation_id);assert_eq!(replay.operation_id,child.operation_id);
    assert_eq!(f.db.organization_conversation(None,&reference).unwrap().position.container_id,None);
}
