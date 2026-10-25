[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | 日本語

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>AI エージェントと作業するための、オープンソースのワークスペース。</strong></p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases">ダウンロード</a> ·
  <a href="../../packages/docs/README.md">使い方</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">拡張機能を作る</a> ·
  <a href="../translations/CONTRIBUTING.ja.md">貢献する</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

モデル、ツール、ファイル、プロジェクトを一つのワークスペースにまとめます。エージェントと一緒に問題を調べ、コードを書き、論文を読み、対話型の説明を作れます。作業の進行と結果は同じ会話で確認できます。

Varin はデスクトップと Web で動作し、Host に接続するモバイルクライアントも備えています。独自の Rust ランタイムがエージェントの実行と会話履歴を管理します。

## Varin でできること

| 作業 | 機能 |
| --- | --- |
| タスクを進める | ストリーミング会話、メッセージキュー、計画、子エージェント、スケジュールされたフォローアップ。 |
| プロジェクトを開発する | ファイル編集、差分確認、Git と worktree、ターミナル、コード検索と言語ツール。 |
| 資料を読み、調べる | Web・学術検索、PDF の閲覧、会話に関連する原資料の保存。 |
| 視覚的な成果物を作る | 画像生成・編集、メッセージ内の対話型 HTML グラフや小さなツール。 |
| 自分の環境を整える | クラウド・ローカルモデルの接続、権限、指示、skills、MCP サーバーの設定。 |
| 複数の端末で作業する | ローカルの作業領域、またはデスクトップ・ブラウザー・モバイルからリモート Host への接続。 |

同梱の Agent、IDE、Research、Bot ワークベンチには、用途に応じたレイアウトがあります。IDE はデスクトップと Web、その他はモバイルにも対応しています。[ワークベンチの詳細](../../docs/workbench.md)

## はじめる

| 利用方法 | 入口 |
| --- | --- |
| Windows・macOS・Linux のデスクトップアプリ | [リリースをダウンロード](https://github.com/Youzini-afk/Varin/releases)。OS と CPU アーキテクチャに合うファイルを選んでください。 |
| 自分の PC やサーバーで動かし、ブラウザーから使う | [Docker でセルフホスト](../../docs/ops/cloud-deployment.md)。永続ストレージ、パスワード、リモート接続の設定を説明しています。 |
| iOS・Android | [モバイルの設定](../../packages/mobile/README.md)。既存の Host に接続します。 |
| ソースから動かす | 以下の開発手順を参照してください。 |

アプリの設定でモデルプロバイダーまたはローカルサービスを接続します。モデルを選び、作業に必要ならプロジェクトフォルダーを指定して、会話を始めます。入力欄では権限と汎用・研究モードを選べます。

Varin は 1.0 に向けて開発中です。このページは現在のソースを説明し、公開済みビルドの内容は[リリースノート](https://github.com/Youzini-afk/Varin/releases)に記載しています。アップグレード前に重要なアプリデータをバックアップしてください。

## ソースから実行する

**Node.js 24**、**Bun 1.3.14**、Git と、[rust-toolchain.toml](../../kernel/rust-toolchain.toml)で指定された Rust ツールチェーンを使います。ネイティブ依存関係には C/C++ ツールチェーンと CMake も必要です。[開発ガイド](../../docs/development.md)で環境とコマンドを確認できます。

```sh
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

ターミナルに表示される UI の URL を開きます。このコマンドは Web UI と Application Host を起動します。

デスクトップアプリの開発には、同じチェックアウトで `bun run electron:dev` を実行します。ネイティブカーネルを準備し、開発用 UI で Electron を起動します。[デスクトップ開発とパッケージ作成](../../packages/electron/README.md#development)

## ワークスペースを拡張する

Varin の harness は、モデルとツール、コンテキスト、権限、バックグラウンド作業、子エージェントをつなぎます。Rust ランタイムが会話と実行記録を保存し、共通の Application Host がモデル接続とワークスペースのサービスを提供します。

よく使うツールは直接宣言します。その他の利用可能な機能には索引とオンデマンドの説明があり、説明を取得してもツール宣言のプレフィックスは変わりません。研究ツールは汎用モードではオンデマンド、研究モードでは常駐の宣言として提供します。

拡張機能ではツール、モデルアダプター、パネル、ワークベンチ全体のレイアウトを追加できます。[作成ガイド](../../docs/ops/varin-extension-authoring.md)、[SDK](../../packages/extension-sdk/README.md)、[実例](../../examples/extensions/README.md)から始められます。

実装の詳細は[アーキテクチャ](../../docs/architecture.md)、[ランタイム](../../docs/runtime.md)、[ドキュメント索引](../../docs/README.md)を参照してください。

## 貢献する

バグ報告、UI やツールの改善、文書、翻訳、各プラットフォームでの動作報告を歓迎します。[貢献ガイド](../translations/CONTRIBUTING.ja.md)では環境の準備、変更内容の選び方、Pull Request の提出を説明しています。

[バグを報告](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [機能を提案](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [脆弱性を非公開で報告](../SECURITY.md)

[LinuxDO](https://linux.do) コミュニティの支援に感謝します。

## ライセンス

本プロジェクトは [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）で配布します。ネットワーク経由で提供する改変版は、ライセンスの定めに従って対応するソースを提供する必要があります。著作権と第三者の通知は [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) に保持しています。
