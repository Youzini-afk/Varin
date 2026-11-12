//! Shared navigation only. Execution provenance, content and project settings retain their owners.
use super::*;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConversationRef {
    Native { id: String },
    External { id: String },
}
impl ConversationRef {
    pub fn id(&self) -> &str {
        match self {
            Self::Native { id } | Self::External { id } => id,
        }
    }
    fn kind(&self) -> &str {
        match self {
            Self::Native { .. } => "native",
            Self::External { .. } => "external",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContainerKind {
    Group,
    Project,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Container {
    pub id: String,
    pub kind: ContainerKind,
    pub parent_id: Option<String>,
    pub order: u64,
    pub revision: u64,
    pub children_revision: u64,
    pub name: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub project_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Placement {
    pub container_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub conversation: ConversationRef,
    pub container_id: Option<String>,
    pub order: u64,
    pub revision: u64,
    pub explicit: bool,
    pub inherited_from: Option<ConversationRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub bot_id: Option<String>,
    pub conversation: Option<ConversationRef>,
    pub direct_bot_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationEntry {
    pub conversation: ConversationRef,
    pub title: String,
    pub archived: bool,
    pub pinned: bool,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_children: Option<bool>,
    pub position: Position,
    pub origin: Origin,
    pub path: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizationQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_bot_conversations: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_tree: Option<ConversationTreeQuery>,
    pub container_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page_nodes: bool,
    /// Ephemeral names supplied by the trusted Settings owner, never model arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_names: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub root_only: bool,
    #[serde(default)]
    pub recursive: bool,
    pub query: Option<String>,
    pub bot_id: Option<String>,
    /// exclude (default), include, only.
    pub archived: Option<String>,
    pub limit: Option<u64>,
    pub cursor: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationTreeQuery {
    pub parent: Option<ConversationRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationSnapshot {
    pub initialized: bool,
    pub revision: u64,
    pub root_revision: u64,
    pub cursor: u64,
    pub containers: Vec<Container>,
    pub conversations: Vec<ConversationEntry>,
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<OrganizationObject>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentVersion {
    pub container_id: Option<String>,
    pub children_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OrganizationObject {
    Container { id: String },
    Native { id: String },
    External { id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveItem {
    pub object: OrganizationObject,
    pub expected_revision: u64,
    pub expected_parent_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreItem {
    pub object: OrganizationObject,
    pub expected_revision: u64,
    pub expected_parent_id: Option<String>,
    pub parent_id: Option<String>,
    pub before: Option<OrganizationObject>,
    #[serde(default)]
    pub inherit: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OrganizationOperation {
    Create {
        id: String,
        kind: ContainerKind,
        parent_id: Option<String>,
        name: Option<String>,
        icon: Option<String>,
        color: Option<String>,
        project_id: Option<String>,
        parents: Vec<ParentVersion>,
        before: Option<OrganizationObject>,
    },
    Update {
        id: String,
        expected_revision: u64,
        name: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "principals::optional_principal"
        )]
        icon: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "principals::optional_principal"
        )]
        color: Option<Option<String>>,
    },
    Move {
        items: Vec<MoveItem>,
        parent_id: Option<String>,
        before: Option<OrganizationObject>,
        parents: Vec<ParentVersion>,
    },
    Restore {
        items: Vec<RestoreItem>,
        parents: Vec<ParentVersion>,
    },
    Dissolve {
        id: String,
        expected_revision: u64,
        parents: Vec<ParentVersion>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizationCommand {
    pub key: String,
    pub operation: OrganizationOperation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationReceipt {
    pub key: String,
    pub revision: u64,
    pub cursor: u64,
    pub containers: Vec<Container>,
    pub positions: Vec<Position>,
    pub removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_defaults: Option<CreationDefaults>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreationDefaults {
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<CreationSource>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectSourceSelection {
    LiveRoot,
    NativeWorkspace {
        #[serde(rename = "workspaceId")] workspace_id: String,
        #[serde(rename = "executionWorkspaceId")] execution_workspace_id: String,
        #[serde(rename = "branchId")] branch_id: String,
        #[serde(rename = "adoptionOperationId")] adoption_operation_id: String,
        #[serde(rename = "nativeScope", default, skip_serializing_if = "Option::is_none")] native_scope: Option<String>,
    },
}
impl ProjectSourceSelection {
    pub fn valid(&self, workspace: Option<&str>) -> bool {
        match self {
            Self::LiveRoot => true,
            Self::NativeWorkspace { workspace_id, execution_workspace_id, branch_id, adoption_operation_id, native_scope } =>
                [workspace_id, execution_workspace_id, branch_id, adoption_operation_id].iter().all(|id| !id.trim().is_empty() && !id.contains('\0'))
                && workspace.is_none_or(|id| id == workspace_id)
                && native_scope.as_deref().is_none_or(|scope| !scope.contains('\0') && !scope.starts_with('/') && !scope.contains('\\') && scope.split('/').all(|part| part != "..")),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreationSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ProjectSourceSelection>,
    pub resource_owner: launches::SourceResourceOwner,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialProject {
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitialPosition {
    pub conversation: ConversationRef,
    pub project_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrganizationInitialization {
    pub key: String,
    pub projects: Vec<InitialProject>,
    pub positions: Vec<InitialPosition>,
}

pub(super) fn initialize(db: &Connection) -> Result<()> {
    initialize_95(db)?;
    upgrade_95(db)
}
pub(super) fn upgrade_95(db: &Connection) -> Result<()> {
    db.execute_batch("ALTER TABLE organization_positions ADD COLUMN is_explicit INTEGER NOT NULL DEFAULT 1 CHECK(is_explicit IN(0,1));")?;
    Ok(())
}
/// Published foundation generation. Never reconstruct a different schema under its marker.
pub(super) fn initialize_95(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE organization_spaces(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,root_revision INTEGER NOT NULL DEFAULT 0,initialization TEXT);
        CREATE TABLE organization_retired_containers(scope TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE TABLE organization_containers(scope TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,sort_order INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id));
        CREATE UNIQUE INDEX organization_project_identity ON organization_containers(scope,json_extract(body,'$.projectId')) WHERE json_extract(body,'$.kind')='project';
        CREATE INDEX organization_container_parent ON organization_containers(scope,parent_id,sort_order);
        CREATE TABLE organization_positions(scope TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,container_id TEXT,sort_order INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,kind,id));
        CREATE INDEX organization_position_parent ON organization_positions(scope,container_id,sort_order);
        CREATE TABLE organization_commands(scope TEXT NOT NULL,key TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(scope,key));")?;
    Ok(())
}
pub(super) fn check_format(db: &Connection, version: i64) -> Result<()> {
    db.prepare("SELECT scope,revision,root_revision,initialization FROM organization_spaces")?;
    db.prepare("SELECT scope,id,parent_id,sort_order,body FROM organization_containers")?;
    db.prepare(
        "SELECT scope,kind,id,container_id,sort_order,revision FROM organization_positions",
    )?;
    db.prepare("SELECT scope,key,intent,receipt FROM organization_commands")?;
    db.prepare("SELECT scope,id FROM organization_retired_containers")?;
    for (table, expected) in [
        ("organization_spaces", vec!["scope"]),
        ("organization_containers", vec!["scope", "id"]),
        ("organization_positions", vec!["scope", "kind", "id"]),
        ("organization_commands", vec!["scope", "key"]),
        ("organization_retired_containers", vec!["scope", "id"]),
    ] {
        let mut keys = db
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, u32>(5)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        keys.retain(|(_, position)| *position > 0);
        keys.sort_by_key(|(_, position)| *position);
        if keys
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            != expected
        {
            return Err(RuntimeError::Invalid(
                "organization identity constraints are missing; assets preserved".into(),
            ));
        }
    }
    let indexes:u32=db.query_row("SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN('organization_project_identity','organization_container_parent','organization_position_parent')",[],|r|r.get(0))?;
    if indexes != 3 {
        return Err(RuntimeError::Invalid(
            "organization indexes are missing; assets preserved".into(),
        ));
    }
    let has_inheritance:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('organization_positions') WHERE name='is_explicit')",[],|r|r.get(0))?;
    if has_inheritance != (version >= 96) {
        return Err(RuntimeError::Invalid(
            "organization inheritance schema does not match its published format; assets preserved"
                .into(),
        ));
    }
    if has_inheritance {
        let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM organization_positions WHERE is_explicit NOT IN(0,1) OR (is_explicit=0 AND container_id IS NOT NULL))",[],|r|r.get(0))?;
        if invalid {
            return Err(RuntimeError::Invalid(
                "invalid inherited organization position; assets preserved".into(),
            ));
        }
    }

    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM organization_containers c LEFT JOIN organization_spaces s ON s.scope=c.scope WHERE s.scope IS NULL OR c.sort_order<0 OR NOT json_valid(c.body) OR c.id!=json_extract(c.body,'$.id') OR c.parent_id IS NOT json_extract(c.body,'$.parentId') OR c.sort_order!=json_extract(c.body,'$.order') OR json_extract(c.body,'$.revision')<1 OR (c.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM organization_containers p WHERE p.scope=c.scope AND p.id=c.parent_id))) OR EXISTS(SELECT 1 FROM organization_positions p WHERE NOT EXISTS(SELECT 1 FROM organization_spaces s WHERE s.scope=p.scope) OR p.kind NOT IN('native','external') OR p.revision<1 OR p.sort_order<0 OR (p.container_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM organization_containers c WHERE c.scope=p.scope AND c.id=p.container_id)))",[],|r|r.get(0))?;
    if invalid {
        return Err(RuntimeError::Invalid(
            "invalid conversation organization; assets preserved".into(),
        ));
    }
    let scopes = db
        .prepare("SELECT scope FROM organization_spaces")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for scope in scopes {
        let _: Option<String> = serde_json::from_str(&scope)?;
        for c in containers(db, &scope)? {
            path(db, &scope, Some(&c.id))?;
        }
    }
    Ok(())
}
fn scope(principal: Option<&str>) -> Result<String> {
    if let Some(p) = principal {
        principals::validate(p)?;
    }
    encode(&principal)
}
fn ensure_space(db: &Connection, scope: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO organization_spaces(scope) VALUES(?1)",
        [scope],
    )?;
    Ok(())
}
fn container(db: &Connection, scope: &str, id: &str) -> Result<Container> {
    let raw: Option<String> = db
        .query_row(
            "SELECT body FROM organization_containers WHERE scope=?1 AND id=?2",
            params![scope, id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(serde_json::from_str(&raw.ok_or_else(|| {
        RuntimeError::NotFound("organization container".into())
    })?)?)
}
fn containers(db: &Connection, scope: &str) -> Result<Vec<Container>> {
    db.prepare("SELECT body FROM organization_containers WHERE scope=?1 ORDER BY sort_order,id")?
        .query_map([scope], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect()
}
fn save_container(db: &Connection, scope: &str, c: &Container) -> Result<()> {
    db.execute("INSERT INTO organization_containers(scope,id,parent_id,sort_order,body) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(scope,id) DO UPDATE SET parent_id=excluded.parent_id,sort_order=excluded.sort_order,body=excluded.body",params![scope,c.id,c.parent_id,sql_number(c.order)?,encode(c)?])?;
    Ok(())
}
fn path(db: &Connection, scope: &str, id: Option<&str>) -> Result<Vec<String>> {
    let mut current = id.map(str::to_owned);
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    while let Some(id) = current {
        if !seen.insert(id.clone()) {
            return Err(RuntimeError::Conflict("container ancestor cycle".into()));
        }
        let c = container(db, scope, &id)?;
        result.push(id);
        current = c.parent_id;
    }
    result.reverse();
    Ok(result)
}
fn require_conversation(
    db: &Connection,
    principal: Option<&str>,
    reference: &ConversationRef,
) -> Result<()> {
    let available=match reference {
        ConversationRef::Native{id}=>db.query_row("SELECT EXISTS(SELECT 1 FROM threads t LEFT JOIN thread_creations c ON c.thread_id=t.id WHERE t.id=?1 AND (t.principal_id IS NULL OR t.principal_id IS ?2) AND t.deleted_at_ms IS NULL AND (c.domain IS NULL OR c.domain NOT IN('summary','memory')) AND NOT EXISTS(SELECT 1 FROM context_jobs j JOIN runs r ON r.id=j.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=t.id) AND NOT EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=t.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1') AND NOT EXISTS(SELECT 1 FROM child_tasks ch JOIN operations o ON o.id=ch.id WHERE ch.child_thread_id=t.id AND json_extract(o.body,'$.executor')='code_retrieval'))",params![id,principal],|r|r.get::<_,bool>(0))?,
        ConversationRef::External{id}=>db.query_row("SELECT EXISTS(SELECT 1 FROM external_conversations WHERE id=?1 AND json_extract(body,'$.principalId') IS ?2 AND coalesce(json_extract(body,'$.deleted'),0)=0)",params![id,principal],|r|r.get(0))?,
    };
    if !available {
        return Err(RuntimeError::NotFound(
            "conversation unavailable in current organization".into(),
        ));
    }
    Ok(())
}
fn original_parent(
    db: &Connection,
    reference: &ConversationRef,
) -> Result<Option<ConversationRef>> {
    let parent:Option<String>=match reference {
        ConversationRef::Native{id}=>db.query_row("SELECT json_extract(body,'$.parent_thread_id') FROM child_tasks WHERE child_thread_id=?1 ORDER BY rowid LIMIT 1",[id],|r|r.get(0)).optional()?.flatten(),
        ConversationRef::External{id}=>db.query_row("SELECT json_extract(body,'$.parent_thread_id') FROM external_children WHERE json_extract(body,'$.conversation_id')=?1 AND json_extract(body,'$.dispatch_operation_id') IS NULL AND json_extract(body,'$.message_kind') IS NULL ORDER BY rowid LIMIT 1",[id],|r|r.get(0)).optional()?.flatten(),
    };
    Ok(parent.map(|id| ConversationRef::Native { id }))
}
fn explicit_position(
    db: &Connection,
    scope: &str,
    r: &ConversationRef,
) -> Result<Option<Position>> {
    Ok(db.query_row("SELECT container_id,sort_order,revision FROM organization_positions WHERE scope=?1 AND kind=?2 AND id=?3 AND is_explicit=1",params![scope,r.kind(),r.id()],|row|Ok(Position{conversation:r.clone(),container_id:row.get(0)?,order:read_number(row,1)?,revision:read_number(row,2)?,explicit:true,inherited_from:None})).optional()?)
}
fn position(db: &Connection, scope: &str, r: &ConversationRef) -> Result<Position> {
    if let Some(p) = explicit_position(db, scope, r)? {
        return Ok(p);
    }
    let own_revision = db
        .query_row(
            "SELECT revision FROM organization_positions WHERE scope=?1 AND kind=?2 AND id=?3",
            params![scope, r.kind(), r.id()],
            |r| read_number(r, 0),
        )
        .optional()?
        .unwrap_or(0);
    let immediate_parent = original_parent(db, r)?;
    let mut next = immediate_parent.clone();
    let mut seen = BTreeSet::from([r.clone()]);
    while let Some(parent) = next {
        if !seen.insert(parent.clone()) {
            return Err(RuntimeError::Invalid("conversation parent cycle".into()));
        }
        let principal: Option<String> = serde_json::from_str(scope)?;
        // Removed ancestors retain their navigation and provenance; cross-principal ancestors never do.
        let owner = match &parent {
            ConversationRef::Native { id } => principals::thread(db, id)?,
            ConversationRef::External { .. } => None,
        };
        if owner.is_some() && owner != principal {
            break;
        }
        if let Some(p) = explicit_position(db, scope, &parent)? {
            return Ok(Position {
                conversation: r.clone(),
                container_id: p.container_id,
                order: p.order,
                revision: own_revision,
                explicit: false,
                inherited_from: immediate_parent.clone(),
            });
        }
        next = original_parent(db, &parent)?;
    }
    Ok(Position {
        conversation: r.clone(),
        container_id: None,
        order: 0,
        revision: own_revision,
        explicit: false,
        inherited_from: immediate_parent,
    })
}
fn save_position(db: &Connection, scope: &str, p: &Position) -> Result<()> {
    let parent = if p.explicit {
        p.container_id.as_deref()
    } else {
        None
    };
    db.execute("INSERT INTO organization_positions(scope,kind,id,container_id,sort_order,revision,is_explicit) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(scope,kind,id) DO UPDATE SET container_id=excluded.container_id,sort_order=excluded.sort_order,revision=excluded.revision,is_explicit=excluded.is_explicit",params![scope,p.conversation.kind(),p.conversation.id(),parent,sql_number(p.order)?,sql_number(p.revision)?,p.explicit])?;
    Ok(())
}
fn parent_revision(db: &Connection, scope: &str, parent: Option<&str>) -> Result<u64> {
    match parent {
        Some(id) => Ok(container(db, scope, id)?.children_revision),
        None => Ok(db
            .query_row(
                "SELECT root_revision FROM organization_spaces WHERE scope=?1",
                [scope],
                |r| read_number(r, 0),
            )
            .optional()?
            .unwrap_or(0)),
    }
}
fn bump_parent(db: &Connection, scope: &str, parent: Option<&str>) -> Result<()> {
    if let Some(id) = parent {
        let mut c = container(db, scope, id)?;
        c.children_revision += 1;
        save_container(db, scope, &c)?;
    } else {
        db.execute(
            "UPDATE organization_spaces SET root_revision=root_revision+1 WHERE scope=?1",
            [scope],
        )?;
    }
    Ok(())
}
fn check_parents(
    db: &Connection,
    scope: &str,
    parents: &[ParentVersion],
    required: &BTreeSet<Option<String>>,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    for p in parents {
        if !seen.insert(p.container_id.clone()) {
            return Err(RuntimeError::Invalid("duplicate parent version".into()));
        }
        if parent_revision(db, scope, p.container_id.as_deref())? != p.children_revision {
            return Err(RuntimeError::Conflict(format!(
                "organization parent changed: {}",
                p.container_id.as_deref().unwrap_or("root")
            )));
        }
    }
    if !required.is_subset(&seen) {
        return Err(RuntimeError::Invalid(
            "missing affected parent revision".into(),
        ));
    }
    Ok(())
}
fn object_reference(object: &OrganizationObject) -> Option<ConversationRef> {
    match object {
        OrganizationObject::Container { .. } => None,
        OrganizationObject::Native { id } => Some(ConversationRef::Native { id: id.clone() }),
        OrganizationObject::External { id } => Some(ConversationRef::External { id: id.clone() }),
    }
}
fn siblings(db: &Connection, scope: &str, parent: Option<&str>) -> Result<Vec<OrganizationObject>> {
    let mut list: Vec<(u64, String, OrganizationObject)> = Vec::new();
    for c in containers(db, scope)? {
        if c.parent_id.as_deref() == parent {
            list.push((
                c.order,
                format!("c:{}", c.id),
                OrganizationObject::Container { id: c.id },
            ));
        }
    }
    let rows=db.prepare("SELECT kind,id,sort_order FROM organization_positions WHERE scope=?1 AND container_id IS ?2 AND is_explicit=1")?.query_map(params![scope,parent],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,read_number(r,2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    for (kind, id, order) in rows {
        let o = if kind == "native" {
            OrganizationObject::Native { id: id.clone() }
        } else {
            OrganizationObject::External { id: id.clone() }
        };
        list.push((order, format!("{kind}:{id}"), o));
    }
    list.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(list.into_iter().map(|(_, _, o)| o).collect())
}
fn reorder(db: &Connection, scope: &str, items: &[OrganizationObject]) -> Result<()> {
    for (order, item) in items.iter().enumerate() {
        match item {
            OrganizationObject::Container { id } => {
                let mut c = container(db, scope, id)?;
                c.order = order as u64;
                save_container(db, scope, &c)?;
            }
            _ => {
                let r = object_reference(item).unwrap();
                db.execute("UPDATE organization_positions SET sort_order=?4 WHERE scope=?1 AND kind=?2 AND id=?3",params![scope,r.kind(),r.id(),sql_number(order as u64)?])?;
            }
        }
    }
    Ok(())
}
fn insert_at(
    list: &mut Vec<OrganizationObject>,
    items: Vec<OrganizationObject>,
    before: Option<&OrganizationObject>,
) -> Result<()> {
    let index = match before {
        Some(anchor) => list
            .iter()
            .position(|o| o == anchor)
            .ok_or_else(|| RuntimeError::Conflict("organization sibling anchor changed".into()))?,
        None => list.len(),
    };
    list.splice(index..index, items);
    Ok(())
}
fn finish(
    tx: &Transaction<'_>,
    scope: &str,
    key: &str,
    intent: &str,
    removed: Vec<String>,
    positions: Vec<Position>,
) -> Result<OrganizationReceipt> {
    let revision = tx.query_row(
        "UPDATE organization_spaces SET revision=revision+1 WHERE scope=?1 RETURNING revision",
        [scope],
        |r| read_number(r, 0),
    )?;
    let cursor = event(
        tx,
        &format!("organization:{scope}"),
        revision,
        "organization.changed",
        json!({"scope":scope,"key":key,"removed":removed}),
    )?;
    let receipt = OrganizationReceipt {
        key: key.into(),
        revision,
        cursor,
        containers: containers(tx, scope)?,
        positions,
        removed,
        creation_defaults: None,
    };
    tx.execute(
        "INSERT INTO organization_commands(scope,key,intent,receipt) VALUES(?1,?2,?3,?4)",
        params![scope, key, intent, encode(&receipt)?],
    )?;
    Ok(receipt)
}
fn replay(
    db: &Connection,
    scope: &str,
    key: &str,
    intent: &str,
) -> Result<Option<OrganizationReceipt>> {
    if key.trim().is_empty() {
        return Err(RuntimeError::Invalid(
            "organization command key is empty".into(),
        ));
    }
    let old: Option<(String, String)> = db
        .query_row(
            "SELECT intent,receipt FROM organization_commands WHERE scope=?1 AND key=?2",
            params![scope, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    old.map(|(old, receipt)| {
        if old != intent {
            return Err(RuntimeError::Conflict(
                "organization key reused with different intent".into(),
            ));
        }
        Ok(serde_json::from_str(&receipt)?)
    })
    .transpose()
}

impl Catalog {
    pub fn organization_command(
        &mut self,
        principal: Option<&str>,
        command: OrganizationCommand,
    ) -> Result<OrganizationReceipt> {
        let scope = scope(principal)?;
        let intent = encode(&command.operation)?;
        let tx = self.db.transaction()?;
        if let Some(old) = replay(&tx, &scope, &command.key, &intent)? {
            return Ok(old);
        }
        ensure_space(&tx, &scope)?;
        let mut moved = Vec::new();
        let mut removed = Vec::new();
        match command.operation {
            OrganizationOperation::Create {
                id,
                kind,
                parent_id,
                name,
                icon,
                color,
                project_id,
                parents,
                before,
            } => {
                if id.trim().is_empty() {
                    return Err(RuntimeError::Invalid("container identity is empty".into()));
                }
                let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM organization_containers WHERE scope=?1 AND id=?2 UNION ALL SELECT 1 FROM organization_retired_containers WHERE scope=?1 AND id=?2)",params![scope,id],|r|r.get(0))?;
                if used {
                    return Err(RuntimeError::Conflict(
                        "container identity already exists or is retired".into(),
                    ));
                }
                check_parents(&tx, &scope, &parents, &BTreeSet::from([parent_id.clone()]))?;
                path(&tx, &scope, parent_id.as_deref())?;
                if let Some(project) = &project_id {
                    let existing:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM organization_containers WHERE scope=?1 AND json_extract(body,'$.projectId')=?2)",params![scope,project],|r|r.get(0))?;
                    if existing {
                        return Err(RuntimeError::Conflict(
                            "project already has a formal organization entry".into(),
                        ));
                    }
                }
                match kind {
                    ContainerKind::Group => {
                        if name.as_deref().is_none_or(|n| n.trim().is_empty())
                            || project_id.is_some()
                        {
                            return Err(RuntimeError::Invalid(
                                "group requires name and cannot own project settings".into(),
                            ));
                        }
                    }
                    ContainerKind::Project => {
                        if project_id.as_deref().is_none_or(|n| n.trim().is_empty())
                            || name.is_some()
                            || icon.is_some()
                            || color.is_some()
                        {
                            return Err(RuntimeError::Invalid("project requires original project identity and uses original settings".into()));
                        }
                    }
                }
                let mut order = siblings(&tx, &scope, parent_id.as_deref())?;
                insert_at(
                    &mut order,
                    vec![OrganizationObject::Container { id: id.clone() }],
                    before.as_ref(),
                )?;
                save_container(
                    &tx,
                    &scope,
                    &Container {
                        id,
                        kind,
                        parent_id: parent_id.clone(),
                        order: 0,
                        revision: 1,
                        children_revision: 0,
                        name,
                        icon,
                        color,
                        project_id,
                    },
                )?;
                reorder(&tx, &scope, &order)?;
                bump_parent(&tx, &scope, parent_id.as_deref())?;
            }
            OrganizationOperation::Update {
                id,
                expected_revision,
                name,
                icon,
                color,
            } => {
                let mut c = container(&tx, &scope, &id)?;
                if c.revision != expected_revision {
                    return Err(RuntimeError::Conflict("container changed".into()));
                }
                if c.kind != ContainerKind::Group {
                    return Err(RuntimeError::Invalid(
                        "project metadata belongs to project settings".into(),
                    ));
                }
                if let Some(name) = name {
                    if name.trim().is_empty() {
                        return Err(RuntimeError::Invalid("group name is empty".into()));
                    }
                    c.name = Some(name);
                }
                if let Some(icon) = icon {
                    c.icon = icon.filter(|value| !value.is_empty());
                }
                if let Some(color) = color {
                    c.color = color.filter(|value| !value.is_empty());
                }
                c.revision += 1;
                save_container(&tx, &scope, &c)?;
            }
            OrganizationOperation::Move {
                items,
                parent_id,
                before,
                parents,
            } => {
                if items.is_empty() {
                    return Err(RuntimeError::Invalid("move selection is empty".into()));
                }
                let destination_path = path(&tx, &scope, parent_id.as_deref())?;
                let mut affected = BTreeSet::from([parent_id.clone()]);
                let mut selected = BTreeSet::new();
                for item in &items {
                    if !selected.insert(encode(&item.object)?) {
                        return Err(RuntimeError::Invalid("duplicate move selection".into()));
                    }
                    let (revision, parent) = match &item.object {
                        OrganizationObject::Container { id } => {
                            let c = container(&tx, &scope, id)?;
                            if destination_path.contains(id) {
                                return Err(RuntimeError::Conflict(
                                    "container ancestor cycle".into(),
                                ));
                            }
                            (c.revision, c.parent_id)
                        }
                        _ => {
                            let reference = object_reference(&item.object).unwrap();
                            require_conversation(&tx, principal, &reference)?;
                            let p = position(&tx, &scope, &reference)?;
                            (p.revision, p.container_id)
                        }
                    };
                    if revision != item.expected_revision || parent != item.expected_parent_id {
                        return Err(RuntimeError::Conflict(format!(
                            "organization object changed: {}",
                            encode(&item.object)?
                        )));
                    }
                    affected.insert(parent);
                }
                check_parents(&tx, &scope, &parents, &affected)?;
                let mut order = siblings(&tx, &scope, parent_id.as_deref())?;
                order.retain(|o| !items.iter().any(|i| &i.object == o));
                insert_at(
                    &mut order,
                    items.iter().map(|i| i.object.clone()).collect(),
                    before.as_ref(),
                )?;
                for item in &items {
                    match &item.object {
                        OrganizationObject::Container { id } => {
                            let mut c = container(&tx, &scope, id)?;
                            c.parent_id = parent_id.clone();
                            c.revision += 1;
                            save_container(&tx, &scope, &c)?;
                        }
                        _ => {
                            let r = object_reference(&item.object).unwrap();
                            let p = Position {
                                conversation: r.clone(),
                                container_id: parent_id.clone(),
                                order: 0,
                                revision: item.expected_revision + 1,
                                explicit: true,
                                inherited_from: None,
                            };
                            save_position(&tx, &scope, &p)?;
                            moved.push(r);
                        }
                    }
                }
                reorder(&tx, &scope, &order)?;
                for parent in affected {
                    bump_parent(&tx, &scope, parent.as_deref())?;
                }
            }
            OrganizationOperation::Restore { items, parents } => {
                if items.is_empty() {
                    return Err(RuntimeError::Invalid("restore selection is empty".into()));
                }
                let mut selected = BTreeSet::new();
                let mut affected = BTreeSet::new();
                for item in &items {
                    if !selected.insert(encode(&item.object)?) {
                        return Err(RuntimeError::Invalid("duplicate restore selection".into()));
                    }
                    path(&tx, &scope, item.parent_id.as_deref())?;
                    let (revision, parent) = match &item.object {
                        OrganizationObject::Container { id } => {
                            if item.inherit {
                                return Err(RuntimeError::Invalid(
                                    "containers cannot inherit execution placement".into(),
                                ));
                            }
                            let c = container(&tx, &scope, id)?;
                            (c.revision, c.parent_id)
                        }
                        _ => {
                            let reference = object_reference(&item.object).unwrap();
                            require_conversation(&tx, principal, &reference)?;
                            let p = position(&tx, &scope, &reference)?;
                            if item.inherit {
                                if item.before.is_some() {
                                    return Err(RuntimeError::Invalid(
                                        "inherited tasks have no independent sibling anchor".into(),
                                    ));
                                }
                                let original=original_parent(&tx,&reference)?.ok_or_else(||RuntimeError::Invalid("only original subtasks can restore inherited placement".into()))?;
                                let owner = match &original {
                                    ConversationRef::Native { id } => principals::thread(&tx, id)?,
                                    ConversationRef::External { .. } => None,
                                };
                                if owner.is_some() && owner.as_deref() != principal
                                    || direct_bot(&tx, &original)?.is_some()
                                {
                                    return Err(RuntimeError::Invalid(
                                        "main tasks retain their independently admitted placement"
                                            .into(),
                                    ));
                                }
                            }
                            (p.revision, p.container_id)
                        }
                    };
                    if revision != item.expected_revision || parent != item.expected_parent_id {
                        return Err(RuntimeError::Conflict(
                            "restore object changed after the original move".into(),
                        ));
                    }
                    affected.insert(parent);
                    affected.insert(item.parent_id.clone());
                }
                check_parents(&tx, &scope, &parents, &affected)?;
                for item in &items {
                    if let Some(anchor) = &item.before {
                        if selected.contains(&encode(anchor)?) {
                            return Err(RuntimeError::Invalid(
                                "restore anchor must be an unselected sibling".into(),
                            ));
                        }
                    }
                }
                for item in &items {
                    match &item.object {
                        OrganizationObject::Container { id } => {
                            let mut c = container(&tx, &scope, id)?;
                            c.parent_id = item.parent_id.clone();
                            c.revision += 1;
                            save_container(&tx, &scope, &c)?;
                        }
                        _ => {
                            let reference = object_reference(&item.object).unwrap();
                            save_position(
                                &tx,
                                &scope,
                                &Position {
                                    conversation: reference.clone(),
                                    container_id: item.parent_id.clone(),
                                    order: 0,
                                    revision: item.expected_revision + 1,
                                    explicit: !item.inherit,
                                    inherited_from: None,
                                },
                            )?;
                            moved.push(reference);
                        }
                    }
                }
                // Validate the candidate graph, including cycles introduced by multiple mutually
                // dependent moves and parents whose own effective placement changed in this batch.
                for item in &items {
                    match &item.object {
                        OrganizationObject::Container { id } => {
                            path(&tx, &scope, Some(id))?;
                        }
                        _ if item.inherit => {
                            let p =
                                position(&tx, &scope, &object_reference(&item.object).unwrap())?;
                            if p.container_id != item.parent_id {
                                return Err(RuntimeError::Conflict(
                                    "original task's effective placement changed".into(),
                                ));
                            }
                        }
                        _ => {}
                    }
                }
                for parent in &affected {
                    let mut order = siblings(&tx, &scope, parent.as_deref())?;
                    order.retain(|object| !items.iter().any(|item| &item.object == object));
                    for item in items
                        .iter()
                        .filter(|item| !item.inherit && &item.parent_id == parent)
                    {
                        insert_at(&mut order, vec![item.object.clone()], item.before.as_ref())?;
                    }
                    reorder(&tx, &scope, &order)?;
                }
                for parent in affected {
                    bump_parent(&tx, &scope, parent.as_deref())?;
                }
            }
            OrganizationOperation::Dissolve {
                id,
                expected_revision,
                parents,
            } => {
                let c = container(&tx, &scope, &id)?;
                if c.revision != expected_revision {
                    return Err(RuntimeError::Conflict("container changed".into()));
                }
                check_parents(
                    &tx,
                    &scope,
                    &parents,
                    &BTreeSet::from([Some(id.clone()), c.parent_id.clone()]),
                )?;
                let children = siblings(&tx, &scope, Some(&id))?;
                let mut order = siblings(&tx, &scope, c.parent_id.as_deref())?;
                let index = order
                    .iter()
                    .position(|o| *o == OrganizationObject::Container { id: id.clone() })
                    .ok_or_else(|| RuntimeError::Conflict("container parent changed".into()))?;
                order.splice(index..index + 1, children.iter().cloned());
                for child in children {
                    match child {
                        OrganizationObject::Container { id } => {
                            let mut child = container(&tx, &scope, &id)?;
                            child.parent_id = c.parent_id.clone();
                            child.revision += 1;
                            save_container(&tx, &scope, &child)?;
                        }
                        _ => {
                            let r = object_reference(&child).unwrap();
                            let mut p = explicit_position(&tx, &scope, &r)?.ok_or_else(|| {
                                RuntimeError::Conflict("conversation position changed".into())
                            })?;
                            p.container_id = c.parent_id.clone();
                            p.revision += 1;
                            save_position(&tx, &scope, &p)?;
                            moved.push(r);
                        }
                    }
                }
                tx.execute(
                    "INSERT INTO organization_retired_containers(scope,id) VALUES(?1,?2)",
                    params![scope, id],
                )?;
                tx.execute(
                    "DELETE FROM organization_containers WHERE scope=?1 AND id=?2",
                    params![scope, id],
                )?;
                reorder(&tx, &scope, &order)?;
                bump_parent(&tx, &scope, c.parent_id.as_deref())?;
                removed.push(id);
            }
        }
        let positions = moved
            .iter()
            .map(|r| position(&tx, &scope, r))
            .collect::<Result<Vec<_>>>()?;
        let receipt = finish(&tx, &scope, &command.key, &intent, removed, positions)?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn initialize_organization(
        &mut self,
        principal: Option<&str>,
        initial: OrganizationInitialization,
    ) -> Result<OrganizationReceipt> {
        let scope = scope(principal)?;
        let intent = encode(&initial)?;
        let tx = self.db.transaction()?;
        ensure_space(&tx, &scope)?;
        let old: Option<String> = tx.query_row(
            "SELECT initialization FROM organization_spaces WHERE scope=?1",
            [&scope],
            |r| r.get(0),
        )?;
        if let Some(key) = old {
            let receipt: String = tx.query_row(
                "SELECT receipt FROM organization_commands WHERE scope=?1 AND key=?2",
                params![scope, key],
                |r| r.get(0),
            )?;
            return Ok(serde_json::from_str(&receipt)?);
        }
        if let Some(old) = replay(&tx, &scope, &initial.key, &intent)? {
            return Ok(old);
        }
        let mut projects = BTreeMap::new();
        let mut order = siblings(&tx, &scope, None)?;
        for p in &initial.projects {
            if p.id.trim().is_empty() || projects.contains_key(&p.id) {
                return Err(RuntimeError::Invalid(
                    "initial project identity empty or duplicated".into(),
                ));
            }
            let existing = containers(&tx, &scope)?
                .into_iter()
                .find(|c| c.project_id.as_ref() == Some(&p.id));
            let container_id = if let Some(c) = existing {
                c.id
            } else {
                let id = id();
                save_container(
                    &tx,
                    &scope,
                    &Container {
                        id: id.clone(),
                        kind: ContainerKind::Project,
                        parent_id: None,
                        order: order.len() as u64,
                        revision: 1,
                        children_revision: 0,
                        name: None,
                        icon: None,
                        color: None,
                        project_id: Some(p.id.clone()),
                    },
                )?;
                order.push(OrganizationObject::Container { id: id.clone() });
                id
            };
            projects.insert(p.id.clone(), container_id);
        }
        reorder(&tx, &scope, &order)?;
        let mut seen = BTreeSet::new();
        let mut positions = Vec::new();
        for entry in &initial.positions {
            if !seen.insert(entry.conversation.clone()) {
                return Err(RuntimeError::Invalid(
                    "duplicate initial conversation".into(),
                ));
            }
            require_conversation(&tx, principal, &entry.conversation)?;
            if explicit_position(&tx, &scope, &entry.conversation)?.is_some() {
                continue;
            }
            // Ordinary nested work inherits its real parent, not a guessed project relationship.
            if let Some(parent) = original_parent(&tx, &entry.conversation)? {
                if direct_bot(&tx, &parent)?.is_none() {
                    continue;
                }
            }
            let target = entry
                .project_id
                .as_ref()
                .map(|p| {
                    projects.get(p).cloned().ok_or_else(|| {
                        RuntimeError::Invalid(
                            "initial position references an unverified project".into(),
                        )
                    })
                })
                .transpose()?;
            let p = Position {
                conversation: entry.conversation.clone(),
                container_id: target.clone(),
                order: siblings(&tx, &scope, target.as_deref())?.len() as u64,
                revision: 1,
                explicit: true,
                inherited_from: None,
            };
            save_position(&tx, &scope, &p)?;
            bump_parent(&tx, &scope, target.as_deref())?;
            positions.push(p);
        }
        bump_parent(&tx, &scope, None)?;
        tx.execute(
            "UPDATE organization_spaces SET initialization=?2 WHERE scope=?1",
            params![scope, initial.key],
        )?;
        let receipt = finish(&tx, &scope, &initial.key, &intent, Vec::new(), positions)?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn organization_conversation(
        &self,
        principal: Option<&str>,
        reference: &ConversationRef,
    ) -> Result<ConversationEntry> {
        conversation(&self.db, principal, reference)
    }
    pub fn organization_observation(
        &self,
        principal: Option<&str>,
        reference: &str,
        run_id: &str,
    ) -> Result<OrganizationSnapshot> {
        let saved =
            self.resolve_model_reference(model_references::ReferenceKind::Read, reference)?;
        if saved.owner != "organization_observation"
            || saved.target["principal"] != json!(principal)
            || self.run(run_id)?.principal_id.as_deref() != principal
        {
            return Err(RuntimeError::Conflict(
                "Organization observation belongs to another owner".into(),
            ));
        }
        let number = reference
            .strip_prefix("read:")
            .and_then(|n| n.parse::<i64>().ok())
            .ok_or_else(|| RuntimeError::Invalid("Invalid observation reference".into()))?;
        let held:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM model_reference_holders WHERE reference_id=?1 AND holder=?2)",params![number,run_id],|r|r.get(0))?;
        if !held {
            return Err(RuntimeError::Conflict(
                "Organization observation belongs to another tool run; reread its directory".into(),
            ));
        }
        Ok(serde_json::from_value(saved.target["snapshot"].clone())?)
    }
    pub fn organization_initialized(&self,principal:Option<&str>)->Result<bool> {
        let scope=scope(principal)?;
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM organization_spaces WHERE scope=?1 AND initialization IS NOT NULL)",[scope],|r|r.get(0))?)
    }
    pub fn organization_project_ids(&self, principal: Option<&str>) -> Result<Vec<String>> {
        let scope = scope(principal)?;
        Ok(containers(&self.db, &scope)?
            .into_iter()
            .filter_map(|c| c.project_id)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }
    pub fn organization_snapshot(
        &self,
        principal: Option<&str>,
        query: OrganizationQuery,
    ) -> Result<OrganizationSnapshot> {
        let read = self.db.unchecked_transaction()?;
        snapshot(&read, principal, query)
    }
}
fn direct_bot(db: &Connection, r: &ConversationRef) -> Result<Option<String>> {
    match r {
        ConversationRef::Native { id } => Ok(db
            .query_row(
                "SELECT bot_id FROM bot_thread_bindings WHERE thread_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?),
        ConversationRef::External { .. } => Ok(None),
    }
}
fn origin(db: &Connection, principal: Option<&str>, r: &ConversationRef) -> Result<Origin> {
    let direct = direct_bot(db, r)?;
    let first = original_parent(db, r)?;
    let mut next = first.clone();
    let mut seen = BTreeSet::new();
    let mut bot = None;
    while let Some(parent) = next {
        if !seen.insert(parent.clone()) {
            return Err(RuntimeError::Invalid("origin ancestry cycle".into()));
        }
        if let ConversationRef::Native { id } = &parent {
            let owner = principals::thread(db, id)?;
            if owner.is_some() && owner.as_deref() != principal {
                break;
            }
        }
        if let Some(id) = direct_bot(db, &parent)? {
            bot = Some(id);
            break;
        }
        next = original_parent(db, &parent)?;
    }
    Ok(Origin {
        bot_id: bot,
        conversation: first,
        direct_bot_id: direct,
    })
}
pub(super) fn conversation(
    db: &Connection,
    principal: Option<&str>,
    r: &ConversationRef,
) -> Result<ConversationEntry> {
    require_conversation(db, principal, r)?;
    let scope = scope(principal)?;
    let p = position(db, &scope, r)?;
    let (title, archived, pinned, revision) = match r {
        ConversationRef::Native { id } => db.query_row(
            "SELECT title,archived,pinned,revision FROM threads WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, read_number(row, 3)?)),
        )?,
        ConversationRef::External { id } => {
            let v: Value = record(db, "external_conversations", id)?;
            (
                v["title"].as_str().unwrap_or("").to_owned(),
                v["archived"] == true,
                v["pinned"] == true,
                v["revision"].as_u64().unwrap_or(1),
            )
        }
    };
    Ok(ConversationEntry {
        conversation: r.clone(),
        title,
        archived,
        pinned,
        revision,
        updated_at_ms: None,
        has_children: None,
        path: path(db, &scope, p.container_id.as_deref())?,
        position: p,
        origin: origin(db, principal, r)?,
    })
}
#[derive(Serialize, Deserialize)]
struct PageCursor {
    scope: String,
    generation: String,
    query: OrganizationQuery,
    offset: u64,
}
/// Ephemeral metadata projection for one Catalog read. No content bodies, secondary
/// writer or persistent cache: every map is built from this read's SQLite snapshot.
struct DirectoryMetadata {
    owners: BTreeSet<String>,
    parents: BTreeMap<ConversationRef, ConversationRef>,
    bots: BTreeMap<String, String>,
    positions: BTreeMap<ConversationRef, Position>,
    effective: BTreeMap<ConversationRef, (Option<String>, u64)>,
    origin_bots: BTreeMap<ConversationRef, Option<String>>,
    paths: BTreeMap<String, Vec<String>>,
}
impl DirectoryMetadata {
    fn load(
        db: &Connection,
        principal: Option<&str>,
        scope: &str,
        containers: &[Container],
    ) -> Result<Self> {
        let owners = db
            .prepare("SELECT id FROM threads WHERE principal_id IS NULL OR principal_id IS ?1")?
            .query_map([principal], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        let native = db.prepare("SELECT c.child_thread_id,json_extract(c.body,'$.parent_thread_id') FROM child_tasks c JOIN threads t ON t.id=c.child_thread_id WHERE (t.principal_id IS NULL OR t.principal_id IS ?1) ORDER BY c.rowid")?.query_map([principal], |r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let external = db.prepare("SELECT e.id,json_extract(c.body,'$.parent_thread_id') FROM external_children c JOIN external_conversations e ON e.id=json_extract(c.body,'$.conversation_id') WHERE json_extract(e.body,'$.principalId') IS ?1 AND json_extract(c.body,'$.dispatch_operation_id') IS NULL AND json_extract(c.body,'$.message_kind') IS NULL ORDER BY c.rowid")?.query_map([principal], |r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut parents = BTreeMap::new();
        // Preserve the original first relation, including a null first parent.
        let mut seen = BTreeSet::new();
        for (r, parent) in native
            .into_iter()
            .map(|(id, p)| (ConversationRef::Native { id }, p))
            .chain(
                external
                    .into_iter()
                    .map(|(id, p)| (ConversationRef::External { id }, p)),
            )
        {
            if seen.insert(r.clone()) {
                if let Some(id) = parent {
                    parents.insert(r, ConversationRef::Native { id });
                }
            }
        }
        let bots=db.prepare("SELECT b.thread_id,b.bot_id FROM bot_thread_bindings b JOIN threads t ON t.id=b.thread_id WHERE (t.principal_id IS NULL OR t.principal_id IS ?1)")?.query_map([principal],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<std::result::Result<BTreeMap<_,_>,_>>()?;
        let rows=db.prepare("SELECT kind,id,container_id,sort_order,revision,is_explicit FROM organization_positions WHERE scope=?1")?.query_map([scope],|r|{
            let kind:String=r.get(0)?;let id:String=r.get(1)?;
            let conversation=if kind=="native" {ConversationRef::Native{id}} else {ConversationRef::External{id}};
            Ok((conversation.clone(),Position{conversation,container_id:r.get(2)?,order:read_number(r,3)?,revision:read_number(r,4)?,explicit:r.get(5)?,inherited_from:None}))
        })?.collect::<std::result::Result<BTreeMap<_,_>,_>>()?;
        let by_id: BTreeMap<_, _> = containers.iter().map(|c| (c.id.clone(), c)).collect();
        let mut paths: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for container in containers {
            let mut next = Some(container.id.clone());
            let mut chain = Vec::new();
            let mut seen = BTreeSet::new();
            let mut prefix = Vec::new();
            while let Some(id) = next {
                if let Some(path) = paths.get(&id) {
                    prefix = path.clone();
                    break;
                }
                if !seen.insert(id.clone()) {
                    return Err(RuntimeError::Conflict("container ancestor cycle".into()));
                }
                let c = by_id
                    .get(&id)
                    .ok_or_else(|| RuntimeError::NotFound("organization container".into()))?;
                chain.push(id);
                next = c.parent_id.clone();
            }
            for id in chain.into_iter().rev() {
                prefix.push(id.clone());
                paths.insert(id, prefix.clone());
            }
        }
        Ok(Self {
            owners,
            parents,
            bots,
            positions: rows,
            effective: BTreeMap::new(),
            origin_bots: BTreeMap::new(),
            paths,
        })
    }
    fn owns(&self, r: &ConversationRef) -> bool {
        match r {
            ConversationRef::Native { id } => self.owners.contains(id),
            ConversationRef::External { .. } => false,
        }
    }
    fn effective_position(&mut self, r: &ConversationRef) -> Result<(Option<String>, u64)> {
        let mut next = r.clone();
        let mut chain = Vec::new();
        let mut seen = BTreeSet::new();
        let base = loop {
            if let Some(p) = self.effective.get(&next) {
                break p.clone();
            }
            if !seen.insert(next.clone()) {
                return Err(RuntimeError::Invalid("conversation parent cycle".into()));
            }
            chain.push(next.clone());
            if let Some(p) = self.positions.get(&next).filter(|p| p.explicit) {
                break (p.container_id.clone(), p.order);
            }
            match self.parents.get(&next) {
                Some(parent) if self.owns(parent) => next = parent.clone(),
                _ => break (None, 0),
            }
        };
        for node in chain {
            self.effective.insert(node, base.clone());
        }
        Ok(base)
    }
    fn ancestor_bot(&mut self, r: &ConversationRef) -> Result<Option<String>> {
        let mut next = self.parents.get(r).cloned();
        let mut chain = Vec::new();
        let mut seen = BTreeSet::new();
        let bot = loop {
            let Some(node) = next else { break None };
            if !self.owns(&node) {
                break None;
            }
            if !seen.insert(node.clone()) {
                return Err(RuntimeError::Invalid("origin ancestry cycle".into()));
            }
            if let Some(bot) = self.origin_bots.get(&node) {
                break bot.clone();
            }
            chain.push(node.clone());
            if let ConversationRef::Native { id } = &node {
                if let Some(bot) = self.bots.get(id) {
                    break Some(bot.clone());
                }
            }
            next = self.parents.get(&node).cloned();
        };
        for node in chain {
            self.origin_bots.insert(node, bot.clone());
        }
        Ok(bot)
    }
    fn entry(
        &mut self,
        r: ConversationRef,
        title: String,
        archived: bool,
        pinned: bool,
        revision: u64,
    ) -> Result<ConversationEntry> {
        let (container_id, order) = self.effective_position(&r)?;
        let own = self.positions.get(&r);
        let explicit = own.is_some_and(|p| p.explicit);
        let position = Position {
            conversation: r.clone(),
            container_id: container_id.clone(),
            order,
            revision: own.map(|p| p.revision).unwrap_or(0),
            explicit,
            inherited_from: if explicit {
                None
            } else {
                self.parents.get(&r).cloned()
            },
        };
        let path = match container_id {
            Some(id) => self
                .paths
                .get(&id)
                .cloned()
                .ok_or_else(|| RuntimeError::NotFound("organization container".into()))?,
            None => Vec::new(),
        };
        let origin = Origin {
            bot_id: self.ancestor_bot(&r)?,
            conversation: self.parents.get(&r).cloned(),
            direct_bot_id: match &r {
                ConversationRef::Native { id } => self.bots.get(id).cloned(),
                _ => None,
            },
        };
        Ok(ConversationEntry {
            conversation: r,
            title,
            archived,
            pinned,
            revision,
            updated_at_ms: None,
            has_children: None,
            position,
            path,
            origin,
        })
    }
}
/// Page task siblings, independently of their classification positions. Descendant
/// activity and search hits belong to their visible ancestor, not another root row.
fn conversation_tree_scope(
    entries: Vec<ConversationEntry>,
    tree: &ConversationTreeQuery,
    search: Option<&str>,
    recent: bool,
) -> Result<Vec<ConversationEntry>> {
    let indices = entries.iter().enumerate().map(|(i, entry)| (entry.conversation.clone(), i)).collect::<BTreeMap<_, _>>();
    let parents = entries.iter().map(|entry| entry.origin.conversation.as_ref().and_then(|parent| indices.get(parent)).copied()).collect::<Vec<_>>();
    let requested_parent = tree.parent.as_ref().and_then(|parent| indices.get(parent)).copied();
    if tree.parent.is_some() && requested_parent.is_none() { return Ok(Vec::new()); }
    let mut remaining = vec![0usize; entries.len()];
    for parent in parents.iter().flatten() { remaining[*parent] += 1; }
    let mut pending = remaining.iter().enumerate().filter_map(|(i, count)| (*count == 0).then_some(i)).collect::<Vec<_>>();
    let mut latest = entries.iter().map(|entry| entry.updated_at_ms).collect::<Vec<_>>();
    let mut matches = entries.iter().map(|entry| search.is_none_or(|query| entry.title.to_lowercase().contains(query))).collect::<Vec<_>>();
    let mut visited = 0;
    while let Some(index) = pending.pop() {
        visited += 1;
        if let Some(parent) = parents[index] {
            latest[parent] = latest[parent].max(latest[index]);
            matches[parent] |= matches[index];
            remaining[parent] -= 1;
            if remaining[parent] == 0 { pending.push(parent); }
        }
    }
    if visited != entries.len() { return Err(RuntimeError::Invalid("origin ancestry cycle".into())); }
    let mut has_children = vec![false; entries.len()];
    for (index, parent) in parents.iter().enumerate() {
        if matches[index] { if let Some(parent) = parent { has_children[*parent] = true; } }
    }
    Ok(entries.into_iter().enumerate().filter_map(|(index, mut entry)| {
        if parents[index] != requested_parent || !matches[index] { return None; }
        entry.has_children = Some(has_children[index]);
        if recent { entry.updated_at_ms = latest[index]; }
        Some(entry)
    }).collect())
}
fn snapshot(
    db: &Connection,
    principal: Option<&str>,
    mut query: OrganizationQuery,
) -> Result<OrganizationSnapshot> {
    let scope = scope(principal)?;
    let page = query.cursor.take();
    if query.limit == Some(0) {
        return Err(RuntimeError::Invalid("page limit must be positive".into()));
    }
    if !matches!(
        query.kind.as_deref(),
        None | Some("containers" | "conversations")
    )
        || !matches!(query.sort.as_deref(), None | Some("manual" | "recent"))
    {
        return Err(RuntimeError::Invalid("invalid organization view".into()));
    }
    if !matches!(
        query.archived.as_deref(),
        None | Some("exclude" | "include" | "only")
    ) {
        return Err(RuntimeError::Invalid("invalid archive filter".into()));
    }
    if let Some(id) = &query.container_id {
        container(db, &scope, id)?;
    }
    let (revision,root_revision,initialized)=db.query_row("SELECT revision,root_revision,initialization IS NOT NULL FROM organization_spaces WHERE scope=?1",[&scope],|r|Ok((read_number(r,0)?,read_number(r,1)?,r.get(2)?))).optional()?.unwrap_or((0,0,false));
    let cursor = db.query_row("SELECT coalesce(max(cursor),0) FROM events", [], |r| {
        read_number(r, 0)
    })?;
    let continuation = page
        .map(|page| {
            serde_json::from_str::<PageCursor>(&page)
                .map_err(|_| RuntimeError::Invalid("invalid organization continuation".into()))
        })
        .transpose()?;
    let mut metadata = db.prepare("SELECT t.id,t.title,t.archived,t.pinned,t.revision,t.updated_at_ms FROM threads t LEFT JOIN thread_creations c ON c.thread_id=t.id WHERE (t.principal_id IS NULL OR t.principal_id IS ?1) AND t.deleted_at_ms IS NULL AND (c.domain IS NULL OR c.domain NOT IN('summary','memory')) AND NOT EXISTS(SELECT 1 FROM context_jobs j JOIN runs r ON r.id=j.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=t.id) AND NOT EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id JOIN branches b ON b.id=r.branch_id WHERE b.thread_id=t.id AND json_extract(o.body,'$.intent.kind')='memory_work_v1') AND NOT EXISTS(SELECT 1 FROM child_tasks ch JOIN operations o ON o.id=ch.id WHERE ch.child_thread_id=t.id AND json_extract(o.body,'$.executor')='code_retrieval') ORDER BY t.id")?.query_map([principal],|r|Ok((ConversationRef::Native{id:r.get(0)?},r.get::<_,String>(1)?,r.get::<_,bool>(2)?,r.get::<_,bool>(3)?,read_number(r,4)?,read_number(r,5)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    metadata.extend(db.prepare("SELECT id,coalesce(json_extract(body,'$.title'),''),coalesce(json_extract(body,'$.archived'),0),coalesce(json_extract(body,'$.pinned'),0),coalesce(json_extract(body,'$.revision'),1),coalesce(json_extract(body,'$.updatedAt'),0) FROM external_conversations WHERE json_extract(body,'$.principalId') IS ?1 AND coalesce(json_extract(body,'$.deleted'),0)=0 ORDER BY id")?.query_map([principal],|r|Ok((ConversationRef::External{id:r.get(0)?},r.get::<_,String>(1)?,r.get::<_,bool>(2)?,r.get::<_,bool>(3)?,read_number(r,4)?,read_number(r,5)?)))?.collect::<std::result::Result<Vec<_>,_>>()?);
    let all_containers = containers(db, &scope)?;
    let mut directory = DirectoryMetadata::load(db, principal, &scope, &all_containers)?;
    // Names are a request-local projection from Settings. Keep only identities
    // which can enter this query, so unrelated project edits neither leak into
    // continuation recipes nor invalidate an independent subtree's pagination.
    if query.query.as_ref().is_none_or(|q| q.trim().is_empty()) {
        query.project_names = None;
    }
    if let Some(names) = &mut query.project_names {
        let relevant = all_containers
            .iter()
            .filter(|c| {
                if let Some(parent) = &query.container_id {
                    c.parent_id.as_ref() == Some(parent)
                        || (query.recursive
                            && c.id != *parent
                            && directory
                                .paths
                                .get(&c.id)
                                .is_some_and(|path| path.contains(parent)))
                } else {
                    !query.root_only || query.recursive || c.parent_id.is_none()
                }
            })
            .filter_map(|c| c.project_id.clone())
            .collect::<BTreeSet<_>>();
        names.retain(|id, _| relevant.contains(id));
    }

    let by_id: BTreeMap<_, _> = all_containers.iter().map(|c| (&c.id, c)).collect();
    let search = query
        .query
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_lowercase());
    let mut entries = Vec::new();
    let mut bot_paths = BTreeSet::new();
    let recent = query.sort.as_deref() == Some("recent");
    let containers_only = query.kind.as_deref() == Some("containers");
    for (r, title, archived, pinned, revision, updated_at_ms) in metadata {
        if containers_only && query.bot_id.is_none() {
            continue;
        }
        let mut entry = directory.entry(r, title, archived, pinned, revision)?;
        if query.exclude_bot_conversations.unwrap_or(false) && entry.origin.direct_bot_id.is_some() {
            continue;
        }
        // Activity changes invalidate activity ordering, never a manual directory cursor.
        if recent {
            entry.updated_at_ms = Some(updated_at_ms);
        }
        if (query.archived.as_deref().unwrap_or("exclude") == "exclude" && entry.archived)
            || (query.archived.as_deref() == Some("only") && !entry.archived)
        {
            continue;
        }
        if let Some(bot) = &query.bot_id {
            if entry.origin.bot_id.as_ref() != Some(bot)
                && entry.origin.direct_bot_id.as_ref() != Some(bot)
            {
                continue;
            }
        }
        bot_paths.extend(entry.path.iter().cloned());
        if containers_only {
            continue;
        }
        if let Some(container) = &query.container_id {
            if entry.position.container_id.as_ref() != Some(container)
                && !(query.recursive && entry.path.contains(container))
            {
                continue;
            }
        } else if query.root_only && !query.recursive && entry.position.container_id.is_some() {
            continue;
        }
        if let Some(search) = search.as_ref().filter(|_| query.conversation_tree.is_none()) {
            if !entry.title.to_lowercase().contains(search)
                && (query.page_nodes
                    || !entry.path.iter().any(|id| {
                        by_id
                            .get(id)
                            .and_then(|c| c.name.as_ref())
                            .is_some_and(|n| n.to_lowercase().contains(search))
                    }))
            {
                continue;
            }
        }
        entries.push(entry);
    }
    if let Some(tree) = &query.conversation_tree {
        entries = conversation_tree_scope(entries, tree, search.as_deref(), recent)?;
    }
    entries.sort_by(|a, b| {
        if recent {
            return b.pinned.cmp(&a.pinned)
                .then_with(|| b.updated_at_ms.cmp(&a.updated_at_ms))
                .then_with(|| a.conversation.cmp(&b.conversation));
        }
        (&a.position.container_id, a.position.order, &a.conversation).cmp(&(
            &b.position.container_id,
            b.position.order,
            &b.conversation,
        ))
    });
    let mut nodes: Vec<(Option<String>, u64, String, OrganizationObject)> = Vec::new();
    if query.page_nodes {
        for c in &all_containers {
            if query.kind.as_deref() == Some("conversations") {
                continue;
            }
            let in_scope = if let Some(parent) = &query.container_id {
                c.parent_id.as_ref() == Some(parent)
                    || (query.recursive
                        && c.id != *parent
                        && directory
                            .paths
                            .get(&c.id)
                            .is_some_and(|p| p.contains(parent)))
            } else {
                !query.root_only || query.recursive || c.parent_id.is_none()
            };
            if !in_scope || (query.bot_id.is_some() && !bot_paths.contains(&c.id)) {
                continue;
            }
            let name = c.name.as_ref().or_else(|| {
                c.project_id
                    .as_ref()
                    .and_then(|id| query.project_names.as_ref().and_then(|names| names.get(id)))
            });
            if search
                .as_ref()
                .is_some_and(|q| !name.is_some_and(|name| name.to_lowercase().contains(q)))
            {
                continue;
            }
            nodes.push((
                c.parent_id.clone(),
                c.order,
                format!("c:{}", c.id),
                OrganizationObject::Container { id: c.id.clone() },
            ));
        }
        for (index, e) in entries.iter().enumerate() {
            let object = match &e.conversation {
                ConversationRef::Native { id } => OrganizationObject::Native { id: id.clone() },
                ConversationRef::External { id } => OrganizationObject::External { id: id.clone() },
            };
            nodes.push((
                e.position.container_id.clone(),
                if recent { index as u64 } else { e.position.order },
                format!("{}:{}", e.conversation.kind(), e.conversation.id()),
                object,
            ));
        }
        if !recent {
            nodes.sort_by(|a, b| (&a.0, a.1, &a.2).cmp(&(&b.0, b.1, &b.2)));
        }
    }
    // Freeze the actual directory projection, not unrelated model/run activity or a different
    // principal's global event cursor. Each continuation rechecks the current visible facts.
    use sha2::Digest;
    let relevant_containers = all_containers
        .iter()
        .filter(|c| {
            if let Some(parent) = query.container_id.as_ref() {
                c.id == *parent
                    || c.parent_id.as_ref() == Some(parent)
                    || (query.recursive
                        && directory
                            .paths
                            .get(&c.id)
                            .is_some_and(|path| path.contains(parent)))
            } else if query.root_only && !query.recursive {
                c.parent_id.is_none()
            } else {
                true
            }
        })
        .collect::<Vec<_>>();
    let root_generation = if query.container_id.is_none() {
        Some(root_revision)
    } else {
        None
    };
    let generation = if query.page_nodes {
        let mut context = BTreeSet::new();
        if let Some(id) = &query.container_id {
            if let Some(path) = directory.paths.get(id) {
                context.extend(path.iter().cloned());
            }
        }
        for (_, _, _, object) in &nodes {
            if let OrganizationObject::Container { id } = object {
                if let Some(path) = directory.paths.get(id) {
                    context.extend(path.iter().cloned());
                }
            }
        }
        for entry in &entries {
            context.extend(entry.path.iter().cloned());
        }
        let context = all_containers
            .iter()
            .filter(|c| context.contains(&c.id))
            .collect::<Vec<_>>();
        hex::encode(sha2::Sha256::digest(
            encode(&(
                root_generation,
                &relevant_containers,
                &context,
                &entries,
                &nodes,
            ))?
            .as_bytes(),
        ))
    } else {
        hex::encode(sha2::Sha256::digest(
            encode(&(root_generation, &relevant_containers, &entries))?.as_bytes(),
        ))
    };
    let offset = if let Some(page) = continuation {
        if page.scope != scope || page.query != query || page.generation != generation {
            return Err(RuntimeError::Conflict(
                "organization page generation changed; refresh the directory".into(),
            ));
        }
        usize::try_from(page.offset)
            .map_err(|_| RuntimeError::Invalid("invalid continuation offset".into()))?
    } else {
        0
    };
    let total = if query.page_nodes {
        nodes.len()
    } else {
        entries.len()
    };
    if offset > total {
        return Err(RuntimeError::Conflict(
            "organization continuation outside generation".into(),
        ));
    }
    let limit = usize::try_from(query.limit.unwrap_or(100)).unwrap_or(usize::MAX);
    let end = offset.saturating_add(limit).min(total);
    let next_cursor = if end < total {
        Some(encode(&PageCursor {
            scope,
            generation,
            query: query.clone(),
            offset: end as u64,
        })?)
    } else {
        None
    };
    let (containers, conversations, items) = if query.page_nodes {
        let items = nodes
            .drain(offset..end)
            .map(|(_, _, _, o)| o)
            .collect::<Vec<_>>();
        let selected = items
            .iter()
            .filter_map(object_reference)
            .collect::<BTreeSet<_>>();
        let conversations = entries
            .into_iter()
            .filter(|e| selected.contains(&e.conversation))
            .collect::<Vec<_>>();
        let mut context = BTreeSet::new();
        if let Some(id) = &query.container_id {
            if let Some(path) = directory.paths.get(id) {
                context.extend(path.iter().cloned());
            }
        }
        for item in &items {
            if let OrganizationObject::Container { id } = item {
                if let Some(path) = directory.paths.get(id) {
                    context.extend(path.iter().cloned());
                }
            }
        }
        for e in &conversations {
            context.extend(e.path.iter().cloned());
        }
        (
            all_containers
                .into_iter()
                .filter(|c| context.contains(&c.id))
                .collect(),
            conversations,
            Some(items),
        )
    } else {
        (all_containers, entries.drain(offset..end).collect(), None)
    };
    Ok(OrganizationSnapshot {
        initialized,
        revision,
        root_revision,
        cursor,
        containers,
        conversations,
        next_cursor,
        items,
    })
}

/// Resolve a stable model identity without granting membership in another principal's tree.
fn resolve_container(db: &Connection, scope: &str, identity: &str) -> Result<Container> {
    if let Some(raw) = db
        .query_row(
            "SELECT body FROM organization_containers WHERE scope=?1 AND id=?2",
            params![scope, identity],
            |r| r.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(serde_json::from_str(&raw)?);
    }
    if let Some(number) = identity.strip_prefix("container:") {
        let number: i64 = number
            .parse()
            .map_err(|_| RuntimeError::Invalid("invalid container reference".into()))?;
        let value: Option<(String, String)> = db
            .query_row(
                "SELECT owner,target FROM model_references WHERE id=?1 AND kind='container'",
                [number],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (owner, target) =
            value.ok_or_else(|| RuntimeError::NotFound("container reference retired".into()))?;
        if owner != format!("organization:{scope}") {
            return Err(RuntimeError::NotFound(
                "container reference unavailable".into(),
            ));
        }
        let target: Value = serde_json::from_str(&target)?;
        return container(
            db,
            scope,
            target["containerId"]
                .as_str()
                .ok_or_else(|| RuntimeError::Invalid("invalid container target".into()))?,
        );
    }
    container(db, scope, identity)
}
/// Called only inside the original admission transaction. No execution/source fields are changed.
pub(super) fn admit(
    tx: &Transaction<'_>,
    principal: Option<&str>,
    reference: &ConversationRef,
    placement: Option<&Placement>,
    parent: Option<&ConversationRef>,
    key: &str,
) -> Result<()> {
    admit_with_defaults(tx, principal, reference, placement, parent, key, None)
}
/// Explicit execution-project selection supplies navigation only when the caller
/// did not independently choose an organization container. Resolve at the original
/// admission transaction, never by moving an already accepted conversation later.
pub(super) fn admit_dispatch(
    tx: &Transaction<'_>,
    principal: Option<&str>,
    reference: &ConversationRef,
    placement: Option<&Placement>,
    project_id: Option<&str>,
    parent: &ConversationRef,
    key: &str,
) -> Result<()> {
    let project_placement = if placement.is_none() {
        project_id.map(|project| {
            let scope=scope(principal)?;
            let container:Option<String>=tx.query_row("SELECT id FROM organization_containers WHERE scope=?1 AND json_extract(body,'$.projectId')=?2",params![scope,project],|r|r.get(0)).optional()?;
            let container=container.ok_or_else(||RuntimeError::Conflict(format!("Explicit project {project} has no registered navigation entry in this principal's organization; initialize or restore its project entry before dispatch")))?;
            Ok::<_,RuntimeError>(Placement{container_id:Some(container)})
        }).transpose()?
    } else {
        None
    };
    admit(
        tx,
        principal,
        reference,
        placement.or(project_placement.as_ref()),
        Some(parent),
        key,
    )
}
fn admit_with_defaults(
    tx: &Transaction<'_>,
    principal: Option<&str>,
    reference: &ConversationRef,
    placement: Option<&Placement>,
    parent: Option<&ConversationRef>,
    key: &str,
    defaults: Option<&CreationDefaults>,
) -> Result<()> {
    let scope = scope(principal)?;
    let mut intent = json!({"conversation":reference,"placement":placement,"parent":parent});
    if let Some(defaults) = defaults {
        intent["creationDefaults"] = serde_json::to_value(defaults)?;
    }
    let intent = encode(&intent)?;
    let key = format!("admission:{key}");
    if replay(tx, &scope, &key, &intent)?.is_some() {
        return Ok(());
    }
    ensure_space(tx, &scope)?;
    // An external child reserves navigation before the independently managed harness creates
    // its conversation. Its later product create must retain that original accepted position.
    if explicit_position(tx, &scope, reference)?.is_some() {
        return Ok(());
    }
    let target = if let Some(p) = placement {
        Some(
            p.container_id
                .as_deref()
                .map(|id| resolve_container(tx, &scope, id).map(|c| c.id))
                .transpose()?,
        )
    } else if let Some(parent) = parent {
        if direct_bot(tx, parent)?.is_some() {
            Some(position(tx, &scope, parent)?.container_id)
        } else {
            None
        }
    } else {
        Some(None)
    };
    let creation_defaults = if placement.is_some() {
        let mut project_id = None;
        for id in path(tx, &scope, target.as_ref().and_then(|p| p.as_deref()))?
            .into_iter()
            .rev()
        {
            let c = container(tx, &scope, &id)?;
            if c.kind == ContainerKind::Project {
                project_id = c.project_id;
                break;
            }
        }
        Some(CreationDefaults {
            project_id,
            source: None,
        })
    } else {
        None
    };
    let creation_defaults = if let Some(defaults) = defaults {
        if creation_defaults.as_ref().map(|d| &d.project_id) != Some(&defaults.project_id) {
            return Err(RuntimeError::Conflict(
                "creation source defaults no longer match the selected container's project".into(),
            ));
        }
        match (&defaults.project_id, &defaults.source) {
            (Some(_), Some(source))
                if source.resource_owner.validate()
                    && source.selection.as_ref().is_none_or(|selection| selection.valid(source.workspace_id.as_deref()))
                    && !source.path.trim().is_empty()
                    && !source.path.contains('\0')
                    && source
                        .workspace_id
                        .as_deref()
                        .is_none_or(|id| !id.trim().is_empty()) => {}
            (None, None) => {}
            _ => return Err(RuntimeError::Invalid(
                "creation defaults require the registered project's exact source owner and path"
                    .into(),
            )),
        }
        Some(defaults.clone())
    } else {
        creation_defaults
    };
    let positions = if let Some(target) = target {
        let p = Position {
            conversation: reference.clone(),
            container_id: target.clone(),
            order: siblings(tx, &scope, target.as_deref())?.len() as u64,
            revision: 1,
            explicit: true,
            inherited_from: None,
        };
        save_position(tx, &scope, &p)?;
        bump_parent(tx, &scope, target.as_deref())?;
        vec![p]
    } else {
        Vec::new()
    };
    let mut receipt = finish(tx, &scope, &key, &intent, Vec::new(), positions)?;
    if creation_defaults.is_some() {
        receipt.creation_defaults = creation_defaults;
        tx.execute(
            "UPDATE organization_commands SET receipt=?3 WHERE scope=?1 AND key=?2",
            params![scope, key, encode(&receipt)?],
        )?;
    }
    Ok(())
}
impl Catalog {
    pub fn organization_container_reference(
        &self,
        principal: Option<&str>,
        id: &str,
        holder: &str,
    ) -> Result<String> {
        let scope = scope(principal)?;
        let c = container(&self.db, &scope, id)?;
        self.register_model_reference(
            model_references::ReferenceKind::Container,
            &format!("organization:{scope}"),
            &json!({"containerId":c.id}),
            holder,
        )
    }
    pub fn resolve_organization_container(
        &self,
        principal: Option<&str>,
        reference: &str,
    ) -> Result<Container> {
        resolve_container(&self.db, &scope(principal)?, reference)
    }
    pub fn create_thread_with_placement(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        principal: Option<&str>,
        placement: Option<Placement>,
    ) -> Result<()> {
        self.create_thread_owned_with_placement(thread_id, branch_id, None, principal, placement)
    }
    pub fn create_bot_thread_with_placement(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        bot_id: &str,
        principal: Option<&str>,
        placement: Option<Placement>,
    ) -> Result<()> {
        let principal = bot::creation_principal(&self.db, thread_id, principal)?;
        self.create_thread_owned_with_placement(
            thread_id,
            branch_id,
            Some(bot_id),
            principal.as_deref(),
            placement,
        )
    }
    pub(super) fn create_thread_owned_with_placement(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        bot_id: Option<&str>,
        principal: Option<&str>,
        placement: Option<Placement>,
    ) -> Result<()> {
        self.create_thread_owned_with_defaults(
            thread_id, branch_id, bot_id, principal, placement, None,
        )
    }
    pub fn create_thread_with_organization_defaults(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        principal: Option<&str>,
        placement: Option<Placement>,
        defaults: Option<CreationDefaults>,
    ) -> Result<()> {
        self.create_thread_owned_with_defaults(
            thread_id, branch_id, None, principal, placement, defaults,
        )
    }
    pub fn create_bot_thread_with_organization_defaults(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        bot_id: &str,
        principal: Option<&str>,
        placement: Option<Placement>,
        defaults: Option<CreationDefaults>,
    ) -> Result<()> {
        let principal = bot::creation_principal(&self.db, thread_id, principal)?;
        self.create_thread_owned_with_defaults(
            thread_id,
            branch_id,
            Some(bot_id),
            principal.as_deref(),
            placement,
            defaults,
        )
    }
    fn create_thread_owned_with_defaults(
        &mut self,
        thread_id: &str,
        branch_id: &str,
        bot_id: Option<&str>,
        principal: Option<&str>,
        placement: Option<Placement>,
        defaults: Option<CreationDefaults>,
    ) -> Result<()> {
        let tx = self.db.transaction()?;
        let existed: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
            [thread_id],
            |r| r.get(0),
        )?;
        identity::create_public(&tx, thread_id, branch_id, bot_id, principal, self.epoch)?;
        let scope = scope(principal)?;
        let key = format!("admission:create:{thread_id}");
        let has_receipt: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM organization_commands WHERE scope=?1 AND key=?2)",
            params![scope, key],
            |r| r.get(0),
        )?;
        if existed && !has_receipt {
            if placement.is_some() {
                return Err(RuntimeError::Conflict(
                    "existing Thread has no original navigation admission; move it explicitly"
                        .into(),
                ));
            }
        } else {
            admit_with_defaults(
                &tx,
                principal,
                &ConversationRef::Native {
                    id: thread_id.into(),
                },
                placement.as_ref(),
                None,
                &format!("create:{thread_id}"),
                defaults.as_ref(),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

pub(super) fn check_legacy_format(db: &Connection) -> Result<()> {
    let present:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name IN('organization_spaces','organization_containers','organization_positions','organization_commands','organization_retired_containers'))",[],|r|r.get(0))?;
    if present {
        return Err(RuntimeError::Invalid(
            "legacy Catalog contains newer organization schema; assets preserved".into(),
        ));
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn remove_for_legacy_fixture(db: &Connection) {
    db.execute_batch("DROP TABLE IF EXISTS organization_retired_containers;DROP TABLE IF EXISTS organization_positions;DROP TABLE IF EXISTS organization_containers;DROP TABLE IF EXISTS organization_commands;DROP TABLE IF EXISTS organization_spaces;").unwrap();
}

impl Catalog {
    pub fn organization_nearest_project(
        &self,
        principal: Option<&str>,
        reference: &str,
    ) -> Result<Option<String>> {
        let scope = scope(principal)?;
        let c = resolve_container(&self.db, &scope, reference)?;
        for id in path(&self.db, &scope, Some(&c.id))?.into_iter().rev() {
            let c = container(&self.db, &scope, &id)?;
            if c.kind == ContainerKind::Project {
                return Ok(c.project_id);
            }
        }
        Ok(None)
    }
}

impl Catalog {
    /// Bind a derived default to the original tool Operation, without changing its admitted
    /// arguments. Later tree movement cannot silently prepare a different execution source.
    pub fn freeze_dispatch_organization_default(
        &mut self,
        context: &crate::execution::ToolExecutionContext,
        input: &dispatch::DispatchInput,
    ) -> Result<()> {
        let original = serde_json::to_value(input)?;
        if self
            .model_target(
                &context.operation_id,
                "organization-default-project",
                &original,
            )?
            .is_some()
        {
            return Ok(());
        }
        let run = self.run(&context.run_id)?;
        let op = self.operation(&context.operation_id)?;
        let intent = super::tool_content::ToolIntent::from_operation(&op)?;
        if op.run_id != run.id
            || intent.origin() != &context.origin
            || !matches!(intent.call().name.as_str(), "dispatch" | "code_retrieval")
        {
            return Err(RuntimeError::Conflict(
                "organization default differs from original dispatch".into(),
            ));
        }
        let project = if input.project_id.is_none()
            && input.source_agent.is_none()
            && input.source_path.is_none()
        {
            input
                .organization
                .as_ref()
                .and_then(|p| p.container_id.as_deref())
                .map(|id| self.organization_nearest_project(run.principal_id.as_deref(), id))
                .transpose()?
                .flatten()
        } else {
            None
        };
        self.freeze_model_target(
            &context.operation_id,
            "organization-default-project",
            &original,
            &json!({"projectId":project}),
        )?;
        Ok(())
    }
}

/// The existing explicit legacy-claim policy also owns already-created public navigation.
/// It runs once at authentication initialization, never on an ordinary first read.
pub(super) fn claim_legacy(tx: &Transaction<'_>, owner: &str) -> Result<()> {
    let old = scope(None)?;
    let new = scope(Some(owner))?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM organization_spaces WHERE scope=?1)",
        [&old],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    let target: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM organization_spaces WHERE scope=?1)",
        [&new],
        |r| r.get(0),
    )?;
    if target {
        return Err(RuntimeError::Conflict("legacy organization and owner organization both exist; refusing to overwrite their identities".into()));
    }
    for table in [
        "organization_spaces",
        "organization_containers",
        "organization_positions",
        "organization_commands",
        "organization_retired_containers",
    ] {
        tx.execute(
            &format!("UPDATE {table} SET scope=?2 WHERE scope=?1"),
            params![old, new],
        )?;
    }
    tx.execute(
        "UPDATE model_references SET owner=?2 WHERE kind='container' AND owner=?1",
        params![format!("organization:{old}"), format!("organization:{new}")],
    )?;
    let revision = tx.query_row(
        "UPDATE organization_spaces SET revision=revision+1 WHERE scope=?1 RETURNING revision",
        [&new],
        |r| read_number(r, 0),
    )?;
    event(
        tx,
        &format!("organization:{new}"),
        revision,
        "organization.changed",
        json!({"scope":new,"reason":"legacy_owner_initialized"}),
    )?;
    Ok(())
}

impl Catalog {
    /// Source defaults are creation evidence, not a projection of the conversation's current
    /// location. A later move or dissolution cannot redirect its first executable request.
    pub fn organization_creation_defaults(
        &self,
        thread_id: &str,
    ) -> Result<Option<CreationDefaults>> {
        let principal = principals::thread(&self.db, thread_id)?;
        let scope = scope(principal.as_deref())?;
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT receipt FROM organization_commands WHERE scope=?1 AND key=?2",
                params![scope, format!("admission:create:{thread_id}")],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| {
            serde_json::from_str::<OrganizationReceipt>(&raw)
                .map(|r| r.creation_defaults)
                .map_err(Into::into)
        })
        .transpose()
        .map(Option::flatten)
    }
}

impl Catalog {
    pub fn organization_receipt(
        &self,
        principal: Option<&str>,
        command: &OrganizationCommand,
    ) -> Result<Option<OrganizationReceipt>> {
        replay(
            &self.db,
            &scope(principal)?,
            &command.key,
            &encode(&command.operation)?,
        )
    }
}
