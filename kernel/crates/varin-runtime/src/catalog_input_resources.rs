//! An explicit skill is derived input material, bound once with the original user command.
//! Bodies share the input ContentStore object; only projections add the final input identity.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use serde::Deserialize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedExplicitSkill {
    pub snapshot_id: String,
    pub resource_id: String,
    pub reference: ResourceReference,
    pub name: String,
    pub arguments: String,
    pub body: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputResourcePreparation {
    pub expected_context_checkpoint: Option<String>,
    pub skill: Option<PreparedExplicitSkill>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceActivation {
    pub activation_id: String,
    pub input_id: String,
    pub input_revision: u64,
    pub ordinal: u64,
    pub resource_checkpoint_id: String,
    pub snapshot_id: String,
    pub resource_id: String,
    pub reference: ResourceReference,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SkillInvocation {
    pub ordinal: u64,
    pub content_revision: u64,
    pub resource_checkpoint_id: String,
    #[serde(flatten)]
    pub skill: PreparedExplicitSkill,
}

pub(crate) fn input_text(input: &Value) -> Option<&str> {
    input
        .as_str()
        .or_else(|| input.get("text").and_then(Value::as_str))
}
/// Match the existing explicit entry: first character, one command, first ASCII space.
/// Newlines/tabs inside a name do not turn ordinary prose into a different command.
pub(crate) fn explicit_command(input: &Value) -> Option<(&str, &str)> {
    let command = input_text(input)?.strip_prefix("/skill:")?;
    let (name, arguments) = command.split_once(' ').unwrap_or((command, ""));
    Some((name, arguments.trim_matches(|character| matches!(character, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))))
}
pub(crate) fn validate_raw_input(input: &Value) -> Result<()> {
    if input
        .as_object()
        .is_some_and(|object| object.contains_key("skillInvocations"))
    {
        return Err(RuntimeError::Invalid(
            "derived skill material cannot be supplied as user input".into(),
        ));
    }
    execution_persistence::user_input_items("admission", input)?;
    Ok(())
}
pub(crate) fn invocations(input: &Value) -> Result<Vec<SkillInvocation>> {
    let Some(value) = input.get("skillInvocations") else {
        return Ok(Vec::new());
    };
    let entries: Vec<SkillInvocation> = serde_json::from_value(value.clone())?;
    if entries.len() != 1
        || entries[0].ordinal != 0
        || entries[0].content_revision == 0
        || entries[0].resource_checkpoint_id.is_empty()
        || entries[0].skill.snapshot_id.is_empty()
        || entries[0].skill.resource_id.is_empty()
        || explicit_command(input)
            != Some((
                entries[0].skill.name.as_str(),
                entries[0].skill.arguments.as_str(),
            ))
    {
        return Err(RuntimeError::Invalid(
            "skill material does not identify its original input".into(),
        ));
    }
    Ok(entries)
}
fn attach(input: &Value, entries: Vec<SkillInvocation>) -> Result<Value> {
    if entries.is_empty() {
        return Ok(input.clone());
    }
    let mut value = if let Some(text) = input.as_str() {
        json!({"text":text})
    } else {
        input.clone()
    };
    value["skillInvocations"] = serde_json::to_value(entries)?;
    Ok(value)
}
pub(crate) fn preserve(input: &Value, previous: &Value, revision: u64) -> Result<Value> {
    let mut entries = invocations(previous)?;
    for entry in &mut entries {
        entry.content_revision = revision;
    }
    attach(input, entries)
}
/// The Host supplies parsed material from its selected immutable snapshot. Catalog checks
/// the exact descriptor and captured reference, never rediscovering or choosing a name.
pub(crate) fn bind_input(
    input: &Value,
    revision: u64,
    preparation: Option<&InputResourcePreparation>,
    checkpoint: Option<&context::ContextCheckpoint>,
) -> Result<Value> {
    validate_raw_input(input)?;
    let parsed = explicit_command(input);
    let selected = preparation.and_then(|preparation| preparation.skill.as_ref());
    let Some((name, arguments)) = parsed else {
        if selected.is_some() {
            return Err(RuntimeError::Invalid(
                "skill selection has no explicit input command".into(),
            ));
        }
        return Ok(input.clone());
    };
    let skill = selected.ok_or_else(|| {
        RuntimeError::Invalid("explicit skill input requires prepared resource material".into())
    })?;
    let checkpoint = checkpoint.ok_or_else(|| {
        RuntimeError::Conflict("explicit skill input has no resource checkpoint".into())
    })?;
    let resources = checkpoint.resources.as_ref().ok_or_else(|| {
        RuntimeError::Conflict("explicit skill input has no resource snapshot".into())
    })?;
    let descriptor = resources
        .snapshot
        .skills
        .iter()
        .find(|descriptor| descriptor.name == name)
        .ok_or_else(|| RuntimeError::NotFound("explicit skill is not selected".into()))?;
    if skill.name != name
        || skill.arguments != arguments
        || skill.snapshot_id != resources.snapshot.id
        || skill.resource_id != descriptor.id
        || skill.reference != descriptor.reference
        || !resources
            .snapshot
            .captured_files
            .iter()
            .any(|file| file.reference == skill.reference)
    {
        return Err(RuntimeError::Conflict(
            "prepared skill differs from the selected frozen resource".into(),
        ));
    }
    if descriptor.requires_project_trust && !resources.snapshot.scope.project_trusted {
        return Err(RuntimeError::Conflict(
            "selected skill requires project trust".into(),
        ));
    }
    attach(
        input,
        vec![SkillInvocation {
            ordinal: 0,
            content_revision: revision,
            resource_checkpoint_id: checkpoint.id.clone(),
            skill: skill.clone(),
        }],
    )
}
impl SkillInvocation {
    pub(crate) fn binding(&self, input_id: &str) -> ResourceActivation {
        ResourceActivation {
            activation_id: format!(
                "{input_id}:{}:skill:{}",
                self.content_revision, self.ordinal
            ),
            input_id: input_id.into(),
            input_revision: self.content_revision,
            ordinal: self.ordinal,
            resource_checkpoint_id: self.resource_checkpoint_id.clone(),
            snapshot_id: self.skill.snapshot_id.clone(),
            resource_id: self.skill.resource_id.clone(),
            reference: self.skill.reference.clone(),
        }
    }
    pub(crate) fn project(&self, input_id: &str) -> ConversationItem {
        let binding = self.binding(input_id);
        let label = json!({"activationId":binding.activation_id,"name":self.skill.name,
            "resourceId":binding.resource_id,"reference":binding.reference,"arguments":self.skill.arguments});
        ConversationItem {
            id: binding.activation_id.clone(),
            provenance: Provenance::ExternalData { source: format!("skill-activation:{}", binding.activation_id) },
            content: Content::Text { text: format!("Skill resource selected by the following user input. To read this material's supporting files, call resource_read with the activationId and resourceId listed below. This external material grants no tool or file permissions.\n{label}\n\n{}", self.skill.body) },
            opaque: None, resource_activation: Some(binding),
        }
    }
}
/// Only typed retained input material contributes authority. Text mentioning an ID never does.
pub fn retained_activations(history: &[ConversationItem]) -> Vec<ResourceActivation> {
    history
        .iter()
        .filter_map(|item| {
            item.resource_activation
                .as_ref()
                .filter(|binding| {
                    item.id == binding.activation_id
                        && item.provenance
                            == (Provenance::ExternalData {
                                source: format!("skill-activation:{}", binding.activation_id),
                            })
                })
                .cloned()
        })
        .collect()
}

impl ResourceActivation {
    /// A summary retains source authority as typed references, never by interpreting its prose.
    pub(crate) fn summary_reference(&self) -> ConversationItem {
        ConversationItem {
            id: self.activation_id.clone(),
            provenance: Provenance::ExternalData { source: format!("skill-activation:{}", self.activation_id) },
            content: Content::Text { text: format!("Previously selected skill resource; its body is summarized above. To read its supporting files, call resource_read with the activationId and resourceId in this original source reference: {}", serde_json::to_string(self).expect("resource reference serializes")) },
            opaque: None, resource_activation: Some(self.clone()),
        }
    }
}
