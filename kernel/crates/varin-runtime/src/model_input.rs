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
    if !acceptance.parts.is_empty()
        && terminal.parts.windows(acceptance.parts.len()).any(|parts| parts == acceptance.parts)
    {
        acceptance.parts.clear();
    }
    acceptance
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{OutputSource, ResolvedMedia};
    use serde_json::json;

    #[test]
    fn matching_caption_stays_with_each_distinct_image() {
        let parts = |identity: &str| vec![OutputPart::Text { text: "Red series = baseline".into() },
            OutputPart::Media { media: ResolvedMedia { media_type: "image/png".into(), data_base64: "same-pixels".into(),
                source: OutputSource::Operation { operation_id: identity.into() } } }];
        let accepted = OutputBody { data: json!({"accepted":true}), model_data: None, parts: parts("before") };
        let terminal = OutputBody { data: json!({"result":"changed"}), model_data: None, parts: parts("after") };
        let retained = acceptance_details(accepted.clone(), &terminal);
        assert_eq!(retained.parts, accepted.parts);
        assert!(acceptance_details(terminal.clone(), &terminal).parts.is_empty());
    }
}
