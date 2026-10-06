[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | 繁體中文 | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 為 Varin 貢獻

感謝你協助改進 Varin。無論是 Pi 執行時期邊界、桌面與遠端介面、擴充功能整合、文件、測試、無障礙功能，
還是平台支援，都歡迎貢獻。

本指南說明公開的貢獻工作流程。具體實作工作的詳細儲存庫規則，請參閱 [AGENTS.md](../../AGENTS.md)、最近的套件
README，以及負責該功能的架構文件。

## 文件語言

面向使用者的文件預設以英文撰寫。根目錄 README、貢獻指南、安全性政策，以及 `packages/docs` 內容樹根目錄
都是英文來源。簡體中文和其他語言版本都是翻譯。

在同一項變更中，請讓所有適用語言的事實行為、命令、安全性指引和連結保持同步。新的文件頁面應先以英文撰寫，
再新增 `zh-cn/` 和其他語言的鏡像。每份本地化的根目錄文件都必須以語言切換器開頭，讓讀者不必返回儲存庫索引
就能切換語言。

## 開始之前

- 閱讀[行為準則](CODE_OF_CONDUCT.zh-TW.md)。
- 使用 [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) 回報可重現的錯誤、提出功能建議，以及進行聚焦的技術討論。
- 請依照 [SECURITY.md](../SECURITY.md) 中的私人流程提交漏洞。不要在 issue、討論、pull request、日誌或螢幕截圖中公開漏洞利用細節。
- 開始重複性的變更之前，先搜尋現有的 issue 和 pull request。
- 對於大型產品或架構變更，投入完整實作之前，先說明使用者成果和受影響的邊界。如果原型有助於評估取捨，歡迎先提供原型。

## 會影響貢獻的專案原則

Varin 不是圍繞多個程式設計代理 CLI 的通用包裝器。它有一個 Pi 原生領域，以及一個目前的預發布執行時期契約。

1. **讓 Pi 保持權威。** Pi 負責工作階段、模型、驗證、設定、套件和擴充功能執行環境。請投影出可安全轉換為 JSON 的
   Varin 契約；不要把 Pi 狀態複製到平行的應用程式結構描述中。
2. **保留外掛程式的所有權。** 透過公開的命令、事件、設定和功能橋接來整合擴充功能。不要只為了建立 GUI 就解析私有資料庫，
   或複製外掛程式的遷移。
3. **避免相容性沉積。** 在 1.0 之前的開發期間，所有產品介面會一起變動。替代方案獲得接受後，移除過時的 OpenCode 路徑和
   已被取代的 Varin 路徑；除非確實有持久化資料或外部用戶端的需求，否則不要累積協定 v13/v14 風格的相容性墊片。
4. **在受信任邊界執行權限控管。** Renderer 和遠端用戶端不能自行授權。請在擁有該功能的主機中驗證檔案系統、程序、網路、專案信任
   和憑證操作。
5. **不要加入任意的產品限制。** 避免無提示截斷、模型數量上限、過短的逾時，或隱藏的並行上限。作業預算應是明確的部署選擇，
   並具有可見的失敗語義。
6. **讓失敗如實呈現。** 權威來源的失敗不是成功的空回應。請讓取消、部分失敗、清理、重試、回滾和不可用的功能都清楚可見。

在適用的邊界涉及這些內容時，請閱讀[架構](../../docs/architecture.md)、[外掛程式 GUI 設計](../../docs/design/plugin-gui-design.md)、
[復原](../../docs/ops/recovery.md)和[安全性模型](../../docs/design/security.md)。

## 開發環境設定

### 必要條件

- Node.js 22.19 或更新版本；Node.js 24 是 CI 和受支援開發環境的基準版本
- Bun 1.3.14
- Git
- 在 Windows 上使用 Pi shell 工具所需的 Git for Windows 和 Git Bash

### 複製與安裝

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run check:pi
```

`bun.lock` 是權威來源。除非相依性變更有此要求，否則不要切換套件管理器或重新產生 lockfile。請仔細檢查生命週期腳本的
變更；Varin 刻意只允許必要的安裝腳本。

## 常見開發介面

除非另有註明，請從儲存庫根目錄執行命令。

| 目標 | 命令 |
| --- | --- |
| 具備 HMR 與受信任 API 的 Web UI | `bun run dev` |
| Web 建置監看器與伺服器 | `bun run dev:web:full` |
| 使用 Web HMR 的桌面版 | `bun run electron:dev` |
| 使用已建置資產的桌面版 | `bun run electron:dev:bundled` |
| 為目前的作業系統封裝桌面版 | `bun run electron:build` |
| 封裝 Windows x64 NSIS 安裝程式 | `bun run electron:build:win` |
| 對未封裝的 Windows 建置執行冒煙測試 | `bun run electron:smoke:win` |
| 建置行動裝置資產 | `bun run mobile:build` |
| 建置標準雲端執行環境 | `bun run build:cloud-runtime` |
| 驗證文件網站 | `bun run docs:validate` |

共用 UI 是原始碼函式庫，而非獨立應用程式。請透過 Web 或 Desktop 執行 UI 行為，確保執行時期環境是真實的。

## 選擇負責的套件

| 領域 | 主要負責者 |
| --- | --- |
| 共用元件、儲存區、設定、聊天和外掛程式 GUI | `packages/ui` |
| 瀏覽器/遠端伺服器、HTTP API、WebSocket 傳輸、雲端 CLI | `packages/web` |
| Windows/macOS/Linux shell、preload/IPC、SSH、更新器、封裝 | `packages/electron` |
| Capacitor 原生 shell | `packages/mobile` |
| 可安全轉換為 JSON 的線路契約與驗證 | `packages/protocol` |
| 瀏覽器/編輯器執行時期用戶端 | `packages/runtime-client` |
| Worker 所有權、路由、生命週期和關閉 | `packages/runtime-broker` |
| Pi SDK、工作階段、套件、擴充功能和受信任主機操作 | `packages/pi-host` |

共用 API 變更通常會跨越多個套件，但必須保留一個權威層。不要用無關的本機儲存區或僅在 Renderer 中進行的權限檢查，
來繞過缺少的契約。

## 實作變更

1. 找出權威資料來源、受信任的執行邊界、受影響的產品介面，以及失敗行為。
2. 編輯匯入的產品程式碼之前，請閱讀 `AGENTS.md`、最近套件的 README 或 `DOCUMENTATION.md`，以及所有相符的專案 skill。
3. 讓變更保持聚焦。加入直接必要的清理與測試，但把會增加審查難度的無關重構分開。
4. 在負責該行為的邊界，新增或更新能證明行為的最小回歸測試。
5. 執行每個契約有所變更的執行時期介面。對共用型別進行型別檢查，並不能證明 Desktop、Web、中繼或行動端的行為有效。
6. 當契約有所變更時，在同一項變更中更新使用者、貢獻者、架構、安全性或作業文件。

變更有版本或持久化的結構時，請優先採用一次清楚遷移到目前結構的方式。只有在真實使用者資料或獨立部署的用戶端確實需要時，
才保留舊的讀取器，並記錄移除條件。

## 驗證

### 廣泛基準

對於程式碼、相依性、匯出或建置變更，請執行廣泛檢查：

```bash
bun run type-check
bun run lint
bun run check:pi
bun run build
```

在適用的受影響邊界中，請執行以下檢查：

| 變更 | 額外證據 |
| --- | --- |
| Pi 主機、協定、broker 或執行時期用戶端 | `bun run test:pi:dist` |
| Web 伺服器或傳輸 | `bun run --cwd packages/web test` |
| 雲端執行環境、Docker 或 SSH 部署 | `bun run test:cloud` 和標準執行環境建置 |
| Electron 生命週期、架構或更新器 | `bun run --cwd packages/electron test:architecture` 和/或 `test:updater` |
| Windows 封裝或原生模組 | `bun run electron:build:win`，接著執行 `bun run electron:smoke:win` |
| 匯入、匯出或刪除 | `bun run dead-code` 和每個受影響介面的正式建置 |
| 文件網站 | `bun run docs:validate` 和手動檢查變更的本機連結 |
| 工作區 `package.json` 或根目錄 lockfile | `bun run update:cloud-runtime-lock`，讓 `scripts/cloud-runtime.bun.lock` 保持凍結 |

CI 會在 Windows 和 Ubuntu 上重複主要品質閘門。雲端/執行環境變更也會建置並對候選容器執行冒煙測試，之後才會提升任何可安裝的標籤。

如果必要的檢查無法在你的主機上執行，請準確說明未測試的內容及原因。不要把未測試的平台假設說成已獲支援。

### 使用者可見的變更

請在目前的 pull request HEAD 提供證據：

- 有意義的靜態變更前後狀態的螢幕截圖；
- 動態效果、焦點、拖放、手勢或多步驟互動的短片；
- 響應式共用 UI 的窄版與寬版版面；
- 變更色彩或介面時的淺色和深色主題；
- 相關的載入中、空白、停用、錯誤、長內容和高對比狀態；
- 針對效能、記憶體、CPU、啟動或轉譯主張的變更前後測量。

如果沒有使用者可見的變更，請說明原因。

## 程式碼與安全性風格

- 使用嚴格的 TypeScript，除非邊界確實是動態且已驗證，否則避免使用 `any`。
- 相較於巢狀條件或隱含回退，優先使用小型判別式契約、提前返回和明確的狀態轉換。
- 保持 React 元件為函式型，並在淺色和深色模式中使用 `packages/ui` 已建立的主題和字體排版 token。
- 保持 Electron preload API 明確且具備型別。不要加入通用的 channel 逃生口，也不要在共用 Renderer 程式碼中匯入 Electron。
- 絕不要在 Renderer 中執行 Pi 擴充功能。
- 絕不要記錄憑證、授權或配對資料、提示內容、檔案內容、包含使用者資料的供應商回應，或完整的環境值。
- 使用以標準化檔案系統邊界為基礎的路徑包含檢查，不要只依賴字串前綴。
- 對共用設定或中繼資料寫入使用鎖定與原子取代；讓並行編輯和當機復原可測試。
- 在有未提交變更的工作樹中保留使用者變更和無關工作。不要為了方便而使用破壞性的 Git 清理。

## 提交與 pull request

使用簡短、祈使句形式的提交標題；有助於辨識時，請加上慣例式類型前綴，例如：

```text
feat: add Pi package capability diagnostics
fix: preserve session cwd across worktrees
docs: explain cloud rollback guarantees
```

Pull request 應讓審查者無需重新拼湊你的調查過程就能驗證結果。請包含：

- 使用者或維護者遇到的問題，以及產生的行為；
- 當鄰近範圍可能含糊不清時，列出不在目標內的內容；
- 受影響的套件、執行時期、持久化格式、外部契約和信任邊界；
- 確切的自動化與手動檢查，包括檢查結果；
- 重要的風險、失敗、清理、回滾、相容性和安全性考量；
- 適用時提供目前的視覺或實證資料；
- 任何無法驗證的內容。

在不重寫其他貢獻者工作的前提下保持分支最新。解決衝突時請重新評估行為與所有權，不要機械式選擇 diff 的其中一方。

## 非程式碼貢獻

你也可以透過以下方式提供協助：

- 回報可重現的錯誤或令人困惑的工作流程；
- 在其他作業系統、瀏覽器、架構或顯示尺寸上測試；
- 改善設定、部署、無障礙功能、本地化或疑難排解文件；
- 驗證受維護的 Pi 擴充功能更新，並記錄相容性證據；
- 提議更清楚的 Pi 原生互動方式或外掛程式設定介面。

## 授權條款

提交貢獻即表示你同意該貢獻可以依 Varin 的
[GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）散布，且匯入的第三方資料會保留
[第三方通知](../../THIRD_PARTY_NOTICES.md)所要求的聲明。
