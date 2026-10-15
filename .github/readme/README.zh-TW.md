[English](../../README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [Français](README.fr.md) | [日本語](README.ja.md)

# Varin

<p align="center">
  <img src="../../packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../../LICENSE)

**獨立的 Agent 工作空間與執行框架，用於程式開發、研究和專案工作，涵蓋桌面、Web 與行動端。**

Varin 使用自己的原生 Rust Agent runtime。Catalog 擁有 Thread、分支、持久對話歷史與執行狀態。
共用 Application Host 負責模型連線與帳號、Agent 資源設定、MCP 設定和可信工作區服務。
用戶端透過同一套應用 API 呈現並控制這些服務。詳見[架構](../../docs/architecture.md)。

> [!IMPORTANT]
> Varin 尚未達到 1.0，正在積極開發。產品介面與私有執行階段協定同步演進，新舊版本不保證互通。
> 請備份重要工作區，並在持久部署中固定經過驗證的映像檔摘要。現有使用者資產不會被自動匯入、遷移或改寫；
> 不支援的內部儲存格式會被拒絕開啟。

## Varin 提供什麼

- **原生對話：** Thread 與分支歷史、串流回應、輸入佇列、模型與思考級別選擇、子任務、計畫、權限和復原，
  均由原生 Catalog 支撐。[執行階段](../../docs/runtime.md)
- **程式開發工作區：** 檔案、差異、Git、worktree、終端機、工作區搜尋、語言伺服器和偵錯。
  桌面與 Web 共用 Monaco，行動端輕量編輯器使用同一個文件權威，並明確處理未儲存的緩衝區與衝突。
  [工作台](../../docs/workbench.md)
- **執行與復原：** 經准入的來源區分即時檔案、快照和實體化工作。Rust 擁有儲存與執行資源；
  權限、取消意圖和實際完成是獨立事實。[資源與復原](../../docs/resources.md)
- **研究與上下文：** 精確和語意檢索、語言導覽、作用域筆記、Bot 知識、Web 與學術探索，
  以及保留來源和頁面影像的 PDF 材料。[檢索與上下文](../../docs/retrieval.md)
- **Host 管理的設定：** 透過專用設定配置模型渠道、帳號、端點、Agent 指令與技能、MCP 連線。
  憑證和特權執行由可信 owner 持有。[模型](../../packages/web/application-host/lib/models/DOCUMENTATION.md)、
  [Agent 資源](../../packages/web/application-host/lib/agent-resources/DOCUMENTATION.md)、
  [MCP](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md)
- **本地與遠端使用：** Electron 內嵌 Application Host，Web 和 Capacitor 行動用戶端連線至同一 Host。
  遠端 Host、配對、通道及容器/SSH 部署保留明確的存取與平台邊界。
  [安全](../../docs/security.md) · [維運](../../docs/ops/README.md)

四個內建 Workbench Profile 分別選擇 **Agent Workspace**、**IDE Workbench**、**Research Workbench**
或 **Varin Bot**。Agent、Research 和 Bot 支援桌面、Web 與行動端，IDE 支援桌面與 Web。
這些 Profile 都是 Varin 擴充套件，可以替換整個外殼或個別貢獻；工作焦點、文件和 Thread 身分獨立於介面呈現。

模型供應商、Computer/VM 和封裝支援取決於實際環境。針對性測試不等於完整的平台驗收；
詳見[執行階段驗收](../../docs/runtime-acceptance.md)。

## 開發 Varin 擴充套件

Varin 擴充套件透過公開契約貢獻工作台介面和可信 Host 能力。開發工具套件包括 `@varin/extension-contract`、
`@varin/extension-sdk`、選用的 React 19 介接器 `@varin/extension-react`、`@varin/extension-surface`
和 `@varin/extension-cli`。

當所用 registry 中有可用的發行版本時：

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

原始碼工作流程、manifest、能力、生命週期、發布與測試契約見[擴充套件](../../docs/extensions.md)及
[開發指南](../../docs/ops/varin-extension-authoring.md)。

## 下載桌面版

請在 [GitHub Releases](https://github.com/Youzini-afk/Varin/releases) 查看可用產物及平台、版本資訊。
原始碼和容器使用方式如下。

## 從原始碼開始

前提：Node.js 22.19 或更新版本（原始碼開發基線為 Node.js 24）、Bun 1.3.14、Git，
以及 [kernel/rust-toolchain.toml](../../kernel/rust-toolchain.toml) 指定的 Rust 工具鏈。
平台設定與驗證見[開發指南](../../docs/development.md)。

Rust kernel 是必要元件。沒有 staged binary 時，原始碼開發可以透過 Cargo 啟動它；
`bun run kernel:build` 產生封裝布局所需、經 manifest 驗證的 release 執行檔。
就緒檢查針對實際 Application Host 與原生 Thread catalog。

### Web 開發

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

開啟終端機印出的 Vite URL。此命令在可用開發連接埠啟動 UI 與可信 Application Host。
開始模型工作前，請在設定中配置模型連線與帳號。

### 桌面開發

```bash
bun run electron:dev
```

若要測試封裝的 UI 資源：

```bash
bun run electron:dev:bundled
```

### Windows 安裝程式

在 Windows 上執行：

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

NSIS 安裝程式、更新中繼資料和 blockmap 輸出至 `packages/electron/dist`。未設定簽署憑證的建置不帶簽章。
詳見[桌面封裝](../../packages/electron/README.md#packaging)。

## 執行雲端映像檔

Compose 預設使用 `ghcr.io/youzini-afk/varin-slim:latest`。在 Linux Docker 主機上：

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

開啟 `http://127.0.0.1:3000`，使用產生的密碼。面向網際網路的部署需要 TLS 反向代理或經核准的通道，
並遵守[轉送規則](../../docs/ops/REVERSE_PROXY.md)。正式部署請將 `VARIN_IMAGE` 固定為經過驗證的不可變摘要。

如需容器內的 Python、Java、Go 或 Rust 開發工具：

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

持久化路徑、環境變數、映像檔變體、支援的架構，以及具健康檢查和回復機制的 SSH 部署，見
[雲端部署](../../docs/ops/cloud-deployment.md)。

## 架構與開發

從[文件索引](../../docs/README.md)、[架構](../../docs/architecture.md)和[開發指南](../../docs/development.md)
開始。Application Host 整合原生 Catalog 執行、Rust 擁有的儲存與資源，以及獨立的知識和擴充套件 owner；
renderer 不擁有憑證或持久執行。

貢獻前請閱讀 [CONTRIBUTING](../CONTRIBUTING.md) 和 [AGENTS](../../AGENTS.md)。命令以 package scripts
為準，驗證應針對改動選擇。

感謝 [LinuxDO](https://linux.do) 社群的支持。

## 來源與授權

Varin 是一個獨立專案，源自維護者的 OpenChamber 分支。

組合後的作品以 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）散布。
透過網路向使用者提供修改版本時，必須按授權條款要求提供對應原始碼。保留的著作權與第三方義務見
[THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。
