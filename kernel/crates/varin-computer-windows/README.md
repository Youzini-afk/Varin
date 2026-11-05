# Windows Computer helper

`VarinComputer.exe` is an independent desktop adapter owned by the existing Application Host
ComputerService. It does not link the resource kernel or Agent runtime. The shared toolchain and
Cargo.lock govern its four direct dependencies: serde, serde_json, base64 and Windows bindings.

The [driver contract](../../../packages/computer-driver/README.md) is the protocol authority;
[implementation and acceptance](../../../docs/design/native-computer-helper.md) describes delivery
and the remaining platform evidence. From the repository root on Windows:

```sh
bun run computer:build
node packages/computer-driver/windows/build-helper.mjs --test
node packages/computer-driver/windows/smoke-helper.mjs
```

The build entry resolves Visual Studio/SDK tools and the pinned Rust version, builds a target-specific
release with version resources, validates imports/architecture/signature and stages a matching manifest.
A plain Cargo binary is not a replacement for this verified release artifact.

Portable tests run on every host with `cargo test --manifest-path kernel/Cargo.toml -p
varin-computer-windows --locked`. Windows-only tests use the real helper/control pipe and in-memory WIC
images, never a private application or injected desktop input. Cross-target `cargo check --tests` checks
bindings and test compilation; it does not prove native execution, linking, signature or desktop behavior.

The operation worker owns MTA COM objects. The main thread monitors stdin and the separate control
thread owns a one-user, local-only pipe. Only short input sends/tracking share the input lock. No UIA,
synchronous message or capture call may run while holding that lock. The read-only capture role does
not create UIA objects. EOF fences/releases and exits independently of a blocked provider.

Code ports retain the original upstream MIT provenance documented in the repository
[third-party notices](../../../THIRD_PARTY_NOTICES.md).
