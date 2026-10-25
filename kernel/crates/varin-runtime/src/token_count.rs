//! Model metadata selects an offline encoding or an immutable Host-prepared tokenizer file.
use crate::execution::{Content, ConversationItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tiktoken_rs::tokenizer::Tokenizer as OpenAiTokenizer;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Encoding {
    #[default]
    O200kBase,
    O200kHarmony,
    Cl100kBase,
    P50kBase,
    P50kEdit,
    R50kBase,
}
impl Encoding {
    fn from_openai(value: OpenAiTokenizer) -> Self {
        match value {
            OpenAiTokenizer::O200kBase => Self::O200kBase,
            OpenAiTokenizer::O200kHarmony => Self::O200kHarmony,
            OpenAiTokenizer::Cl100kBase => Self::Cl100kBase,
            OpenAiTokenizer::P50kBase => Self::P50kBase,
            OpenAiTokenizer::P50kEdit => Self::P50kEdit,
            OpenAiTokenizer::R50kBase | OpenAiTokenizer::Gpt2 => Self::R50kBase,
        }
    }
    fn load(self) -> tiktoken_rs::CoreBPE {
        match self {
            Self::O200kBase => tiktoken_rs::o200k_base(),
            Self::O200kHarmony => tiktoken_rs::o200k_harmony(),
            Self::Cl100kBase => tiktoken_rs::cl100k_base(),
            Self::P50kBase => tiktoken_rs::p50k_base(),
            Self::P50kEdit => tiktoken_rs::p50k_edit(),
            Self::R50kBase => tiktoken_rs::r50k_base(),
        }
        .expect("bundled tiktoken encoding")
    }
    fn label(self) -> &'static str {
        match self {
            Self::O200kBase => "o200k_base",
            Self::O200kHarmony => "o200k_harmony",
            Self::Cl100kBase => "cl100k_base",
            Self::P50kBase => "p50k_base",
            Self::P50kEdit => "p50k_edit",
            Self::R50kBase => "r50k_base",
        }
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TokenizerBinding {
    Encoding { name: Encoding },
    File { path: String, sha256: String },
}
impl Default for TokenizerBinding {
    fn default() -> Self {
        Self::Encoding {
            name: Encoding::default(),
        }
    }
}

/// Match a known encoding through channel/deployment decorations. Keep the model ID sent to
/// the provider untouched. Prefix rules remain owned by tiktoken, rather than a second model table.
fn model_encoding(model: &str) -> Option<Encoding> {
    let normalized = model.trim().to_ascii_lowercase();
    // Fine-tune IDs explicitly name their base before the next colon. Organization/job labels
    // after that base must not participate in tokenizer selection.
    for (index, _) in normalized.match_indices("ft:") {
        if index == 0 || !normalized[..index].chars().next_back()?.is_ascii_alphanumeric() {
            let base = normalized[index + 3..].split(':').next()?.trim();
            return tiktoken_rs::tokenizer::get_tokenizer(base).map(Encoding::from_openai);
        }
    }
    fn candidate(value: &str) -> Option<Encoding> {
        if let Some(encoding) = tiktoken_rs::tokenizer::get_tokenizer(value) {
            return Some(Encoding::from_openai(encoding));
        }
        // A dated/versioned model family is tried whole first. A numeric dot is part of a
        // version (gpt-4.2), not a removable label that would incorrectly turn it into gpt-4.
        for (index, separator) in value.char_indices().rev() {
            if separator == '-' || separator == '_'
                || separator == '.' && value[index + 1..].starts_with(|ch: char| ch.is_ascii_alphabetic())
            {
                if let Some(encoding) = tiktoken_rs::tokenizer::get_tokenizer(&value[..index]) {
                    return Some(Encoding::from_openai(encoding));
                }
            }
        }
        None
    }
    let mut found = None;
    for segment in normalized.split(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '-' | '_' | '.')) {
        let mut encoding = candidate(segment);
        if encoding.is_none() {
            // Only start at a real separator; `mygpt-4o` is not a spelling of `gpt-4o`.
            for (index, ch) in segment.char_indices() {
                if matches!(ch, '-' | '_') {
                    encoding = candidate(&segment[index + 1..]);
                    if encoding.is_some() { break; }
                }
            }
        }
        if let Some(encoding) = encoding {
            // Routing expressions naming incompatible families have no single known vocabulary.
            if found.is_some_and(|previous| previous != encoding) { return None; }
            found = Some(encoding);
        }
    }
    found
}
#[derive(Default)]
struct Loaded {
    file: OnceLock<Result<tokenizers::Tokenizer, String>>,
    bpe: OnceLock<tiktoken_rs::CoreBPE>,
    reference: OnceLock<Arc<Loaded>>,
}
impl std::fmt::Debug for Loaded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Loaded").finish_non_exhaustive()
    }
}
fn shared(binding: &TokenizerBinding) -> Arc<Loaded> {
    static ENCODERS: OnceLock<Mutex<BTreeMap<TokenizerBinding, Weak<Loaded>>>> = OnceLock::new();
    let mut encoders = ENCODERS.get_or_init(Default::default).lock().unwrap();
    if let Some(loaded) = encoders.get(binding).and_then(Weak::upgrade) {
        return loaded;
    }
    encoders.retain(|_, cell| cell.strong_count() > 0);
    let loaded = Arc::new(Loaded::default());
    encoders.insert(binding.clone(), Arc::downgrade(&loaded));
    loaded
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(from = "CounterDescriptor")]
pub struct TokenCounter {
    pub name: TokenizerBinding,
    pub matched: bool,
    #[serde(skip)]
    loaded: Arc<Loaded>,
}
#[derive(Deserialize)]
struct CounterDescriptor {
    name: TokenizerBinding,
    matched: bool,
}
impl From<CounterDescriptor> for TokenCounter {
    fn from(value: CounterDescriptor) -> Self {
        Self::new(value.name, value.matched)
    }
}
impl Default for TokenCounter {
    fn default() -> Self {
        Self::new(TokenizerBinding::default(), false)
    }
}
impl TokenCounter {
    fn new(name: TokenizerBinding, matched: bool) -> Self {
        let loaded = shared(&name);
        Self {
            name,
            matched,
            loaded,
        }
    }
    pub fn for_model(model: &str) -> Self {
        Self::for_binding(model, None)
    }
    pub fn for_binding(model: &str, binding: Option<&TokenizerBinding>) -> Self {
        if let Some(binding) = binding {
            return Self::new(binding.clone(), true);
        }
        let encoding = model_encoding(model);
        Self::new(
            TokenizerBinding::Encoding {
                name: encoding.unwrap_or_default(),
            },
            encoding.is_some(),
        )
    }
    pub fn for_configuration(configuration: &Value) -> Self {
        let binding = configuration
            .get("tokenizer")
            .and_then(|value| serde_json::from_value(value.clone()).ok());
        Self::for_binding(
            configuration["model"].as_str().unwrap_or_default(),
            binding.as_ref(),
        )
    }
    fn file(&self) -> Option<&tokenizers::Tokenizer> {
        let TokenizerBinding::File { path, sha256 } = &self.name else {
            return None;
        };
        // Shared by live counters; the last Run/compiler drops the parsed vocabulary.
        // Loading stays lazy so metadata capture never performs file IO under Catalog.
        self.loaded
            .file
            .get_or_init(|| {
                let mut bytes = std::fs::read(path)
                    .or_else(|error| {
                        // Cache compression changes representation, not a captured binding's identity.
                        if error.kind() == std::io::ErrorKind::NotFound && path.ends_with(".json") {
                            std::fs::read(format!("{path}.gz"))
                        } else {
                            Err(error)
                        }
                    })
                    .map_err(|_| "tokenizer file unavailable".to_string())?;
                if bytes.starts_with(&[0x1f, 0x8b]) {
                    let mut decoded = Vec::new();
                    flate2::read::GzDecoder::new(bytes.as_slice())
                        .read_to_end(&mut decoded)
                        .map_err(|_| "tokenizer cache decompression failed".to_string())?;
                    bytes = decoded;
                }
                if hex::encode(Sha256::digest(&bytes)) != *sha256 {
                    return Err("tokenizer file content changed".into());
                }
                let mut tokenizer = tokenizers::Tokenizer::from_bytes(bytes)
                    .map_err(|_| "unsupported tokenizer file".to_string())?;
                tokenizer
                    .with_truncation(None)
                    .map_err(|_| "tokenizer configuration invalid".to_string())?;
                tokenizer.with_padding(None);
                Ok(tokenizer)
            })
            .as_ref()
            .ok()
    }
    fn encoding(&self) -> Encoding {
        match &self.name {
            TokenizerBinding::Encoding { name } => *name,
            _ => Encoding::default(),
        }
    }
    pub(crate) fn identity(&self) -> &str {
        match &self.name {
            TokenizerBinding::File { sha256, .. } if self.file().is_some() => sha256,
            _ => self.encoding().label(),
        }
    }
    pub fn description(&self) -> String {
        match &self.name {
            TokenizerBinding::File { .. } if self.file().is_some() => {
                "configured tokenizer.json".into()
            }
            TokenizerBinding::File { .. } => {
                "o200k_base (reference tokenizer; configured file unavailable)".into()
            }
            _ => format!(
                "{}{}",
                self.encoding().label(),
                if self.matched {
                    ""
                } else {
                    " (reference tokenizer)"
                }
            ),
        }
    }
    fn openai(&self) -> &tiktoken_rs::CoreBPE {
        let loaded = if matches!(self.name, TokenizerBinding::File { .. }) {
            self.loaded
                .reference
                .get_or_init(|| shared(&TokenizerBinding::default()))
        } else {
            &self.loaded
        };
        loaded.bpe.get_or_init(|| self.encoding().load())
    }
    pub fn count(&self, text: &str) -> u64 {
        match self
            .file()
            .and_then(|tokenizer| tokenizer.encode(text, false).ok())
        {
            Some(encoded) => encoded.len() as u64,
            None => self.openai().count_ordinary(text) as u64,
        }
    }
    pub(crate) fn prefix_bytes(&self, text: &str, tokens: u64) -> usize {
        if tokens == 0 {
            return 0;
        }
        let tokens = usize::try_from(tokens).unwrap_or(usize::MAX);
        let mut end = match self
            .file()
            .and_then(|tokenizer| tokenizer.encode(text, false).ok())
        {
            Some(encoded) => {
                if encoded.len() <= tokens {
                    return text.len();
                }
                encoded
                    .get_offsets()
                    .get(tokens - 1)
                    .map_or(0, |(_, end)| *end)
            }
            None => {
                let encoded = self.openai().encode_ordinary(text);
                if encoded.len() <= tokens {
                    return text.len();
                }
                self.openai()
                    .decode_bytes(&encoded[..tokens])
                    .expect("original token IDs")
                    .len()
            }
        }
        .min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        end
    }

