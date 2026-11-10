//! A delivery view over immutable event inputs. Queue/occurrence identities and controls
//! remain independent; only evidence supplied at the same consumption boundary is shared.
use super::*;
use crate::content::ContentStore;
use crate::output::OutputPart;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventMaterial {
    instruction_ref: Option<Value>,
    #[serde(default)]
    arrangement_id: Option<String>,
    #[serde(default)]
    trigger: Option<Value>,
    prefix_parts: usize,
    events: Vec<(Value, Value)>,
}
struct Input {
    item: ConversationItem,
    material: EventMaterial,
}
pub(crate) fn original_events(content: &ContentStore, history: &Value) -> Result<Vec<Value>> {
    let payload = content.load(history)?;
    let Some(material) = payload
        .get("metadata")
        .and_then(|m| m.get("arrangementEvents"))
    else {
        return Ok(vec![]);
    };
    let material: EventMaterial = serde_json::from_value(material.clone())?;
    material
        .events
        .iter()
        .map(|(source, reference)| {
            Ok(json!({"source":source,"content":content.load_stored_output(reference)?}))
        })
        .collect()
}
pub(crate) struct Projection {
    pub item: ConversationItem,
    pub dependencies: Vec<String>,
}

/// None is an ordering/trust boundary: ordinary messages and trusted personal input
/// keep their original sequence and are never treated as replaceable notifications.
pub(crate) fn project_batch(
    content: &ContentStore,
    references: &[Option<Value>],
) -> Result<Vec<Option<Projection>>> {
    let mut inputs = Vec::with_capacity(references.len());
    for reference in references {
        let Some(reference) = reference else {
            inputs.push(None);
            continue;
        };
        let mut payload = content.load(reference)?;
        let Some(material) = payload
            .get("metadata")
            .and_then(|m| m.get("arrangementEvents"))
        else {
            inputs.push(None);
            continue;
        };
        let material: EventMaterial = serde_json::from_value(material.clone())?;
        let mut stored: ConversationItem<crate::output::StoredMedia> =
            serde_json::from_value(payload["content"].take())?;
        if !matches!(stored.provenance, Provenance::EnvironmentFact { .. }) {
            inputs.push(None);
            continue;
        }
        let Content::Output { output } = &mut stored.content else {
            return Err(RuntimeError::Invalid(
                "event input requires original output".into(),
            ));
        };
        if material.prefix_parts > output.parts.len() {
            return Err(RuntimeError::Invalid(
                "event input prefix is invalid".into(),
            ));
        }
        // Resolve only the retained evidence below, not every superseded/duplicate image.
        output.parts.truncate(material.prefix_parts);
        let item = stored.map_media(|media| content.resolve_media(media))?;
        inputs.push(Some(Input { item, material }));
    }
    let mut result: Vec<Option<Projection>> = (0..references.len()).map(|_| None).collect();
    let mut start = 0;
    while start < inputs.len() {
        if inputs[start].is_none() {
            start += 1;
            continue;
        }
        let end = (start..inputs.len())
            .find(|&i| inputs[i].is_none())
            .unwrap_or(inputs.len());
        project_group(
            content,
            &mut inputs[start..end],
            &references[start..end],
            &mut result[start..end],
        )?;
        start = end;
    }
    Ok(result)
}

fn event_id(metadata: &Value) -> Result<&str> {
    metadata["id"]
        .as_str()
        .ok_or_else(|| RuntimeError::Invalid("event input has no original event identity".into()))
}
fn state_key(input: &Input, metadata: &Value) -> Result<Option<String>> {
    let Some(state) = metadata.get("state").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let Content::Output { output } = &input.item.content else {
        return Err(RuntimeError::Invalid(
            "event input requires original output".into(),
        ));
    };
    // Filtered arrangements have distinct intentions and may see different state cuts.
    // A later event selected by another arrangement cannot erase this one's evidence.
    Ok(Some(encode(&(
        input.material.arrangement_id.as_deref().or_else(|| output.data["followupId"].as_str()),
        &input.material.instruction_ref,
        input.material.trigger.as_ref().or_else(|| output.data.get("trigger")),
        &metadata["source"],
        &metadata["objectId"],
        &metadata["senderId"],
        &state["key"],
    ))?))
}
/// One source description beside its own ordered content. Operational event/object/sender
/// keys remain usable; transport identity, routing, de-duplication and revision stay in metadata.
pub(super) fn append_event(parts: &mut Vec<OutputPart>, metadata: &Value, body: crate::output::OutputBody, number: usize) -> (Value, Value) {
    let source = &metadata["source"];
    let mut fact = json!({"event":number});
    let mut origin = serde_json::Map::new();
    for key in ["extensionId", "sourceId", "accountId"] {
        if let Some(value) = source.get(key).filter(|v| !v.is_null()) { origin.insert(key.into(), value.clone()); }
    }
    if !origin.is_empty() { fact["source"] = Value::Object(origin); }
    for key in ["eventId", "objectId", "senderId", "occurredAtMs", "attributes"] {
        if let Some(value) = metadata.get(key).filter(|v| !v.is_null()) { fact[key] = value.clone(); }
    }
    if let Some(value) = metadata.get("state").and_then(|state| state.get("value")) { fact["state"] = value.clone(); }
    let (data, model_data) = crate::model_input::append_output(parts, body, format!("External event {number}:"));
    let mut model_fact = fact.clone();
    if !data.is_null() { fact["data"] = data; }
    if !model_data.is_null() { model_fact["data"] = model_data; }
    (fact, model_fact)
}

