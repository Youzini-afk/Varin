//! Model metadata selects an offline encoding or an immutable Host-prepared tokenizer file.
use crate::execution::{Content, ConversationItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
};
use tiktoken_rs::tokenizer::Tokenizer as OpenAiTokenizer;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
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
    fn openai(self) -> OpenAiTokenizer {
        match self {
            Self::O200kBase => OpenAiTokenizer::O200kBase,
            Self::O200kHarmony => OpenAiTokenizer::O200kHarmony,
            Self::Cl100kBase => OpenAiTokenizer::Cl100kBase,
            Self::P50kBase => OpenAiTokenizer::P50kBase,
            Self::P50kEdit => OpenAiTokenizer::P50kEdit,
            Self::R50kBase => OpenAiTokenizer::R50kBase,
        }
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
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
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
type Loaded = Arc<OnceLock<Result<tokenizers::Tokenizer, String>>>;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TokenCounter {
    pub name: TokenizerBinding,
    pub matched: bool,
    #[serde(skip)]
    loaded: OnceLock<Loaded>,
}
impl TokenCounter {
    pub fn for_model(model: &str) -> Self {
        Self::for_binding(model, None)
    }
    pub fn for_binding(model: &str, binding: Option<&TokenizerBinding>) -> Self {
        if let Some(binding) = binding {
            return Self {
                name: binding.clone(),
                matched: true,
                loaded: OnceLock::new(),
            };
        }
        let model = model
            .rsplit('/')
            .next()
            .unwrap_or(model)
            .to_ascii_lowercase();
        let encoding = tiktoken_rs::tokenizer::get_tokenizer(&model).map(Encoding::from_openai);
        Self {
            name: TokenizerBinding::Encoding {
                name: encoding.unwrap_or_default(),
            },
            matched: encoding.is_some(),
            loaded: OnceLock::new(),
        }
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
        // The Host gives identical content one immutable path. Load/hash/parse once, outside Catalog locks.
        static FILES: OnceLock<Mutex<BTreeMap<(String, String), Loaded>>> = OnceLock::new();
        let cell = self.loaded.get_or_init(|| {
            FILES
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .entry((path.clone(), sha256.clone()))
                .or_default()
                .clone()
        });
        cell.get_or_init(|| {
            let bytes =
                std::fs::read(path).map_err(|_| "tokenizer file unavailable".to_string())?;
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
    fn openai(&self) -> &'static tiktoken_rs::CoreBPE {
        tiktoken_rs::bpe_for_tokenizer(self.encoding().openai()).expect("bundled tiktoken encoding")
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
        let bad = TokenCounter::for_binding(
            "unlisted",
            Some(&TokenizerBinding::File {
                path: root.join("missing.json").to_string_lossy().into(),
                sha256: "missing".into(),
            }),
        );
        assert_eq!(bad.count("你好，世界！"), 4);
        assert!(bad.description().contains("reference tokenizer"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