    pub(crate) fn item(&self, item: &ConversationItem) -> u64 {
        match &item.content {
            Content::Text { text } | Content::ReasoningSummary { text } => self.count(text),
            Content::Media { .. } | Content::ProviderOnly => 0,
            _ if item.content.media().is_empty() => {
                self.count(&serde_json::to_string(&item.content).expect("semantic content"))
            }
            _ => {
                let item = item
                    .clone()
                    .map_media(|media| {
                        Ok::<_, std::convert::Infallible>(crate::output::ResolvedMedia {
                            data_base64: String::new(),
                            ..media
                        })
                    })
                    .unwrap();
                // Arbitrary JSON inside tool results is text, even when it resembles media.
                // Only the typed media parts above have their transport payload removed.
                self.count(&serde_json::to_string(&item.content).expect("semantic content"))
            }
        }
    }

    pub(crate) fn json(&self, value: &Value) -> u64 {
        // Count text leaves and envelope pieces independently so cached fragments and a
        // recovered request use the same accounting, regardless of serialization layout.
        match value {
            Value::String(text) => {
                if text.starts_with("data:image/") {
                    0
                } else {
                    self.count(text)
                }
            }
            Value::Object(object) if media(object) => 0,
            Value::Object(object) => object.iter().filter(|(key, _)| !opaque(object, key)).fold(
                self.count("{}"),
                |tokens, (key, value)| {
                    tokens
                        .saturating_add(self.field(key))
                        .saturating_add(self.json(value))
                },
            ),
            Value::Array(values) => values.iter().fold(self.count("[]"), |tokens, value| {
                tokens
                    .saturating_add(self.json(value))
                    .saturating_add(self.count(","))
            }),
            _ => self.count(&value.to_string()),
        }
    }

