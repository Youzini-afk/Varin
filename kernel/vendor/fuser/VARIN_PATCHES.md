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

Unmount retains the original mount object when the OS returns an error. A borrowing
`BackgroundSession::unmount` lets Varin retry it before joining; an event-loop panic
also joins the remaining workers before returning. These changes avoid dropping
ownership of a still-live filesystem during a failed detach.

Remove this patch when the upstream release provides the same configurable handshake. Pin and
review the replacement release; do not modify the global Cargo registry copy.
