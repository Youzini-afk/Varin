# fuser 0.18.0 transport patch

Source: crates.io `fuser` 0.18.0, archive SHA-256
`b82b6597d216503555ead6b358f341ef748869bf5c6fbae6a0cb9dd231baecfd`.
The library source, build script and license are preserved here. The manifest omits upstream
example targets and dev-only dependencies. Upstream examples/tests are
not part of this dependency-only vendoring; workspace qualification tests live in varin-kernel.

The patch changes the macOS INIT defaults to avoid declaring case-insensitive names and volume
rename without a filesystem implementation. Upstream issue:
https://github.com/cberner/fuser/issues/749. It also exposes `remove_capabilities`, so a backend
can accurately negotiate supported behavior rather than relying on transport defaults.
Linux defaults are unchanged. This does not disable mmap or data caching.

The request decoder now handles FUSE_SYNCFS (ABI 7.36), including its fixed input
payload, ACL admission and filesystem callback. Advertising a newer ABI must not
make a legitimate syncfs request terminate the dispatcher. Varin negotiates
writeback cache only with this boundary and freezes its selected Session inside
the matching requesting thread's post-writeback callback; unrelated syncs cannot
consume the boundary. O_WRONLY cache-fill reads are admitted only in that mode.

Pure-Rust Linux dependency checks inspect the actual FUSE device and mounting
route. A direct mount needs CAP_SYS_ADMIN in the current namespace; otherwise an
executable helper is resolved through FUSERMOUNT_PATH/PATH and installed system
locations. Checks never execute helpers or elevate the Host. The helper detach
path propagates its actual result and does not request lazy/forced unmount before
releasing the original owner.

Unmount retains the original mount object when the OS returns an error. A borrowing
`BackgroundSession::unmount` lets Varin retry it before joining; an event-loop panic
also joins the remaining workers before returning. These changes avoid dropping
ownership of a still-live filesystem during a failed detach.

macOS default builds load the installed libfuse3 public session API at runtime. The loader admits
absolute installed library paths, validates the five session entry points, serializes loading and
caches successful loads only; installing the dependency later can be retried. Explicit libfuse2
and libfuse3 SDK builds remain available. This addresses the disabled compat25 mount
entry point in modern macFUSE: https://github.com/cberner/fuser/issues/752. The libfuse3 transport
now destroys its owned session on failed construction and after detach; its duplicated fd remains
owned by `DevFuse`. Linux helper detach checks the actual exit status before releasing ownership.
Real OS mount qualification remains in the Varin opt-in tests; compile-only macOS CI does not
exercise the dynamic mount library or an installed system extension.

The macOS getxattr offset is forwarded to an additive `getxattr_at` callback. Its default preserves
ordinary getxattr dispatch at offset zero and rejects unsupported positioned reads, rather than
silently returning data from offset zero. Varin does not yet implement positioned resource-fork I/O.

Remove this patch when the upstream release provides the same configurable handshake. Pin and
review the replacement release; do not modify the global Cargo registry copy.