    pub(crate) fn field(&self, key: &str) -> u64 {
        self.count(&format!(
            "{}:",
            serde_json::to_string(key).expect("JSON key")
        ))
    }
}

pub(crate) fn media(object: &serde_json::Map<String, Value>) -> bool {
    matches!(
        object.get("type").and_then(Value::as_str),
        Some("input_image" | "image_url" | "image" | "input_file")
    ) || object.contains_key("inlineData")
        || object.contains_key("inline_data")
        || object.contains_key("image") && object.len() == 1
}
pub(crate) fn opaque(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    matches!(
        object.get("type").and_then(Value::as_str),
        Some("reasoning" | "thinking")
    ) && matches!(key, "encrypted_content" | "signature")
        || object.contains_key("text") && key == "thoughtSignature"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decorated_model_ids_preserve_known_tokenizer_families() {
        for (model, expected) in [
            ("  Channel-A/GPT-4O:FREE  ", Encoding::O200kBase),
            ("[高速]relay_gpt-4.1-mini/high", Encoding::O200kBase),
            ("gateway/vendor/gpt-4o.high", Encoding::O200kBase),
            ("供应商-gpt-4-turbo_2024-04", Encoding::Cl100kBase),
            ("deployment-text-embedding-3-small-v2", Encoding::Cl100kBase),
            ("gpt-oss-120b:turbo", Encoding::O200kHarmony),
            ("vendor/FT:GPT-4O-2024-08-06:org:custom", Encoding::O200kBase),
            ("openai/gpt-3.5-turbo@custom", Encoding::Cl100kBase),
            ("gpt-4o/openai", Encoding::O200kBase),
        ] {
            let counter = TokenCounter::for_model(model);
            assert!(counter.matched, "{model}");
            assert_eq!(counter.name, TokenizerBinding::Encoding { name: expected }, "{model}");
        }
    }

    #[test]
    fn unknown_and_ambiguous_names_remain_reference_counts_and_explicit_bindings_win() {
        for model in ["mygpt-4o", "gpt-4.2", "claude-sonnet", "deepseek-chat", "gpt-4 + gpt-4o", "gpt-oss-120b / gpt-4o", "ft:unknown:gpt-4o"] {
            let counter = TokenCounter::for_model(model);
            assert!(!counter.matched, "{model}");
            assert!(counter.description().contains("reference tokenizer"), "{model}");
        }
        let binding = TokenizerBinding::Encoding { name: Encoding::Cl100kBase };
        let counter = TokenCounter::for_binding("route/GPT-4O:free", Some(&binding));
        assert!(counter.matched);
        assert_eq!(counter.name, binding);
    }

    #[test]
    fn generic_files_share_counts_and_retain_unicode_without_model_names() {
        let modern = TokenCounter::for_model("openai/gpt-4o");
        assert_eq!(modern.count("你好，世界！"), 4);
        assert_eq!(TokenCounter::for_model("gpt-4").count("你好，世界！"), 7);
        assert!(!TokenCounter::for_model("any-private-model").matched);
        let root = std::env::temp_dir().join(format!("varin-tokenizer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let tokenizer = tokenizers::Tokenizer::new(
            tokenizers::models::wordlevel::WordLevel::builder()
                .vocab(
                    [("[UNK]".into(), 0), ("中文 🎉".into(), 1)]
                        .into_iter()
                        .collect(),
                )
                .unk_token("[UNK]".into())
                .build()
                .unwrap(),
        );
        let bytes = tokenizer.to_string(false).unwrap().into_bytes();
        let path = root.join("tokenizer.json");
        std::fs::write(&path, &bytes).unwrap();
        let binding = TokenizerBinding::File {
            path: path.to_string_lossy().into(),
            sha256: hex::encode(Sha256::digest(&bytes)),
        };
        let a = TokenCounter::for_binding("unlisted-model-a", Some(&binding));
        let b = TokenCounter::for_binding("unlisted-model-b", Some(&binding));
        assert_eq!(a.count("中文 🎉"), 1);
        assert_eq!(b.count("中文 🎉"), 1);
        assert!(std::ptr::eq(a.file().unwrap(), b.file().unwrap()));
        assert_eq!(a.prefix_bytes("中文 🎉", 1), "中文 🎉".len());
        assert_eq!(a.prefix_bytes("中文 🎉", 0), 0);
        let recovered: TokenCounter =
            serde_json::from_value(serde_json::to_value(&a).unwrap()).unwrap();
        assert_eq!(recovered.count("中文 🎉"), 1);
        assert!(Arc::ptr_eq(&a.loaded, &recovered.loaded));
        let weak = Arc::downgrade(&a.loaded);
        drop(a);
        drop(b);
        drop(recovered);
        assert!(weak.upgrade().is_none());
        // Reopen a captured raw path after the Host has compressed its cache entry.
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gzip, &bytes).unwrap();
        std::fs::write(format!("{}.gz", path.display()), gzip.finish().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            TokenCounter::for_binding("custom", Some(&binding)).count("中文 🎉"),
            1
        );
        let bad = TokenCounter::for_binding(
            "unlisted",
            Some(&TokenizerBinding::File {
                path: root.join("missing.json").to_string_lossy().into(),
                sha256: "missing".into(),
            }),
        );
        assert_eq!(bad.count("你好，世界！"), 4);
        assert!(bad.description().contains("reference tokenizer"));
        assert!(std::ptr::eq(bad.openai(), modern.openai()));
        let weak = Arc::downgrade(&bad.loaded);
        drop(bad);
        assert!(weak.upgrade().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
