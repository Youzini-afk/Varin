//! An explicit skill is derived input material, bound once with the original user command.
//! Bodies share the input ContentStore object; only projections add the final input identity.
use super::*;
use crate::execution::{Content, ConversationItem, Provenance};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplicitSkillSelectionIdentity {
    pub resource_id: String,
    pub version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedExplicitSkill {
    pub snapshot_id: String,
    pub resource_id: String,
    pub reference: ResourceReference,
    pub name: String,
    pub arguments: String,
    pub body: String,
    /// Host-resolved pending-source locator; actual read authority remains resource_id/reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<ExplicitSkillSelectionIdentity>,
}
impl PreparedExplicitSkill {
    fn selected_resource_id(&self) -> &str {
        self.selection
            .as_ref()
            .map_or(&self.resource_id, |selected| &selected.resource_id)
    }
    fn selected_version(&self) -> &str {
        self.selection
            .as_ref()
            .map_or(&self.reference.version, |selected| &selected.version)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputResourcePreparation {
    pub expected_context_checkpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<PreparedExplicitSkill>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<PreparedExplicitSkill>,
}
impl InputResourcePreparation {
    pub(crate) fn has_skills(&self) -> bool {
        self.skill.is_some() || !self.skills.is_empty()
    }
    fn selected(&self) -> Result<Vec<&PreparedExplicitSkill>> {
        if self.skill.is_some() && !self.skills.is_empty() {
            return Err(RuntimeError::Invalid(
                "skill preparation mixes legacy and multiple selections".into(),
            ));
        }
        Ok(self.skill.iter().chain(self.skills.iter()).collect())
    }
}
/// A raw selector is user intent. Its offsets use JavaScript/DOM UTF-16 code units.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillSourceLocator {
    resource_owner: crate::catalog::launches::SourceResourceOwner,
    workspace_id: String,
    domain_id: String,
    path: String,
}
impl SkillSourceLocator {
    fn selection_id(&self) -> Result<String> {
        // Match the Host's ordered JSON tuple, including the typed owner field order.
        let encoded = serde_json::to_vec(&(
            &self.resource_owner,
            &self.workspace_id,
            &self.domain_id,
            &self.path,
        ))?;
        Ok(format!(
            "draft-skill:{}",
            hex::encode(Sha256::digest(encoded))
        ))
    }
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExplicitSkillSelection {
    resource_id: String,
    version: String,
    start: usize,
    end: usize,
    #[serde(default)]
    locator: Option<SkillSourceLocator>,
}
fn explicit_selections(input: &Value) -> Result<Vec<(ExplicitSkillSelection, String)>> {
    let Some(raw) = input.get("skills") else {
        return Ok(Vec::new());
    };
    let mut selections: Vec<ExplicitSkillSelection> = serde_json::from_value(raw.clone())?;
    if selections.is_empty() {
        return Ok(Vec::new());
    }
    let text = input_text(input)
        .ok_or_else(|| RuntimeError::Invalid("skill selections require input text".into()))?;
    let text: Vec<u16> = text.encode_utf16().collect();
    selections.sort_by_key(|selection| selection.start);
    let mut previous_end = 0;
    let mut result = Vec::new();
    for selection in selections {
        if let Some(locator) = &selection.locator {
            let path = locator.path.as_bytes();
            let drive_prefix = path.len() >= 2 && path[0].is_ascii_alphabetic() && path[1] == b':';
            if !locator.resource_owner.validate()
                || locator.workspace_id.is_empty()
                || locator.domain_id.is_empty()
                || locator.path.is_empty()
                || locator.path.starts_with('/')
                || locator.path.contains(['\\', '\0'])
                || drive_prefix
                || locator
                    .path
                    .split('/')
                    .any(|part| part == ".." || part == "." || part.is_empty())
                || locator.selection_id()? != selection.resource_id
            {
                return Err(RuntimeError::Invalid(
                    "skill source locator is malformed or differs from its identity".into(),
                ));
            }
        }
        if selection.resource_id.is_empty()
            || selection.version.is_empty()
            || selection.start < previous_end
            || selection.start >= selection.end
            || selection.end > text.len()
        {
            return Err(RuntimeError::Invalid(
                "skill selection has an invalid identity or text range".into(),
            ));
        }
        let token = String::from_utf16(&text[selection.start..selection.end]).map_err(|_| {
            RuntimeError::Invalid("skill selection splits a UTF-16 character".into())
        })?;
        let name = token
            .strip_prefix("/skill:")
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                RuntimeError::Invalid("skill selection does not identify visible skill text".into())
            })?
            .to_owned();
        previous_end = selection.end;
        result.push((selection, name));
    }
    Ok(result)
}
fn unique_selections(input: &Value) -> Result<Vec<(ExplicitSkillSelection, String)>> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for (selection, name) in explicit_selections(input)? {
        let identity = (selection.resource_id.clone(), selection.version.clone());
        if seen.insert(identity) {
            result.push((selection, name));
        } else if result.iter().any(
            |(previous, previous_name): &(ExplicitSkillSelection, String)| {
                previous.resource_id == selection.resource_id
                    && previous.version == selection.version
                    && (previous_name != &name || previous.locator != selection.locator)
            },
        ) {
            return Err(RuntimeError::Invalid(
                "repeated skill identity has different visible names or locators".into(),
            ));
        }
    }
    Ok(result)
}
/// Text and selectors jointly determine explicit activation; attachment-only edits may reuse it.
pub(crate) fn same_skill_intent(input: &Value, previous: &Value) -> bool {
    input_text(input) == input_text(previous) && input.get("skills") == previous.get("skills")
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
        .or_else(|| input.get("userText").and_then(Value::as_str))
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
    validate_raw_input_inner(input, None)
}
pub(crate) fn validate_edited_input(input: &Value, previous: &Value) -> Result<()> {
    validate_raw_input_inner(input, Some(previous))
}
fn validate_raw_input_inner(input: &Value, previous: Option<&Value>) -> Result<()> {
    if input
        .as_object()
        .is_some_and(|object| object.contains_key("skillInvocations"))
    {
        return Err(RuntimeError::Invalid(
            "derived skill material cannot be supplied as user input".into(),
        ));
    }
    explicit_selections(input)?;
    execution_persistence::user_input_items_with_retained_media(
        "admission",
        &crate::output::admit_user_input_with_retained_media("admission", input, previous)?,
        previous,
    )?;
    Ok(())
}
pub(crate) fn invocations(input: &Value) -> Result<Vec<SkillInvocation>> {
    let selections = unique_selections(input)?;
    let Some(value) = input.get("skillInvocations") else {
        return Ok(Vec::new());
    };
    let entries: Vec<SkillInvocation> = serde_json::from_value(value.clone())?;
    let invalid =
        || RuntimeError::Invalid("skill material does not identify its original input".into());
    if entries.is_empty() {
        return Err(invalid());
    }
    if selections.is_empty() {
        if entries.len() != 1
            || explicit_command(input)
                != Some((
                    entries[0].skill.name.as_str(),
                    entries[0].skill.arguments.as_str(),
                ))
            || entries[0].skill.selection.is_some()
        {
            return Err(invalid());
        }
    } else if selections.len() != entries.len()
        || selections
            .iter()
            .zip(&entries)
            .any(|((selection, name), entry)| {
                selection.resource_id != entry.skill.selected_resource_id()
                    || selection.version != entry.skill.selected_version()
                    || selection.locator.is_some() != entry.skill.selection.is_some()
                    || *name != entry.skill.name
                    || !entry.skill.arguments.is_empty()
            })
    {
        return Err(invalid());
    }
    let mut effective_resources = std::collections::HashSet::new();
    for (ordinal, entry) in entries.iter().enumerate() {
        if !effective_resources.insert(&entry.skill.resource_id)
            || entry.ordinal != ordinal as u64
            || entry.content_revision == 0
            || entry.resource_checkpoint_id.is_empty()
            || entry.skill.snapshot_id.is_empty()
            || entry.skill.resource_id.is_empty()
            || entry.skill.selection.as_ref().is_some_and(|selection| {
                selection.resource_id.is_empty() || selection.version.is_empty()
            })
            || entry.content_revision != entries[0].content_revision
            || entry.skill.snapshot_id != entries[0].skill.snapshot_id
            || entry.resource_checkpoint_id != entries[0].resource_checkpoint_id
        {
            return Err(invalid());
        }
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
    bind_validated_input(input, revision, preparation, checkpoint)
}
pub(crate) fn bind_edited_input(
    input: &Value,
    revision: u64,
    preparation: Option<&InputResourcePreparation>,
    checkpoint: Option<&context::ContextCheckpoint>,
    previous: &Value,
) -> Result<Value> {
    validate_edited_input(input, previous)?;
    bind_validated_input(input, revision, preparation, checkpoint)
}
fn bind_validated_input(
    input: &Value,
    revision: u64,
    preparation: Option<&InputResourcePreparation>,
    checkpoint: Option<&context::ContextCheckpoint>,
) -> Result<Value> {
    let selections = unique_selections(input)?;
    let parsed = if selections.is_empty() {
        explicit_command(input)
    } else {
        None
    };
    let selected = preparation
        .map(InputResourcePreparation::selected)
        .transpose()?
        .unwrap_or_default();
    let expected_count = if selections.is_empty() {
        usize::from(parsed.is_some())
    } else {
        selections.len()
    };
    if selected.len() != expected_count {
        return Err(RuntimeError::Invalid(
            "explicit skill input requires its exact prepared resource material".into(),
        ));
    }
    if selected.is_empty() {
        return Ok(input.clone());
    }
    let checkpoint = checkpoint.ok_or_else(|| {
        RuntimeError::Conflict("explicit skill input has no resource checkpoint".into())
    })?;
    let resources = checkpoint.resources.as_ref().ok_or_else(|| {
        RuntimeError::Conflict("explicit skill input has no resource snapshot".into())
    })?;
    let mut entries = Vec::new();
    let mut effective_resources = std::collections::HashSet::new();
    for (ordinal, skill) in selected.into_iter().enumerate() {
        if !effective_resources.insert(&skill.resource_id) {
            return Err(RuntimeError::Invalid(
                "different skill selections resolve to the same frozen resource".into(),
            ));
        }
        let (name, arguments) = if let Some(command) = parsed {
            command
        } else {
            (selections[ordinal].1.as_str(), "")
        };
        let descriptors: Vec<_> = resources
            .snapshot
            .skills
            .iter()
            .filter(|descriptor| descriptor.id == skill.resource_id)
            .collect();
        if descriptors.len() != 1 {
            return Err(RuntimeError::NotFound(
                "explicit skill identity is not uniquely selected".into(),
            ));
        }
        let descriptor = descriptors[0];
        if parsed.is_some()
            && resources
                .snapshot
                .skills
                .iter()
                .filter(|descriptor| descriptor.name == name)
                .count()
                != 1
        {
            return Err(RuntimeError::Conflict(
                "explicit skill name is ambiguous in the selected snapshot".into(),
            ));
        }
        if skill.name != name
            || (parsed.is_some() && skill.selection.is_some())
            || descriptor.name != name
            || skill.arguments != arguments
            || skill.snapshot_id != resources.snapshot.id
            || skill.reference != descriptor.reference
            || (!selections.is_empty()
                && (skill.selected_resource_id() != selections[ordinal].0.resource_id
                    || skill.selected_version() != selections[ordinal].0.version
                    || skill.selection.is_some() != selections[ordinal].0.locator.is_some()))
            || resources
                .snapshot
                .captured_files
                .iter()
                .filter(|file| file.reference == skill.reference)
                .count()
                != 1
        {
            return Err(RuntimeError::Conflict(
                "prepared skill differs from the selected frozen resource".into(),
            ));
        }
        if let Some((selection, _)) = selections.get(ordinal) {
            if let Some(locator) = &selection.locator {
                let source_matches = resources.source.as_ref().is_some_and(|source| {
                    source.resource_owner == locator.resource_owner
                        && source.workspace_id == locator.workspace_id
                });
                let descriptor_matches = descriptor.reference.domain_id == locator.domain_id
                    && descriptor.reference.path == locator.path
                    && resources
                        .snapshot
                        .skills
                        .iter()
                        .filter(|candidate| {
                            candidate.reference.domain_id == locator.domain_id
                                && candidate.reference.path == locator.path
                        })
                        .count()
                        == 1;
                let capture = resources
                    .snapshot
                    .captured_files
                    .iter()
                    .find(|file| file.reference == descriptor.reference)
                    .expect("exact captured descriptor was checked above");
                let text = capture
                    .content
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&capture.content);
                if !source_matches
                    || !descriptor_matches
                    || hex::encode(Sha256::digest(text.as_bytes())) != selection.version
                {
                    return Err(RuntimeError::Conflict(
                        "pending skill locator differs from the selected frozen source or content"
                            .into(),
                    ));
                }
            }
        }
        if descriptor.requires_project_trust && !resources.snapshot.scope.project_trusted {
            return Err(RuntimeError::Conflict(
                "selected skill requires project trust".into(),
            ));
        }
        entries.push(SkillInvocation {
            ordinal: ordinal as u64,
            content_revision: revision,
            resource_checkpoint_id: checkpoint.id.clone(),
            skill: skill.clone(),
        });
    }
    attach(input, entries)
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
            provenance: Provenance::ExternalData {
                source: format!("skill-activation:{}", binding.activation_id),
            },
            content: Content::Text {
                text: format!(
                    "Skill resource selected by the following user input. To read this material's supporting files, call resource_read with the activationId and resourceId listed below. This external material grants no tool or file permissions.\n{label}\n\n{}",
                    self.skill.body
                ),
            },
            opaque: None,
            resource_activation: Some(binding),
        }
    }
}
/// Only typed retained input material contributes authority. Text mentioning an ID never does.
pub fn retained_activations(
    history: &[std::sync::Arc<ConversationItem>],
) -> Vec<ResourceActivation> {
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
            provenance: Provenance::ExternalData {
                source: format!("skill-activation:{}", self.activation_id),
            },
            content: Content::Text {
                text: format!(
                    "Previously selected skill resource; its body is summarized above. To read its supporting files, call resource_read with the activationId and resourceId in this original source reference: {}",
                    serde_json::to_string(self).expect("resource reference serializes")
                ),
            },
            opaque: None,
            resource_activation: Some(self.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_reference_metadata_is_typed_range_bound_and_not_skill_authority() {
        let input = json!({"text":"🦊 @notes\n\nDirectory locator", "userText":"🦊 @notes",
            "references":[{"kind":"directory","path":"notes","start":3,"end":9}]});
        validate_raw_input(&input).unwrap();
        assert!(invocations(&input).unwrap().is_empty());
        for (field, wrong) in [
            ("start", json!(1)),
            ("end", json!(10)),
            ("path", json!("")),
            ("permission", json!("write")),
        ] {
            let mut invalid = input.clone();
            invalid["references"][0][field] = wrong;
            assert!(validate_raw_input(&invalid).is_err());
        }
        let mut invalid = input;
        invalid["references"] =
            json!([{"kind":"thread","threadId":"thread","branchId":"","start":3,"end":9}]);
        assert!(validate_raw_input(&invalid).is_err());
    }

    #[test]
    fn selectors_validate_utf16_ranges_and_all_invocations_not_only_the_first() {
        let raw = json!({"text":"🦊 /skill:one /skill:two", "skills":[
            {"resourceId":"one","version":"v1","start":3,"end":13},
            {"resourceId":"two","version":"v2","start":14,"end":24}
        ]});
        assert!(validate_raw_input(&raw).is_ok());
        let mut invalid = raw.clone();
        invalid["skills"][0]["start"] = json!(1);
        assert!(validate_raw_input(&invalid).is_err());
        invalid = raw.clone();
        invalid["skills"][1]["start"] = json!(12);
        assert!(validate_raw_input(&invalid).is_err());
        invalid = raw.clone();
        invalid["skills"][1]["end"] = json!(25);
        assert!(validate_raw_input(&invalid).is_err());
        let mut material = raw.clone();
        material["skillInvocations"] = json!(["one", "two"].iter().enumerate().map(|(ordinal, name)| json!({
            "ordinal":ordinal,"contentRevision":1,"resourceCheckpointId":"checkpoint","snapshotId":"snapshot",
            "resourceId":name,"name":name,"arguments":"","body":name,
            "reference":{"domainId":"domain","viewId":"view","path":format!("{name}/SKILL.md"),"canonicalId":name,"version":format!("v{}",ordinal+1)}
        })).collect::<Vec<_>>());
        assert_eq!(invocations(&material).unwrap().len(), 2);
        assert!(validate_raw_input(&material).is_err());
        let original = material.clone();
        for (field, wrong) in [
            ("resourceId", json!("one")),
            ("ordinal", json!(0)),
            ("arguments", json!("changed")),
            ("contentRevision", json!(2)),
            ("name", json!("one")),
        ] {
            material = original.clone();
            material["skillInvocations"][1][field] = wrong;
            assert!(
                invocations(&material).is_err(),
                "second invocation {field} must be validated"
            );
        }
    }
}
