//! The original question defines answer identity and cardinality. User answers
//! are validated here before they can become history or resume an Operation.
use crate::RuntimeError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
type Result<T> = std::result::Result<T, RuntimeError>;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionSet {
    pub questions: Vec<Question>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Question {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub selection: Selection,
    #[serde(default = "required")]
    pub required: bool,
}
fn required() -> bool { true }
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Selection { #[default] Single, Multiple }
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionOption { pub id: String, pub label: String }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
    pub text: String,
    #[serde(default)]
    pub skipped: bool,
}
impl QuestionSet {
    pub fn parse(value: Value) -> Result<Self> {
        let set: Self = serde_json::from_value(value)?;
        if set.questions.is_empty() {
            return Err(RuntimeError::Invalid("questions must contain at least one question".into()));
        }
        let mut ids = BTreeSet::new();
        for q in &set.questions {
            if q.id.trim().is_empty() || q.question.trim().is_empty() || !ids.insert(&q.id) {
                return Err(RuntimeError::Invalid("question ids must be unique and questions nonempty".into()));
            }
            let mut options = BTreeSet::new();
            for option in &q.options {
                if option.id.trim().is_empty() || option.label.trim().is_empty() || !options.insert(&option.id) {
                    return Err(RuntimeError::Invalid(format!("invalid or duplicate option in question {}", q.id)));
                }
            }
        }
        Ok(set)
    }
    /// Canonical order makes an equal retry return the same original receipt.
    pub fn answer(&self, value: Value) -> Result<(Vec<QuestionAnswer>, String)> {
        let submitted: Vec<QuestionAnswer> = serde_json::from_value(value)?;
        let mut answers = BTreeMap::new();
        for answer in submitted {
            if answers.insert(answer.question_id.clone(), answer).is_some() {
                return Err(RuntimeError::Invalid("duplicate question answer".into()));
            }
        }
        if answers.len() != self.questions.len() || answers.keys().any(|id| !self.questions.iter().any(|q| &q.id == id)) {
            return Err(RuntimeError::Invalid("answers must match the original questions".into()));
        }
        let mut ordered = Vec::new();
        let mut text = Vec::new();
        for (index, q) in self.questions.iter().enumerate() {
            let mut answer = answers.remove(&q.id).expect("question identities checked");
            let ids: BTreeSet<_> = answer.selected_option_ids.iter().collect();
            if ids.len() != answer.selected_option_ids.len()
                || ids.iter().any(|id| !q.options.iter().any(|option| &option.id == *id))
                || q.selection == Selection::Single && ids.len() > 1 {
                return Err(RuntimeError::Invalid(format!("invalid selection for question {}", q.id)));
            }
            let empty = ids.is_empty() && answer.text.trim().is_empty();
            if q.required && (empty || answer.skipped) || answer.skipped && !empty {
                return Err(RuntimeError::Invalid(format!("question {} requires an answer", q.id)));
            }
            let choices: Vec<_> = q.options.iter().filter(|option| ids.contains(&option.id)).collect();
            let mut lines: Vec<String> = choices.iter().map(|option| option.label.clone()).collect();
            answer.selected_option_ids = choices.iter().map(|option| option.id.clone()).collect();
            answer.skipped = empty;
            if !answer.text.trim().is_empty() { lines.push(answer.text.clone()); }
            if empty { lines.push("(skipped optional question)".into()); }
            // Original question text stays in its tool call. Only choices the user
            // actually selected and the user's own text become user prose.
            text.push(if self.questions.len() == 1 { lines.join("\n") }
                else { format!("{}. {}", index + 1, lines.join("\n")) });
            ordered.push(answer);
        }
        Ok((ordered, text.join("\n\n")))
    }
}
pub fn schema() -> Value {
    json!({"type":"object","properties":{"questions":{"type":"array","minItems":1,"items":{
        "type":"object","properties":{
            "id":{"type":"string","minLength":1},
            "question":{"type":"string","minLength":1},
            "selection":{"type":"string","enum":["single","multiple"],"default":"single"},
            "required":{"type":"boolean","default":true},
            "options":{"type":"array","items":{"type":"object","properties":{
                "id":{"type":"string","minLength":1},"label":{"type":"string","minLength":1}
            },"required":["id","label"],"additionalProperties":false}}
        },"required":["id","question"],"additionalProperties":false
    }}},"required":["questions"],"additionalProperties":false})
}
