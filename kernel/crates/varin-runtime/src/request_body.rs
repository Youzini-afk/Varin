//! Provider JSON with immutable, already encoded fragments. Only the final wire buffer is
//! contiguous: freezing copies fragment bytes, without reconstructing or escaping their payloads.
use bytes::Bytes;
use crate::token_count::{TokenCounter, TokenizerName};
use serde::{ser::SerializeMap, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{
    value::{to_raw_value, RawValue},
    Value,
};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{Arc, OnceLock},
};

#[derive(Debug)]
pub(crate) struct FrozenJson {
    raw: Box<RawValue>,
    tokens: OnceLock<(TokenizerName, u64)>,
}
impl FrozenJson {
    pub(crate) fn new(value: Value) -> Arc<Self> {
        Arc::new(Self {
            tokens: OnceLock::new(),
            raw: to_raw_value(&value).expect("JSON value serializes"),
        })
    }
    fn tokens(&self, counter: TokenCounter) -> u64 {
        let count = || counter.json(&serde_json::from_str(self.raw.get()).expect("validated JSON"));
        let (name, tokens) = self.tokens.get_or_init(|| (counter.name, count()));
        if *name == counter.name { *tokens } else { count() }
    }
}
impl Serialize for FrozenJson {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.raw.serialize(serializer)
    }
}

#[derive(Debug, Clone)]
enum Field {
    Json(Arc<FrozenJson>),
    Array(Vec<Arc<FrozenJson>>),
    Object(Box<RequestBody>),
}
impl Field {
    fn new(value: Value) -> Self {
        match value {
            Value::Array(items) => Self::Array(items.into_iter().map(FrozenJson::new).collect()),
            value => Self::Json(FrozenJson::new(value)),
        }
    }
    fn tokens(&self, counter: TokenCounter) -> u64 {
        match self {
            Self::Json(value) => value.tokens(counter),
            Self::Array(items) => items.iter().fold(counter.count("[]"), |size, value| {
                size.saturating_add(value.tokens(counter)).saturating_add(counter.count(","))
            }),
            Self::Object(body) => body.estimated_tokens(counter),
        }
    }
    fn value(&self) -> Value {
        match self {
            Self::Json(value) => serde_json::from_str(value.raw.get()).expect("validated JSON"),
            Self::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|value| serde_json::from_str(value.raw.get()).expect("validated JSON"))
                    .collect(),
            ),
            Self::Object(body) => body.to_value(),
        }
    }
    fn exact(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Json(a), Self::Json(b)) => Arc::ptr_eq(a, b) || a.raw.get() == b.raw.get(),
            (Self::Array(a), Self::Array(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .zip(b)
                        .all(|(a, b)| Arc::ptr_eq(a, b) || a.raw.get() == b.raw.get())
            }
            (Self::Object(a), Self::Object(b)) => a.wire_bytes() == b.wire_bytes(),
            _ => to_raw_value(self).expect("request field").get()
                == to_raw_value(other).expect("request field").get(),
        }
    }
}
impl Serialize for Field {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Json(value) => value.serialize(serializer),
            Self::Array(items) => items.serialize(serializer),
            Self::Object(body) => body.root.serialize(serializer),
        }
    }
}

#[derive(Debug, Clone)]
enum Root {
    Object(BTreeMap<String, Field>),
    Json(Arc<FrozenJson>),
}
impl Serialize for Root {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Object(fields) => {
                let mut map = serializer.serialize_map(Some(fields.len()))?;
                for (key, value) in fields {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
            Self::Json(value) => value.serialize(serializer),
        }
    }
}
#[derive(Debug, Clone)]
struct Encoded {
    raw: Arc<Box<RawValue>>,
    bytes: Bytes,
}
struct WireOwner(Arc<Box<RawValue>>);
impl AsRef<[u8]> for WireOwner {
    fn as_ref(&self) -> &[u8] {
        self.0.get().as_bytes()
    }
}
impl Encoded {
    fn new(raw: Box<RawValue>) -> Self {
        // Keep the boxed string allocation: converting Box<RawValue> to Arc<RawValue>
        // would copy the entire payload into a new unsized Arc allocation.
        let raw = Arc::new(raw);
        let bytes = Bytes::from_owner(WireOwner(raw.clone()));
        Self { raw, bytes }
    }
}

