[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | 日本語

# Varin への貢献

バグの修正、作業手順の改善、拡張機能の開発、文書の作成、各プラットフォームでの動作報告などで参加できます。

## 最初の作業を選ぶ

[Issues](https://github.com/Youzini-afk/Varin/issues) と [Pull Requests](https://github.com/Youzini-afk/Varin/pulls) で関連する作業を確認してください。最初の貢献には、小さく再現可能な問題が適しています。大きな変更では、改善したい作業手順を早めに説明し、スケッチや試作品を共有すると議論しやすくなります。

バグ報告だけでも役立ちます。バージョン、インストール方法、起きた現象、再現手順や例を記載してください。ログや画像から認証情報と個人のデータを取り除き、脆弱性は[セキュリティポリシー](../SECURITY.md)に沿って報告してください。

## 開発環境を準備する

リポジトリを fork して clone します。開発には Node.js 24、Bun 1.3.14、Git、Rust、C/C++ ツールチェーン、CMake を使います。環境とコマンドの詳細は[開発ガイド](../../docs/development.md)を参照してください。

リポジトリのルートで実行します。

```sh
bun install --frozen-lockfile
git switch -c your-change
bun run dev
```

ターミナルに表示される UI の URL を開きます。デスクトップ開発には `bun run electron:dev` を使います。実際にエージェントを動かす必要がある変更では、設定でモデルを接続してください。

変更前に [AGENTS.md](../../AGENTS.md) と、対象のコードに近い README または DOCUMENTATION を読んでください。

## 対応するモジュールを探す

| 対象 | 入口 |
| --- | --- |
| 会話、パネル、エディター、共通 UI | [packages/ui](../../packages/ui/DOCUMENTATION.md) |
| モデル接続、アプリのサービス、リモートアクセス | [Application Host](../../packages/web/README.md) |
| エージェントの実行、履歴、ファイル、プロセス | [Rust カーネル](../../kernel/README.md) |
| 拡張機能の契約と開発 | [作成ガイド](../../docs/ops/varin-extension-authoring.md)、[実例](../../examples/extensions/README.md) |
| 利用ガイドと翻訳 | [公開ドキュメント](../../packages/docs/CONTRIBUTING.md) |
| システム全体の構成 | [アーキテクチャ](../../docs/architecture.md)、[文書索引](../../docs/README.md) |

既存の担当範囲に沿って変更します。Rust ランタイムは会話と実行、Application Host は信頼されたサービスを担当し、クライアントは共通 API を通じて表示します。ユーザーのファイルとデータを保ち、既存の公開拡張インターフェースを使ってください。

## 実装と検証

一つの Pull Request は一つのまとまった問題に集中させます。実装と呼び出し元を読み、既存のスタイルと共通 UI コンポーネントを使い、その動作を説明する文書を更新してください。

検証は変更した動作に合わせて選びます。既存のテストを使い、重要な動作や再現した不具合には絞った回帰テストを追加します。[開発ガイド](../../docs/development.md#修改与验证)に変更の種類に応じた検証をまとめています。文書やリンクの変更には `bun run docs:validate` を使います。

UI の変更には該当する状態の画像や録画、性能の変更には代表的な測定結果を添えてください。実行したコマンドと結果、環境の都合で確認できなかった関連動作を記録します。

公開ガイドとリポジトリの紹介文書は英語を原文とします。動作、コマンド、リンクを変更した場合は既存の翻訳にも反映してください。主要な技術文書は中国語、パッケージ内やコードに隣接する文書は従来の言語を使います。

## Pull Request を送る

問題と変更後の動作を説明し、関連する検証結果を記載します。該当する Issue にリンクし、役立つ場合は画像も添えてください。[PR テンプレート](../pull_request_template.md)に記入欄があります。

コミットの件名は変更を簡潔に表してください。競合の解消では意図した動作を確認し、今回の変更と無関係な作業を保持します。

## コミュニティとライセンス

[行動規範](CODE_OF_CONDUCT.ja.md)に従ってください。

貢献を提出することで、その内容を [AGPL-3.0-only](../../LICENSE) で配布できることに同意したものとします。取り込む第三者の素材の著作権とライセンスの通知を保持してください。詳細は [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) を参照してください。
