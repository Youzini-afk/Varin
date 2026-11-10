//! Small shared presentation primitives. Domain owners select business fields; this
//! module never guesses whether an arbitrary JSON key or user text is internal.
use crate::output::{OutputBody, OutputPart};
use serde_json::Value;

/// Place a result's parts exactly once while returning only its business data.
/// The original output remains in ContentStore for recovery, reads and resource lifetime.
pub(crate) fn append_output(
    parts: &mut Vec<OutputPart>,
    output: OutputBody,
    label: String,
) -> (Value, Value) {
    let model_data = output.model_data().clone();
    if !output.parts.is_empty() {
        parts.push(OutputPart::Text { text: label });
        parts.extend(output.parts);
    }
    (output.data, model_data)
}

/// A terminal result supersedes an identical acceptance from the same original Job.
/// Keep differences (including an empty object or false) and do not deduplicate independent observations by pixels/text.
/// Identical media must also have the same typed original source to be reused. This is not a general output cleaner.
pub(crate) fn acceptance_details(mut acceptance: OutputBody, terminal: &OutputBody) -> OutputBody {
    fn differences(earlier: &mut Value, later: &Value) {
        if earlier == later {
            *earlier = Value::Null;
        } else if let (Some(fields), Some(final_fields)) =
            (earlier.as_object_mut(), later.as_object())
        {
            fields.retain(|key, value| final_fields.get(key) != Some(value));
            if fields.is_empty() {
                *earlier = Value::Null;
            }
        }
    }
    let mut model_data = acceptance.model_data().clone();
    differences(&mut model_data, terminal.model_data());
    differences(&mut acceptance.data, &terminal.data);
    acceptance.model_data = (model_data != acceptance.data).then_some(model_data);
    acceptance
        .parts
        .retain(|part| !terminal.parts.contains(part));
    acceptance
}
