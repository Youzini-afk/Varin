//! One-action approval binds immutable call/scope bodies; decisions retain only their identities.
use super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionCallIdentity {
    pub run_id: String,
    pub operation_id: String,
    pub request_id: String,
    pub call_id: String,
    pub name: String,
    pub schema_version: String,
}
pub struct PermissionPreparation {
    call: Value,
    scope: Value,
    content: crate::content::ContentStore,
    publication: crate::content::ContentPublication,
}
pub struct PreparedPermission {
    pub(super) identity: PermissionCallIdentity,
    pub(super) call_ref: Value,
    pub(super) scope_ref: Value,
    pub(super) arguments_ref: Value,
    _publication: crate::content::ContentPublication,
}
impl PermissionPreparation {
    pub fn load(self) -> Result<PreparedPermission> {
        if ![
            "ownerReference",
            "toolSchemaVersion",
            "policyGeneration",
            "reason",
        ]
        .iter()
        .all(|key| {
            self.scope
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        }) || self
            .scope
            .get("ownerGeneration")
            .and_then(Value::as_u64)
            .is_none()
            || self.scope.get("toolSchemaVersion") != self.call.get("schemaVersion")
        {
            return Err(RuntimeError::Invalid("invalid permission scope".into()));
        }
        let identity = PermissionCallIdentity::deserialize(&self.call)?;
        let arguments_ref =
            self.content
                .save(self.call.get("arguments").ok_or_else(|| {
                    RuntimeError::Invalid("permission arguments are missing".into())
                })?)?;
        Ok(PreparedPermission {
            identity,
            arguments_ref,
            call_ref: self.content.save(&self.call)?,
            scope_ref: self.content.save(&self.scope)?,
            _publication: self.publication,
        })
    }
}
impl Catalog {
    pub fn prepare_permission(&self, call: Value, scope: Value) -> PermissionPreparation {
        PermissionPreparation {
            call,
            scope,
            content: self.content.clone(),
            publication: self.content.begin_publication(),
        }
    }
}