/// The sole prepared provider body. Clones share fragment payloads and, once frozen, exact wire
/// bytes. Editing an envelope field invalidates only that clone's final encoding. Raw fragments
/// never retain a second parsed Value. Introspection via `to_value` is explicit and allocates.
#[derive(Debug, Clone)]
pub struct RequestBody {
    root: Root,
    encoded: OnceLock<Encoded>,
}
impl From<Value> for RequestBody {
    fn from(value: Value) -> Self {
        Self {
            root: match value {
                Value::Object(fields) => Root::Object(
                    fields
                        .into_iter()
                        .map(|(key, value)| (key, Field::new(value)))
                        .collect(),
                ),
                value => Root::Json(FrozenJson::new(value)),
            },
            encoded: OnceLock::new(),
        }
    }
}
impl RequestBody {
    fn encoded(&self) -> &Encoded {
        self.encoded.get_or_init(|| {
            Encoded::new(to_raw_value(&self.root).expect("request fragments serialize"))
        })
    }
    /// Freeze once after all adapter/configuration edits. Transport and request-bound signing
    /// share this allocation; durable JSON embeds this very same raw JSON, including on recovery.
    pub fn wire_bytes(&self) -> Bytes {
        self.encoded().bytes.clone()
    }
    pub fn to_value(&self) -> Value {
        serde_json::from_str(self.encoded().raw.get()).expect("validated request JSON")
    }
    /// Read a single envelope field. Do not use this to inspect large transcripts on the hot path.
    pub fn get(&self, key: &str) -> Option<Value> {
        match &self.root {
            Root::Object(fields) => fields.get(key).map(Field::value),
            _ => None,
        }
    }
    pub(crate) fn insert(&mut self, key: &str, value: Value) {
        let Root::Object(fields) = &mut self.root else {
            panic!("provider envelope must be an object")
        };
        fields.insert(key.into(), Field::new(value));
        self.encoded.take();
    }
    pub(crate) fn remove(&mut self, key: &str) {
        if let Root::Object(fields) = &mut self.root {
            fields.remove(key);
            self.encoded.take();
        }
    }
    pub(crate) fn insert_frozen(&mut self, key: &str, value: Arc<FrozenJson>) {
        let Root::Object(fields) = &mut self.root else {
            panic!("provider envelope must be an object")
        };
        fields.insert(key.into(), Field::Json(value));
        self.encoded.take();
    }
    pub(crate) fn insert_fragments(&mut self, key: &str, items: Vec<Arc<FrozenJson>>) {
        let Root::Object(fields) = &mut self.root else {
            panic!("provider envelope must be an object")
        };
        fields.insert(key.into(), Field::Array(items));
        self.encoded.take();
    }
    pub(crate) fn insert_object(&mut self, key: &str, body: RequestBody) {
        let Root::Object(fields) = &mut self.root else {
            panic!("provider envelope must be an object")
        };
        fields.insert(key.into(), Field::Object(Box::new(body)));
        self.encoded.take();
    }
    pub(crate) fn estimated_tokens(&self, counter: TokenCounter) -> u64 {
        let Root::Object(fields) = &self.root else {
            let Root::Json(value) = &self.root else {
                unreachable!()
            };
            return value.tokens(counter);
        };
        let kind = self.get("type");
        let kind = kind.as_ref().and_then(Value::as_str);
        if matches!(
            kind,
            Some("input_image" | "image_url" | "image" | "input_file")
        ) || fields.contains_key("inlineData")
            || fields.contains_key("inline_data")
            || fields.len() == 1 && fields.contains_key("image")
        {
            return 0;
        }
        fields
            .iter()
            .filter(|(key, _)| {
                !(matches!(kind, Some("reasoning" | "thinking"))
                    && matches!(key.as_str(), "encrypted_content" | "signature"))
                    && !(fields.contains_key("text") && key.as_str() == "thoughtSignature")
            })
            .fold(counter.count("{}"), |size, (key, value)| {
                size.saturating_add(counter.field(key))
                    .saturating_add(value.tokens(counter))
            })
    }
    pub(crate) fn transcript_prefix(
        &self,
        next: &Self,
        path: &[&str],
        coalesced: Option<&str>,
    ) -> bool {
        let (Root::Object(left), Root::Object(right), Some((key, rest))) =
            (&self.root, &next.root, path.split_first())
        else {
            return false;
        };
        left.len() == right.len()
            && left.contains_key(*key)
            && left.iter().all(|(field, value)| {
                right.get(field).is_some_and(|next| {
                    if field != key {
                        return value.exact(next);
                    }
                    match (value, next, rest.is_empty()) {
                        (Field::Array(a), Field::Array(b), true) => {
                            let left_len = a.len();
                            a.len() <= b.len()
                                && a.iter().zip(b).enumerate().all(|(index, (a, b))| {
                                    Arc::ptr_eq(a, b)
                                        || a.raw.get() == b.raw.get()
                                        || index + 1 == left_len
                                            && coalesced.is_some_and(|field| {
                                                raw_prefix(&a.raw, &b.raw, &[field], None)
                                            })
                                })
                        }
                        (Field::Json(a), Field::Json(b), _) => {
                            raw_prefix(&a.raw, &b.raw, rest, coalesced)
                        }
                        (Field::Object(a), Field::Object(b), _) => {
                            a.transcript_prefix(b, rest, coalesced)
                        }
                        (Field::Object(_), Field::Json(_), _)
                        | (Field::Json(_), Field::Object(_), _) => raw_prefix(
                            &to_raw_value(value).expect("request field"),
                            &to_raw_value(next).expect("request field"),
                            rest,
                            coalesced,
                        ),
                        _ => false,
                    }
                })
            })
    }
    #[cfg(test)]
    pub(crate) fn shares_field(&self, next: &Self, key: &str) -> bool {
        let (Root::Object(a), Root::Object(b)) = (&self.root, &next.root) else {
            return false;
        };
        matches!((a.get(key),b.get(key)), (Some(Field::Json(a)),Some(Field::Json(b))) if Arc::ptr_eq(a,b))
    }
    #[cfg(test)]
    pub(crate) fn shared_fragments(&self, next: &Self, key: &str) -> usize {
        let (Root::Object(a), Root::Object(b)) = (&self.root, &next.root) else {
            return 0;
        };
        if let Some((outer, inner)) = key.split_once('.') {
            return match (a.get(outer), b.get(outer)) {
                (Some(Field::Object(a)), Some(Field::Object(b))) => a.shared_fragments(b, inner),
                _ => 0,
            };
        }
        let (Some(Field::Array(a)), Some(Field::Array(b))) = (a.get(key), b.get(key)) else {
            return 0;
        };
        a.iter()
            .filter(|item| b.iter().any(|next| Arc::ptr_eq(item, next)))
            .count()
    }
}
// Borrow raw blocks to preserve each actual protocol's exact grouping. This does scan changed
// coalesced/nested blocks, but does not hydrate large strings into a second JSON tree.
fn raw_prefix(
    previous: &RawValue,
    current: &RawValue,
    path: &[&str],
    content: Option<&str>,
) -> bool {
    if let Some((key, rest)) = path.split_first() {
        let (Ok(left), Ok(right)) = (
            serde_json::from_str::<BTreeMap<String, &RawValue>>(previous.get()),
            serde_json::from_str::<BTreeMap<String, &RawValue>>(current.get()),
        ) else {
            return false;
        };
        return left.len() == right.len()
            && left.contains_key(*key)
            && left.iter().all(|(field, value)| {
                right.get(field).is_some_and(|next| {
                    if field == key {
                        raw_prefix(value, next, rest, content)
                    } else {
                        value.get() == next.get()
                    }
                })
            });
    }
    let (Ok(left), Ok(right)) = (
        serde_json::from_str::<Vec<&RawValue>>(previous.get()),
        serde_json::from_str::<Vec<&RawValue>>(current.get()),
    ) else {
        return false;
    };
    left.len() <= right.len()
        && left.iter().zip(right).enumerate().all(|(index, (a, b))| {
            a.get() == b.get()
                || index + 1 == left.len()
                    && content.is_some_and(|field| raw_prefix(a, b, &[field], None))
        })
}
impl Serialize for RequestBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.encoded().raw.serialize(serializer)
    }
}
impl<'de> Deserialize<'de> for RequestBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let value: Value = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
        let body = Self::from(value);
        let _ = body.encoded.set(Encoded::new(raw));
        Ok(body)
    }
}
impl PartialEq for RequestBody {
    fn eq(&self, other: &Self) -> bool {
        self.encoded().raw.get() == other.encoded().raw.get()
    }
}
impl fmt::Display for RequestBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.encoded().raw.get())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frozen_envelope_clones_keep_wire_identity_and_cached_token_counts() {
        let value = json!({"input":[
            {"role":"user","content":"汉字 🧭\n\"\\"},
            {"type":"input_image","image_url":format!("data:image/png;base64,{}","a".repeat(8192))},
            {"type":"reasoning","summary":"visible","encrypted_content":"opaque".repeat(8192)},
            {"type":"thinking","thinking":"text","signature":"opaque".repeat(8192)},
            {"text":"plain","thoughtSignature":"opaque".repeat(8192)}
        ],"model":"before"});
        let body = RequestBody::from(value.clone());
        let counter = TokenCounter::for_model("gpt-4o");
        let tokens = body.estimated_tokens(counter);
        assert!(
            tokens < 128,
            "media and encrypted signatures are not text estimates"
        );
        let Root::Object(fields) = &body.root else { unreachable!() };
        let Field::Array(items) = &fields["input"] else { unreachable!() };
        assert!(items.iter().all(|item| item.tokens.get().is_some()));
        let bytes = body.wire_bytes();
        let mut changed = body.clone();
        assert_eq!(bytes.as_ptr(), changed.wire_bytes().as_ptr());
        changed.insert("model", json!("after"));
        assert_eq!(body.shared_fragments(&changed, "input"), 5);
        assert_ne!(bytes.as_ptr(), changed.wire_bytes().as_ptr());
        assert_eq!(
            body.wire_bytes(),
            bytes,
            "a later configuration edit cannot mutate prepared bytes"
        );
        assert_eq!(body.to_value()["model"], "before");
        let recovered: RequestBody =
            serde_json::from_slice(&serde_json::to_vec(&body).unwrap()).unwrap();
        assert_eq!(recovered.wire_bytes(), bytes);
        assert_eq!(recovered.estimated_tokens(counter), tokens);
        let mut nested = RequestBody::from(json!({}));
        nested.insert_object("request", body.clone());
        let recovered: RequestBody = serde_json::from_slice(&serde_json::to_vec(&nested).unwrap()).unwrap();
        assert_eq!(recovered.estimated_tokens(counter), nested.estimated_tokens(counter));
        let fragment = FrozenJson::new(json!("你好，世界！"));
        assert_eq!(fragment.tokens(counter), 4);
        assert_eq!(fragment.tokens(TokenCounter::for_model("gpt-4")), 7);
        assert_eq!(fragment.tokens.get(), Some(&(counter.name, 4)));
    }
}
