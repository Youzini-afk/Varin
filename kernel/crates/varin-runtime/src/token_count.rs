//! Offline tokenizers shared by context planning and original-material selection.
use crate::execution::{Content, ConversationItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, sync::OnceLock};
use tiktoken_rs::tokenizer::Tokenizer as OpenAiTokenizer;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenizerName {
    #[default]
    O200kBase,
    O200kHarmony,
    Cl100kBase,
    P50kBase,
    P50kEdit,
    R50kBase,
    DeepseekV4,
    DeepseekV41,
    Qwen3,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct TokenCounter {
    pub name: TokenizerName,
    pub matched: bool,
}

impl TokenCounter {
    pub fn for_model(model: &str) -> Self {
        let model = model
            .rsplit('/')
            .next()
            .unwrap_or(model)
            .to_ascii_lowercase();
        let name = if matches!(
            model.as_str(),
            "deepseek-v4.1-flash" | "deepseek-v4.1-flash-1017"
        ) {
            Some(TokenizerName::DeepseekV41)
        } else if matches!(model.as_str(), "deepseek-v4-pro" | "deepseek-v4-flash") {
            Some(TokenizerName::DeepseekV4)
        } else if model == "qwen3-8b" {
            Some(TokenizerName::Qwen3)
        } else {
            tiktoken_rs::tokenizer::get_tokenizer(&model).map(|tokenizer| match tokenizer {
                OpenAiTokenizer::O200kBase => TokenizerName::O200kBase,
                OpenAiTokenizer::O200kHarmony => TokenizerName::O200kHarmony,
                OpenAiTokenizer::Cl100kBase => TokenizerName::Cl100kBase,
                OpenAiTokenizer::P50kBase => TokenizerName::P50kBase,
                OpenAiTokenizer::P50kEdit => TokenizerName::P50kEdit,
                OpenAiTokenizer::R50kBase | OpenAiTokenizer::Gpt2 => TokenizerName::R50kBase,
            })
        };
        Self {
            name: name.unwrap_or_default(),
            matched: name.is_some(),
        }
    }

    pub fn label(self) -> &'static str {
        match self.name {
            TokenizerName::O200kBase => "o200k_base",
            TokenizerName::O200kHarmony => "o200k_harmony",
            TokenizerName::Cl100kBase => "cl100k_base",
            TokenizerName::P50kBase => "p50k_base",
            TokenizerName::P50kEdit => "p50k_edit",
            TokenizerName::R50kBase => "r50k_base",
            TokenizerName::DeepseekV4 => "deepseek-v4",
            TokenizerName::DeepseekV41 => "deepseek-v4.1",
            TokenizerName::Qwen3 => "qwen3",
        }
    }

    pub fn description(self) -> String {
        format!(
            "{}{}",
            self.label(),
            if self.matched {
                ""
            } else {
                " (reference tokenizer)"
            }
        )
    }

    fn huggingface(self) -> Option<&'static tokenizers::Tokenizer> {
        static DEEPSEEK_V4: OnceLock<tokenizers::Tokenizer> = OnceLock::new();
        static DEEPSEEK_V41: OnceLock<tokenizers::Tokenizer> = OnceLock::new();
        static QWEN3: OnceLock<tokenizers::Tokenizer> = OnceLock::new();
        let (cell, bytes): (&OnceLock<_>, &[u8]) = match self.name {
            TokenizerName::DeepseekV4 => (
                &DEEPSEEK_V4,
                include_bytes!("../assets/tokenizers/deepseek-v4.json.gz"),
            ),
            TokenizerName::DeepseekV41 => (
                &DEEPSEEK_V41,
                include_bytes!("../assets/tokenizers/deepseek-v4.1.json.gz"),
            ),
            TokenizerName::Qwen3 => (&QWEN3, include_bytes!("../assets/tokenizers/qwen3.json.gz")),
            _ => return None,
        };
        Some(cell.get_or_init(|| {
            let mut json = Vec::new();
            flate2::read::GzDecoder::new(bytes)
                .read_to_end(&mut json)
                .expect("bundled tokenizer gzip");
            let mut tokenizer =
                tokenizers::Tokenizer::from_bytes(json).expect("bundled tokenizer JSON");
            tokenizer
                .with_truncation(None)
                .expect("untruncated tokenizer");
            tokenizer.with_padding(None);
            tokenizer
        }))
    }

    fn openai(self) -> &'static tiktoken_rs::CoreBPE {
        let tokenizer = match self.name {
            TokenizerName::O200kHarmony => OpenAiTokenizer::O200kHarmony,
            TokenizerName::Cl100kBase => OpenAiTokenizer::Cl100kBase,
            TokenizerName::P50kBase => OpenAiTokenizer::P50kBase,
            TokenizerName::P50kEdit => OpenAiTokenizer::P50kEdit,
            TokenizerName::R50kBase => OpenAiTokenizer::R50kBase,
            _ => OpenAiTokenizer::O200kBase,
        };
        tiktoken_rs::bpe_for_tokenizer(tokenizer).expect("bundled tiktoken encoding")
    }

    pub fn count(self, text: &str) -> u64 {
        match self.huggingface() {
            Some(tokenizer) => tokenizer
                .encode(text, false)
                .expect("bundled tokenizer encodes UTF-8")
                .len() as u64,
            None => self.openai().count_ordinary(text) as u64,
        }
    }

    /// A source excerpt starts at an original UTF-8 boundary. Its enclosing JSON is measured
    /// separately by the planner, since it also consumes input space.
    pub(crate) fn prefix_bytes(self, text: &str, tokens: u64) -> usize {
        if tokens == 0 {
            return 0;
        }
        let tokens = usize::try_from(tokens).unwrap_or(usize::MAX);
        let mut end = match self.huggingface() {
            Some(tokenizer) => {
                let encoded = tokenizer
                    .encode(text, false)
                    .expect("bundled tokenizer encodes UTF-8");
                if encoded.len() <= tokens {
                    return text.len();
                }
                encoded
                    .get_offsets()
                    .get(tokens.saturating_sub(1))
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

    pub(crate) fn item(self, item: &ConversationItem) -> u64 {
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

    pub(crate) fn json(self, value: &Value) -> u64 {
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

    pub(crate) fn field(self, key: &str) -> u64 {
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
    fn model_vocabularies_count_unicode_and_preserve_complete_source_prefixes() {
        let modern = TokenCounter::for_model("openai/gpt-4o");
        let older = TokenCounter::for_model("gpt-4");
        assert_eq!(modern.count("Hello, world!"), 4);
        assert_eq!(modern.count("你好，世界！"), 4);
        assert_eq!(older.count("你好，世界！"), 7);
        assert!(!TokenCounter::for_model("custom-closed-model").matched);
        for model in [
            "gpt-4o",
            "deepseek-ai/DeepSeek-V4-Pro",
            "deepseek-v4.1-flash-1017",
            "Qwen/Qwen3-8B",
        ] {
            let counter = TokenCounter::for_model(model);
            assert!(counter.matched);
            let text = "第一行中文 🎉\nconst x = 123;\n".repeat(500);
            assert_eq!(counter.count(""), 0);
            assert!(
                counter.count(&text) > 3000,
                "{model} must encode the entire input"
            );
            assert_eq!(counter.prefix_bytes(&text, 0), 0);
            let end = counter.prefix_bytes(&text, 37);
            assert!(end > 0 && end < text.len() && text.is_char_boundary(end));
            assert!(counter.count(&text[..end]) <= 37, "{model} token prefix");
            assert_eq!(
                counter.prefix_bytes(&text, counter.count(&text)),
                text.len()
            );
        }
    }
}
