[English](../../README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [Français](README.fr.md) | [日本語](README.ja.md)

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>開箱即用的開源 Agent Harness。</strong></p>

<p align="center">模型之外的一切都已備妥，開箱即用，也能深度自訂。</p>

<p align="center">
  <a href="https://varin.dev/zh-tw/">官網</a> ·
  <a href="https://github.com/Youzini-afk/Varin/releases/latest">下載</a> ·
  <a href="../../packages/docs/README.zh-CN.md">使用指南</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">開發擴充功能</a> ·
  <a href="https://github.com/Youzini-afk/Varin/discussions">討論區</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

<p align="center">
  <img src="assets/code-mode.png" alt="程式開發模式下的 Varin：Agent 檢索專案、修改 profile.js，把回歸測試交給驗證隊友，最後回報測試全部通過" width="960" />
</p>

模型負責思考，Harness 是它周圍的一切：工具、上下文、執行、權限、協作與復原。Varin 把這些都準備好了，同一個模型放進來，能完成更長、更複雜的任務。下載安裝，填上自己的 API Key，就能開始。

## 為什麼是 Varin

**同一個模型，走得更遠。**

- 上下文自整理：在背景提前整理，寫摘要時保留關鍵原文；用本機分詞計算 token，並依實際用量校準。
- 持久執行：每一步都有紀錄，重啟後從中斷處繼續；結果不明的操作先停下核對，不會再執行一遍。
- 提問不阻塞：等你回覆時，其他工作照常進行；附預算的目標在條件滿足時自動繼續。
- 工具按需：常用工具常駐，其餘按需載入；MCP 服務可以直接開放，也可以按需探索。

**開箱即用。** 近 80 個原生工具、4 種工作模式、4 個官方工作台、6 個內建語言伺服器、8 種原生模型協定，介面支援 10 種語言。

**深度自訂，不寫程式碼。** 每個預設 Agent 都能換模型、改指示、調工具，也能自建 Agent；標題產生、上下文整理、規劃、生圖、嵌入可分別指定模型。系統指示與記憶可編輯；Skills 相容 `.claude` 與 `.agents` 目錄，也能從 Git 儲存庫安裝；每個工具都能設為允許、詢問或拒絕。

**你的 Key，你的資料。** 金鑰只存在你自己的 Host 上，請求直接送往你設定的服務商：OpenAI、Anthropic、Gemini、Vertex AI、Azure OpenAI、Bedrock、Mistral、阿里雲百鍊、智譜、階躍星辰，也可以是 Ollama、LM Studio 或任意相容端點。用量依管道和模型逐輪記錄。

## 四種工作方式

模式決定 Agent 先拿到哪些工具、有哪些隊友協助。

| 模式 | 用來做什麼 | 例如 |
| --- | --- | --- |
| 程式開發 | 讀程式碼、改程式碼、執行指令、開終端機，被修改的檔案按輪次留存。 | 「把登入模組重構一下，測試全部通過再叫我。」 |
| 科研 | 檢索 OpenAlex 與 Semantic Scholar，閱讀論文與 PDF，一步步推進實驗。 | 「找出近兩年這個方向的論文，做一張能篩選的比較表。」 |
| 辦公 | 直接操作 Word、Excel、PowerPoint，以及瀏覽器和電腦上的應用程式。 | 「把上個月的訂單匯出來，整理成附圖表的 Excel。」 |
| 通用 | 查資料、寫東西、做一個能互動的小工具。 | 「比較這三款相機，做一張能調參數的比較圖。」 |

<p align="center">
  <img src="assets/research-mode.png" alt="科研模式下的 Varin：在對話裡用表格比較近期的論文" width="960" />
</p>

## 團隊、Bot 與可還原的改動

- **團隊**：主 Agent 先拆分任務，再分給隊友：Worker 寫實作，調研 Agent 查資料，驗證 Agent 跑測試。隊友並行推進，彼此直接傳訊息、交接程式碼（附逐檔差異），完成後回報。你可以在協作面板裡查看它們的討論，也能隨時插話。
- **Bot**：有自己的名字、指示、模型和工作目錄，能同時推進好幾件事。它記住的內容你都看得到，可以更正，也可以讓它忘掉。讓它睡眠，手上的工作會暫停；喚醒後從原處繼續。
- **檔案時間軸**：每輪被修改的檔案都排在時間軸上，一鍵還原，還原本身也能撤銷；你手動改過的檔案不會被覆寫。

<p align="center">
  <img src="assets/team.png" alt="主 Agent 把檢查交給隊友，隊友跑完測試後在協作面板裡回報" width="960" />
</p>

## 開始使用

1. 安裝 Varin。

   | 使用方式 | 入口 |
   | --- | --- |
   | Windows、macOS 或 Linux | [下載安裝檔](https://github.com/Youzini-afk/Varin/releases/latest)，選擇與系統和 CPU 架構對應的版本。 |
   | 在自己的伺服器上執行，用瀏覽器存取 | [Docker 自行託管](../../docs/ops/cloud-deployment.md)，包含持久化目錄、密碼和遠端存取設定。 |
   | 手機 | 在設定中把手機與 Host 配對。原生應用程式發布前，可以安裝網頁應用程式（PWA）。[行動裝置指南](../../packages/docs/content/docs/zh-cn/mobile.mdx) |
   | 從原始碼執行 | 見[從原始碼執行](#從原始碼執行)。 |

2. 開啟設定，填入模型服務商的 API Key，或連接本機服務。[服務商與模型](../../packages/docs/content/docs/zh-cn/providers.mdx)
3. 選擇工作模式，任務需要時選一個專案資料夾，開始第一個任務。

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

## 擴充 Varin

官方的 Agent、IDE、科研、Bot 工作台，以及瀏覽器、Office、電腦操作、語言伺服器，本身都是擴充功能，和第三方擴充功能用的是同一套契約。每一個都能停用，工作台也能整個替換。擴充功能可以加入工具、模型協定、上下文演算法、面板，乃至整套工作台。從[擴充功能開發指南](../../docs/ops/varin-extension-authoring.md)、[SDK](../../packages/extension-sdk/README.md)或[範例](../../examples/extensions/README.md)開始。

想了解各部分如何配合，見[架構](../../docs/architecture.md)、[執行環境](../../docs/runtime.md)和[文件索引](../../docs/README.md)。

## 交流與參與

- 使用問題到 [Q&A](https://github.com/Youzini-afk/Varin/discussions/categories/q-a) 提問，作品分享和想法建議在[討論區](https://github.com/Youzini-afk/Varin/discussions)交流。[取得協助](../translations/SUPPORT.zh-TW.md)列出了各類問題該去哪裡。
- 歡迎貢獻：工具與上下文處理、模型服務商串接、擴充功能、文件與翻譯，以及各平台的實測報告。[貢獻指南](../translations/CONTRIBUTING.zh-TW.md)介紹了開發準備和 Pull Request 流程。
- [回報問題](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [提出建議](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [私下回報安全漏洞](../SECURITY.md)

感謝 [LinuxDO](https://linux.do) 社群的支持。

## 授權

專案依 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）散布。透過網路提供修改版本時，應依授權條款提供對應原始碼。著作權與第三方聲明保留在 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) 中。
