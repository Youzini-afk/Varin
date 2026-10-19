# Offline context vocabularies

These are official Hugging Face `tokenizer.json` files, gzip-compressed without editing the JSON.
`sources.json` records the upstream repository, pinned revision and SHA-256 of each uncompressed
file. V4 Pro and Flash share one vocabulary; V4.1 Flash and Flash-1017 share another. Each upstream
license is retained here and included in the kernel's distributed `THIRD_PARTY_NOTICES.md`.

The runtime lazily loads each vocabulary once and disables training-time padding/truncation.
It does not download files or resolve floating model revisions during a conversation.
`src/token_count.rs` maps verified model names to these assets; unrecognized names use a labeled
reference tokenizer. OpenAI encodings and model mappings come from the locked `tiktoken-rs` crate.

When updating a model mapping, verify its actual upstream tokenizer, update the pinned provenance
and license, and check full-input counting and UTF-8 excerpt boundaries.
