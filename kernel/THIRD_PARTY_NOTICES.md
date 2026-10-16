# Rust kernel dependency notices

The kernel is distributed with the dependency graph locked in `Cargo.lock`. The direct dependencies
used by the private executable are distributed under their upstream permissive licenses:

- `rusqlite` / `libsqlite3-sys` — MIT; SQLite itself is public domain.
- `serde`, `serde_json`, `thiserror`, `uuid`, `sha2`, `hex`, and `base64` — MIT or Apache-2.0.
- `tree-sitter` — MIT.
- `wasmtime`, its C API, and Cranelift — Apache-2.0 with LLVM exceptions.

The complete transitive source and license metadata remain available from crates.io using the exact
versions in `Cargo.lock`; release automation must include this notice beside the staged executable.

## Pi model metadata and account protocols

The curated model presets and device authorization integrations in
`packages/web/application-host/lib/models`, and Copilot request-header handling in
`kernel/crates/varin-runtime/src/providers`, adapt portions of
[Pi](https://github.com/earendil-works/pi), revision
`698a2d23b86a5045dd54554354a5e0cb7e466795`.

Copyright (c) 2025 Mario Zechner

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
