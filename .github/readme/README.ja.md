[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | 日本語

# Varin

<p align="center">
  <img src="../../packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../../LICENSE)

**コーディング、研究、プロジェクト作業のための独立した Agent ワークスペースと実行基盤。
デスクトップ、Web、モバイルで利用できます。**

Varin は独自のネイティブ Rust Agent runtime を使用します。Catalog が Thread、ブランチ、永続的な
会話履歴と実行を所有します。共通の Application Host がモデル接続とアカウント、Agent リソース設定、
MCP 設定、信頼されたワークスペースサービスを管理します。各クライアントは同じアプリケーション API を
通じてこれらを表示・操作します。[アーキテクチャ](../../docs/architecture.md)を参照してください。

> [!IMPORTANT]
> Varin は 1.0 未満で、活発に開発されています。製品 UI と非公開ランタイムプロトコルは同時に進化するため、
> 新旧バージョンの相互運用は保証されません。重要なワークスペースをバックアップし、継続的なデプロイでは
> 検証済みイメージのダイジェストを固定してください。既存のユーザー資産を自動インポート、移行、書き換えする
> ことはありません。未対応の内部ストア形式は拒否されます。

## Varin が提供するもの

- **ネイティブ会話：** Thread とブランチの履歴、ストリーミング、入力キュー、モデルと思考レベルの選択、
  子タスク、計画、権限、復旧を、ネイティブ Catalog が支えます。[ランタイム](../../docs/runtime.md)
- **開発ワークスペース：** ファイル、差分、Git、worktree、ターミナル、ワークスペース検索、言語サーバー、
  デバッグ。デスクトップと Web は Monaco を共有し、モバイルの軽量エディターも同じ文書管理基盤を使います。
  未保存バッファーと競合を明示的に扱います。[ワークベンチ](../../docs/workbench.md)
- **実行と復旧：** 受け入れたソースはライブファイル、スナップショット、実体化した作業を区別します。
  Rust がストレージと実行リソースを所有し、権限、キャンセル、実際の完了は別の事実として扱います。
  [リソースと復旧](../../docs/resources.md)
- **研究とコンテキスト：** 完全一致・セマンティック検索、コードナビゲーション、範囲を定めたノート、Bot の
  知識、Web・学術情報の探索、ソースとページ画像を保持する PDF 資料。[検索とコンテキスト](../../docs/retrieval.md)
- **Host が管理する設定：** 専用の設定画面でモデルチャネル、アカウント、エンドポイント、Agent の指示と
  スキル、MCP 接続を構成できます。認証情報と特権実行は信頼された所有者が管理します。
  [モデル](../../packages/web/application-host/lib/models/DOCUMENTATION.md)、
  [Agent リソース](../../packages/web/application-host/lib/agent-resources/DOCUMENTATION.md)、
  [MCP](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md)
- **ローカル・リモート利用：** Electron は Application Host を内蔵し、Web と Capacitor モバイルクライアントは
  Host に接続します。リモート Host、ペアリング、トンネル、コンテナー/SSH デプロイには明示的なアクセスと
  プラットフォームの境界があります。[セキュリティ](../../docs/security.md) · [運用](../../docs/ops/README.md)

4 つの組み込み Workbench Profile で **Agent Workspace**、**IDE Workbench**、**Research Workbench**、
**Varin Bot** を選択できます。Agent、Research、Bot はデスクトップ、Web、モバイルに対応し、IDE は
デスクトップと Web に対応します。Profile は Varin 拡張として、シェル全体や個々の構成要素を置き換えられます。
作業の焦点、文書、Thread の識別は表示から独立しています。

モデルプロバイダー、Computer/VM、パッケージの対応状況は実環境に依存します。個別のテストだけでは
プラットフォーム全体の検証にはなりません。[ランタイム受け入れ検証](../../docs/runtime-acceptance.md)を参照してください。

## Varin 拡張を開発する

Varin 拡張は公開契約を通じてワークベンチ UI と信頼された Host 機能を追加します。開発用パッケージは
`@varin/extension-contract`、`@varin/extension-sdk`、任意の React 19 アダプター `@varin/extension-react`、
`@varin/extension-surface`、`@varin/extension-cli` です。

利用中のレジストリーで公開バージョンが提供されている場合：

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

ソースからの開発手順、manifest、機能、ライフサイクル、公開、テストについては
[拡張](../../docs/extensions.md)と[開発ガイド](../../docs/ops/varin-extension-authoring.md)を参照してください。

## デスクトップ版をダウンロード

[GitHub Releases](https://github.com/Youzini-afk/Varin/releases) で利用可能な配布物と対応プラットフォーム、
バージョンを確認してください。ソースとコンテナーの利用手順は以下のとおりです。

## ソースから始める

必要なもの：Node.js 22.19 以降（ソース開発の基準は Node.js 24）、Bun 1.3.14、Git、
[kernel/rust-toolchain.toml](../../kernel/rust-toolchain.toml) で指定された Rust ツールチェーン。
プラットフォームの準備と検証は[開発ガイド](../../docs/development.md)を参照してください。

Rust kernel は必須です。ソース開発では、配置済みバイナリーがない場合に Cargo から起動できます。
`bun run kernel:build` は配布レイアウトに必要な、manifest 検証付き release 実行ファイルを生成します。
準備状態は実際の Application Host とネイティブ Thread catalog に対して確認されます。

### Web 開発

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

ターミナルに表示される Vite URL を開いてください。UI と信頼された Application Host が利用可能な開発用ポートで
起動します。モデルを使用する作業を始める前に、設定でモデル接続とアカウントを構成してください。

### デスクトップ開発

```bash
bun run electron:dev
```

同梱された UI アセットをテストする場合：

```bash
bun run electron:dev:bundled
```

### Windows インストーラー

Windows 上で実行してください：

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

NSIS インストーラー、更新メタデータ、blockmap は `packages/electron/dist` に出力されます。署名用認証情報が
なければ未署名になります。[デスクトップのパッケージ化](../../packages/electron/README.md#packaging)を参照してください。

## クラウドイメージを実行する

Compose は既定で `ghcr.io/youzini-afk/varin-slim:latest` を使用します。Linux Docker ホスト上で：

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

`http://127.0.0.1:3000` を開き、生成したパスワードを使用してください。インターネットに公開する場合は、
[転送ルール](../../docs/ops/REVERSE_PROXY.md)に従う TLS リバースプロキシまたは承認済みトンネルが必要です。
本番では `VARIN_IMAGE` を検証済みの不変ダイジェストに固定してください。

コンテナー内で Python、Java、Go、Rust の開発ツールが必要な場合：

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

永続化パス、環境変数、イメージの種類、対応アーキテクチャ、ヘルスチェックとロールバック付き SSH デプロイは
[クラウドデプロイ](../../docs/ops/cloud-deployment.md)を参照してください。

## アーキテクチャと開発

[ドキュメント索引](../../docs/README.md)、[アーキテクチャ](../../docs/architecture.md)、
[開発ガイド](../../docs/development.md)から始めてください。Application Host はネイティブ Catalog の実行、
Rust が所有するストレージとリソース、独立した知識・拡張の所有者を統合します。
renderer は認証情報や永続的な実行を所有しません。

貢献前に [CONTRIBUTING](../CONTRIBUTING.md) と [AGENTS](../../AGENTS.md) を読んでください。
コマンドの定義は package scripts に従い、変更に適した検証を選択してください。

[LinuxDO](https://linux.do) コミュニティの支援に感謝します。

## 系譜とライセンス

Varin はメンテナーの OpenChamber フォークを起点とする独立したプロジェクトです。

結合された著作物は [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）で配布されます。
変更版をネットワーク経由で提供する場合は、ライセンスに従って対応するソースコードを提供する必要があります。
保持される著作権表示と第三者への義務は [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) に記載されています。