fn project_group(
    content: &ContentStore,
    inputs: &mut [Option<Input>],
    references: &[Option<Value>],
    result: &mut [Option<Projection>],
) -> Result<()> {
    let mut states: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    for input in inputs.iter().flatten() {
        for (metadata, _) in &input.material.events {
            if let Some(key) = state_key(input, metadata)? {
                states
                    .entry(key)
                    .or_default()
                    .insert(event_id(metadata)?.into(), metadata.clone());
            }
        }
    }
    let mut superseded = BTreeMap::new();
    let mut changes = BTreeMap::new();
    for (key, events) in states {
        let mut ordered: Vec<_> = events.values().collect();
        ordered.sort_by_key(|e| e["state"]["sequence"].as_u64());
        let sequences: BTreeSet<_> = ordered
            .iter()
            .filter_map(|e| e["state"]["sequence"].as_u64())
            .collect();
        // Equal or missing source sequences give no valid ordering. Retain the bodies.
        if sequences.len() != ordered.len() || ordered.len() < 2 {
            continue;
        }
        let latest = event_id(ordered.last().unwrap())?.to_owned();
        let mut transitions = Vec::new();
        let mut previous = None;
        for event in ordered {
            if previous != Some(&event["state"]["value"]) {
                transitions.push(
                    json!({"value":event["state"]["value"],"occurredAtMs":event["occurredAtMs"]}),
                );
                previous = Some(&event["state"]["value"]);
            }
            if event_id(event)? != latest {
                superseded.insert((key.clone(), event_id(event)?.to_owned()), latest.clone());
            }
        }
        changes.insert((key, latest), transitions);
    }
    let mut owners = BTreeMap::new();
    for (index, input) in inputs.iter().enumerate() {
        for (metadata, _) in &input.as_ref().unwrap().material.events {
            owners
                .entry(event_id(metadata)?.to_owned())
                .or_insert(index);
        }
    }
    // Local display numbers never become durable identity or authority.
    let mut numbers = BTreeMap::new();
    for input in inputs.iter().flatten() {
        for (metadata, _) in &input.material.events {
            let next = numbers.len() + 1;
            numbers.entry(event_id(metadata)?.to_owned()).or_insert(next);
        }
    }
    let mut shown = BTreeSet::new();
    for (index, entry) in inputs.iter_mut().enumerate() {
        let input = entry.take().unwrap();
        let mut dependency_indices = BTreeSet::from([index]);
        let mut item = input.item.clone();
        let Content::Output { output } = &mut item.content else {
            return Err(RuntimeError::Invalid(
                "event input requires original output".into(),
            ));
        };
        let mut facts = Vec::new();
        let mut model_facts = Vec::new();
        for (metadata, reference) in &input.material.events {
            let id = event_id(metadata)?;
            let state_key = state_key(&input, metadata)?.map(|key| (key, id.to_owned()));
            if let Some(latest) = state_key.as_ref().and_then(|key| superseded.get(key)) {
                dependency_indices.insert(owners[latest]);
                let fact = json!({"event":numbers[id],"supersededByEvent":numbers[latest]});
                model_facts.push(fact.clone());
                facts.push(fact);
                continue;
            }
            let (mut fact, mut model_fact) = if shown.contains(id) {
                dependency_indices.insert(owners[id]);
                let fact = json!({"sharedEvent":numbers[id]});
                (fact.clone(), fact)
            } else {
                let body = content.load_output(reference)?;
                shown.insert(id.to_owned());
                append_event(&mut output.parts, metadata, body, numbers[id])
            };
            if let Some(transitions) = state_key.as_ref().and_then(|key| changes.get(key)) {
                fact["stateChanges"] = json!(transitions);
                model_fact["stateChanges"] = json!(transitions);
            }
            facts.push(fact);
            model_facts.push(model_fact);
        }
        let mut model_data = output.model_data().clone();
        output.data["events"] = json!(facts);
        model_data["events"] = json!(model_facts);
        output.model_data = (model_data != output.data).then_some(model_data);
        let dependencies = dependency_indices
            .into_iter()
            .filter_map(|index| {
                references[index]
                    .as_ref()
                    .and_then(|r| r["content_object"].as_str())
                    .map(str::to_owned)
            })
            .collect();
        result[index] = Some(Projection { item, dependencies });
    }
    Ok(())
}
