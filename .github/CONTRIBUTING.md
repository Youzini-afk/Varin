English | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contributing to Varin

Varin is an agent harness that should work well out of the box. The most useful contributions help the same model go further, or make the defaults better for the people who use them:

- tools, and how their results reach the model and the conversation;
- context, retrieval and memory;
- model providers and protocols;
- extensions, templates and examples;
- the defaults of the code, research, office and general modes;
- documentation and translations;
- test reports from your platform: Windows, macOS, Linux, Docker, or a remote Host.

## Pick a starting point

Search [issues](https://github.com/Youzini-afk/Varin/issues), [pull requests](https://github.com/Youzini-afk/Varin/pulls) and [Discussions](https://github.com/Youzini-afk/Varin/discussions) for related work. A small, reproducible problem is a useful first contribution; issues labeled [good first issue](https://github.com/Youzini-afk/Varin/labels/good%20first%20issue) are a good place to begin. For a larger change, describe the workflow you want to improve in [Ideas](https://github.com/Youzini-afk/Varin/discussions/categories/ideas) or a feature request, and share a sketch or prototype early. Questions go to [Q&A](https://github.com/Youzini-afk/Varin/discussions/categories/q-a); [Getting help](SUPPORT.md) lists the other channels.

Bug reports are useful on their own. Include the version, installation method, what happened, and steps or an example that reproduce it. Remove credentials and private content from logs and screenshots. Use the [security policy](SECURITY.md) for vulnerability reports.

## Set up a checkout

Fork and clone the repository. Source development uses Node.js 24, Bun 1.3.14, Git, Rust, a C/C++ toolchain, and CMake. The [development guide](../docs/development.md) covers environment setup and commands.

From the repository root:

```sh
bun install --frozen-lockfile
git switch -c your-change
bun run dev
```

Open the UI URL printed in the terminal. For desktop development, use `bun run electron:dev`. Configure a model in Settings when your change needs a running agent.

Read [AGENTS.md](../AGENTS.md) and the README or DOCUMENTATION nearest the code you will change.

## Find the right part of the repository

| Area | Start here |
| --- | --- |
| Conversations, panels, editors, and shared UI | [packages/ui](../packages/ui/DOCUMENTATION.md) |
| The agent loop, tools, context, permissions, retries, and recovery | [Agent runtime](../kernel/crates/varin-runtime/README.md), [runtime](../docs/runtime.md), [retrieval and context](../docs/retrieval.md) |
| Web, research, document, Office, browser, and MCP services the agent uses | [Host harness services](../packages/web/application-host/lib/harness/DOCUMENTATION.md) |
| Model providers, protocols, and accounts | [Models and accounts](../packages/web/application-host/lib/models/DOCUMENTATION.md) |
| Application services and remote access | [Application Host](../packages/web/README.md) |
| Agent execution, history, files, and processes | [Rust kernel](../kernel/README.md) |
| Extension contracts and authoring | [Extension guide](../docs/ops/varin-extension-authoring.md), [examples](../examples/extensions/README.md) |
| User guides and translations | [Public docs](../packages/docs/CONTRIBUTING.md) |
| How the pieces fit together | [Architecture](../docs/architecture.md), [documentation index](../docs/README.md) |

Follow the existing owner of the behavior. The Rust runtime manages conversations and execution; the Application Host supplies trusted services; clients present them through shared APIs. Preserve user files and data, and use the established extension interfaces.

## Make and check the change

Keep one coherent problem in each pull request. Read the implementation and its callers, use the existing style and shared UI components, and update the documentation that describes the behavior.

Choose checks that exercise the affected behavior. Reuse existing tests; add a focused regression test when it protects an important behavior or a reproduced bug. The [development guide](../docs/development.md#修改与验证) lists checks by change type. Documentation and link changes use `bun run docs:validate`.

For UI work, attach a screenshot or recording of the relevant state. For performance work, include a representative measurement. Record the commands you ran and their results, plus any relevant behavior you could not check in your environment.

Public guides and the repository's introductory documents use English as their source language. Keep the existing translations aligned when changing behavior, commands, or links. Main engineering docs use Chinese; package and source-adjacent docs keep their established language.

## Open a pull request

Explain the problem and the resulting behavior, then give the relevant verification. Link related issues and include screenshots where useful. The [PR template](pull_request_template.md) keeps these details together.

Use a concise commit subject that describes the change. Resolve conflicts with attention to the intended behavior, and preserve unrelated work.

## Community and license

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Discussions, issues and pull requests are the shared places to talk about the project; [Getting help](SUPPORT.md) says which one fits.

By submitting a contribution, you agree that it may be distributed under [AGPL-3.0-only](../LICENSE). Keep the copyright and license notices for imported third-party material; see [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md).
