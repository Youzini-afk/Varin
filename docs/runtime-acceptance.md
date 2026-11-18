# Runtime Acceptance Boundaries

Portable unit tests, mocked providers, and in-memory fixtures prove local logic — not packaged installers, real OS mounts, desktop drivers, or physical multi-Host networks. Select relevant checks below based on what changed; leave unrun scenarios explicitly unverified.

## Real-Environment Checklist

| Area | What must be verified on real targets |
| --- | --- |
| Composer, touch & screen reader | Real IME composition, focus retention, mobile keyboard viewport, swipe vs selection, exit-motion interruption, extension subviews |
| Packaged streaming & reconnect | Disconnect/reopen/stop catches up original history, usage, and tool receipts without replaying work or settling a new Run with an old receipt |
| Native processes & PTY | Platform shells (including PowerShell 5.1), PTY output, descendant tree kill, lost-receipt recovery |
| Native Workspace mounts | WinFsp (Windows), FUSE (Linux), FSKit/macFUSE (macOS): real mount, normal process I/O, checkpoint/fork, writable mmap limits, restart rebind, open-handle drain, failed unmount. Opt-in real-mount tests live in [kernel/README.md](../kernel/README.md) |
| Storage open & Catalog upgrade | Real older Catalog upgrades preserve identity, bodies, queues, and receipts; unknown/corrupt stores fail closed read-only. Storage is verified independently |
| Files, drafts & recovery | Multi-root workspaces, concurrent external edits, editor conflict prompts, real Document Registry + Host + Rust |
| Multi-Host | Authenticated cross-machine connections, Source routing, remote recovery participants, project scheduling, disconnect cleanup |
| Computer Use & VM | Real per-platform observe/query/act/wait, control handback, signed Windows `VarinComputer.exe`, Linux app bridge, KVM/libvirt lifecycle |
| Models & auth | Real provider/cloud accounts, OAuth flows, proxy/DNS/TLS, mid-stream cancellation, unknown usage |
| Local embeddings | Installed Bekko/ONNX runtime, real hardware/weights, actual retrieval quality |
| Interactive content | Real iframe layout/focus/IME/touch, streaming-to-inline handoff without rerunning scripts, real Host/Rust revision conflicts, branch snapshot isolation, and deletion GC |
| Performance | Cold/warm/concurrent runs on identical builds; targeted recovery must observe real file I/O (no full-project recursive scans) |

## Recording Evidence

When reporting acceptance results, record the commit/artifact, OS/arch, source configuration, exact commands/steps, and clearly separate **passed**, **failed**, **skipped**, **blocked (e.g. sandbox EPERM)**, and **not run**. Never combine portable test counts into a global release sign-off. See [development.md](development.md#verification) for test entrypoints.
