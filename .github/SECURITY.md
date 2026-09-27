English | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/SECURITY.zh-CN.md)

# Varin security policy

Varin handles source code, terminal access, Git and SSH operations, model-provider credentials,
Pi session history, extension configuration, and remote connections. A defect at one of these
boundaries can have consequences beyond the application UI, so private and reproducible reports are
appreciated.

The implementation threat model and release gates are documented separately in
[docs/design/security.md](../docs/design/security.md).

## Supported versions

Varin is currently pre-1.0 and does not maintain LTS branches.

| Channel | Security support |
| --- | --- |
| Latest published release | Supported |
| Current `main` | Best-effort fixes during active development |
| Older releases, images, and arbitrary commits | No backport guarantee |

When reporting a problem, include the exact version, Git commit, container digest, or desktop build
whenever possible. A floating `latest` tag is not sufficient to identify affected code.

## Report a vulnerability privately

Do not disclose a suspected vulnerability in a public issue, discussion, pull request, screenshot,
terminal log, or chat transcript.

1. Prefer GitHub's
   [private vulnerability reporting form](https://github.com/Youzini-afk/Varin/security/advisories/new)
   when the repository exposes it to reporters.
2. If GitHub does not offer the private form,
   [open a minimal contact issue](https://github.com/Youzini-afk/Varin/issues/new?title=Private%20security%20report%20requested)
   titled **`Private security report requested`** with no technical details, secrets, affected
   paths, or proof of concept. A maintainer will establish a private channel before you send the
   report.

Please include in the private report:

- a concise description and the security boundary that is crossed;
- affected version/commit/image digest and product surface;
- operating system, architecture, deployment topology, and relevant non-secret configuration;
- minimal, deterministic reproduction steps or a proof of concept;
- observed and potential impact;
- whether the issue is already public or has a disclosure deadline;
- a suggested fix or mitigation, if you have one;
- the name or handle you would like credited, or a request to remain anonymous.

Remove real credentials, private prompts, source files, SSH keys, session data, and unrelated user
information. If a secret was exposed during testing, revoke it before sending the report and use a
redacted replacement in the reproduction.

Varin does not yet provide a contractual response-time SLA or a bug-bounty program. Maintainers
will aim to acknowledge a complete report promptly, confirm scope, agree on disclosure timing, and
provide material status changes through the private thread.

## Security scope

Reports are especially useful when they demonstrate a violation of an intended boundary in:

- Electron main/preload IPC, window origin checks, deep links, updater, or packaged resources;
- the Pi host, runtime broker, worker lifecycle, protocol parser, or cross-session event routing;
- Web authentication, cookies/tokens, pairing, Origin checks, WebSocket authorization, relay, or
  tunnel handling;
- filesystem containment, symlink/junction resolution, file grants, worktrees, Git, terminal, PTY,
  subprocess, SSH, or remote-host operations;
- project trust, package installation, extension loading, MCP command approval, or capability
  escalation before consent;
- model/provider authentication, credential storage, discovery redirects, or secret redaction;
- Pi session recovery, workspace-history delegation, concurrent writes, rollback, or data deletion;
- cloud archives, Docker images, deployment locks, health validation, rollback, release identity,
  dependency installation, or build provenance;
- leakage of prompts, source files, environment values, credentials, or private provider responses
  through logs, diagnostics, URLs, notifications, or renderer state.

Vulnerabilities in Pi or a third-party extension should normally be reported to that project. Still
report the issue to Varin when its integration bypasses a Varin trust boundary, activates code
before approval, exposes data beyond the capability shown to the user, or prevents an upstream fix
from taking effect.

## Trust model and expected behavior

The following facts are important when deciding whether behavior is a Varin vulnerability:

- **Pi packages are trusted executable code.** They run with the user's operating-system
  permissions in an isolated worker process. Capability labels support an informed trust decision;
  they are not a claim of a complete OS sandbox. A malicious package using permissions the user
  explicitly granted is different from package code running before trust or escaping the stated
  boundary.
- **Projects can contain executable configuration.** Project-local Pi resources, MCP commands,
  credential commands, hooks, and extension settings remain disabled until the trusted host accepts
  the relevant project grant.
- **The renderer is untrusted relative to native hosts.** UI state alone never grants local file,
  process, credential, update, or SSH authority.
- **Remote clients have explicit capabilities.** Being authenticated to the Web UI does not
  automatically make a remote client equivalent to a local desktop renderer.
- **Providers and research services are external recipients.** Sending an approved prompt or tool
  request to the selected provider is expected; sending unrelated workspace or credential data is
  not.
- **Local administrators control the machine.** Varin does not attempt to protect its data from an
  operating-system administrator who can read the user's files and process memory.

If you are unsure whether observed behavior crosses one of these boundaries, report it privately and
let the maintainers triage it.

## Safe research and coordinated disclosure

When testing Varin:

- use systems, workspaces, accounts, credentials, and remote instances you own or are authorized to
  test;
- minimize data access and stop after proving the boundary violation;
- do not persist access, exfiltrate unrelated data, degrade shared services, or use social
  engineering;
- avoid publishing technical details until a fix or mitigation is available and a disclosure date
  has been coordinated;
- preserve enough non-sensitive evidence for maintainers to reproduce and verify the fix.

After validation, maintainers will prepare a focused fix and regression test, evaluate affected
releases and deployment guidance, and publish a GitHub Security Advisory when appropriate. Credit is
given according to the reporter's preference.

## Deployment and user hardening

- Do not bind the Web service beyond loopback without a strong `VARIN_UI_PASSWORD`.
- Use TLS through a trusted reverse proxy or an approved tunnel for traffic leaving the machine.
- Treat every Pi package and project-local executable resource as code; review its source and
  requested capabilities before approval.
- Keep Varin, Pi, maintained extensions, and the host operating system updated.
- Keep persistent Varin data, workspaces, SSH material, and deployment environment files outside
  immutable release directories and protect them with appropriate filesystem permissions.
- Pin production containers by digest, retain a known-good deployment, and verify `/health` reports
  a ready bundled Pi runtime and the expected release identity.
- Do not place passwords, provider keys, tunnel tokens, or SSH material in images, build arguments,
  repositories, command histories, screenshots, or issue reports.

See [Cloud deployment](../docs/ops/cloud-deployment.md) for persistent paths, secret-file permissions,
container attestations, immutable releases, and rollback behavior.

## Build and release integrity

Repository CI performs frozen dependency installation, dependency audits, Pi dependency checks,
type checking, linting, tests, production builds, cloud-layout verification, and packaged-host smoke
tests. Container candidates are built for `linux/amd64` and `linux/arm64` with provenance and SBOM
attestations; installable tags are promoted only after an immutable application digest passes its
runtime smoke test.

Desktop signing is conditional. A locally built or CI smoke Windows installer is unsigned when
signing credentials are not configured. Verify the source revision and build provenance before
running an unsigned artifact.
