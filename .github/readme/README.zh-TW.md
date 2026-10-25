[English](../../README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [Français](README.fr.md) | [日本語](README.ja.md)

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>開源的通用 Agent 工作台。</strong></p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases">下載</a> ·
  <a href="../../packages/docs/README.md">使用指南</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">開發擴充功能</a> ·
  <a href="../translations/CONTRIBUTING.zh-TW.md">參與貢獻</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

把模型、工具、檔案和專案放在同一個工作空間裡。你可以和 Agent 一起排查問題、撰寫程式、閱讀論文，或製作互動式說明；執行過程和結果都保留在對話中，方便查看與繼續工作。

Varin 提供桌面版和網頁版，也有連接 Host 的行動客戶端。它使用自己的 Rust 執行環境管理 Agent 執行和對話歷史。

## 用 Varin 做什麼

| 手頭的工作 | Varin 提供的能力 |
| --- | --- |
| 推進一項任務 | 串流對話、訊息佇列、計畫、子 Agent 和排程接續。 |
| 開發專案 | 檔案編輯、差異檢視、Git 與 worktree、終端機，以及程式碼檢索和語言工具。 |
| 閱讀與研究 | 網頁與學術檢索、PDF 閱讀，在對話旁保留原始資料。 |
| 製作視覺化內容 | 生成和編輯圖像，在訊息中製作互動式 HTML 圖表和小工具。 |
| 組織自己的工具 | 連接雲端或本機模型，設定權限，配置指令、skills 和 MCP 服務。 |
| 跨裝置工作 | 使用本機工作區，或從桌面、瀏覽器和行動裝置連接遠端 Host。 |

內建的 Agent、IDE、Research 和 Bot 工作台為不同任務提供相應配置。IDE 支援桌面與網頁，其他工作台也支援行動裝置。[工作台說明](../../docs/workbench.md)

## 開始使用

| 使用方式 | 入口 |
| --- | --- |
| Windows、macOS 或 Linux 桌面版 | [下載發行版](https://github.com/Youzini-afk/Varin/releases)，選擇與系統和 CPU 架構對應的安裝檔。 |
| 在自己的電腦或伺服器執行，透過瀏覽器存取 | [Docker 自行部署](../../docs/ops/cloud-deployment.md)，包含持久化目錄、密碼和遠端存取設定。 |
| iOS 或 Android | [行動端設定](../../packages/mobile/README.md)。行動客戶端連接既有 Host。 |
| 從原始碼執行 | 見下方開發步驟。 |

開啟應用程式後，先在設定中連接模型提供者或本機服務。選擇模型，依任務需要選擇專案資料夾，即可開始對話。輸入框中可以選擇權限，並切換通用或科研工作模式。

Varin 正處於 1.0 之前的活躍開發階段。本頁介紹目前原始碼，[發行說明](https://github.com/Youzini-afk/Varin/releases)記錄各發行版的內容。升級前請備份重要的應用程式資料。

## 從原始碼執行

使用 **Node.js 24**、**Bun 1.3.14**、Git，以及 [rust-toolchain.toml](../../kernel/rust-toolchain.toml) 指定的 Rust 工具鏈。原生相依套件還需要 C/C++ 工具鏈與 CMake。環境與指令說明見[開發指南](../../docs/development.md)。

```sh
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

開啟終端機印出的 UI 網址。此指令會啟動網頁介面和 Application Host。

開發桌面版時，在同一份原始碼中執行 `bun run electron:dev`。它會準備原生核心，並啟動帶有開發介面的 Electron 應用程式。[桌面開發與打包](../../packages/electron/README.md#development)

## 擴充你的工作台

Varin 的 Harness 負責連接模型、工具、上下文、權限、背景工作和子 Agent。原生 Rust 執行環境儲存對話與執行紀錄，共享的 Application Host 提供模型連線和工作區服務。

常用工具直接宣告，其他可用能力透過索引和按需說明提供。讀取說明時保持工具宣告前綴穩定。研究工具在通用模式下按需揭露，在科研模式下直接常駐。

擴充功能可以加入工具、模型轉接器、面板，乃至整套工作台配置。從[擴充功能作者指南](../../docs/ops/varin-extension-authoring.md)、[SDK](../../packages/extension-sdk/README.md)或[範例](../../examples/extensions/README.md)開始。

實作細節見[架構](../../docs/architecture.md)、[執行環境](../../docs/runtime.md)和[文件索引](../../docs/README.md)。

## 參與貢獻

歡迎提交問題報告、改進介面和工具、補充文件與翻譯，或分享平台實測結果。[貢獻指南](../translations/CONTRIBUTING.zh-TW.md)介紹開發準備、如何選擇改動和提交 Pull Request。

[回報問題](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [提出建議](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [私下回報安全漏洞](../SECURITY.md)

感謝 [LinuxDO](https://linux.do) 社群的支持。

## 授權

專案依 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）散布。透過網路提供修改版本時，應依授權條款提供對應原始碼。著作權與第三方聲明保留在 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) 中。
