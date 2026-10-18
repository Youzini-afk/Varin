[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | 繁體中文 | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 為 Varin 貢獻

修復問題、改善工作流程、開發擴充功能、編寫文件，以及分享平台實測結果，都是參與 Varin 的方式。

## 從哪裡開始

先在 [Issues](https://github.com/Youzini-afk/Varin/issues) 和 [Pull Requests](https://github.com/Youzini-afk/Varin/pulls) 中尋找相關工作。第一次貢獻可以從小而明確、能重現的問題開始。較大的改動，適合提早說明想改善的工作流程，並分享草圖或原型。

問題報告本身也很有幫助。請提供版本、安裝方式、實際現象，以及重現步驟或範例。日誌和截圖中請移除金鑰與私人內容。漏洞報告請使用[安全政策](../SECURITY.md)中的管道。

## 準備開發環境

Fork 並複製儲存庫。原始碼開發使用 Node.js 24、Bun 1.3.14、Git、Rust、C/C++ 工具鏈和 CMake。具體環境與指令見[開發指南](../../docs/development.md)。

在儲存庫根目錄執行：

```sh
bun install --frozen-lockfile
git switch -c your-change
bun run dev
```

開啟終端機印出的 UI 網址。開發桌面版使用 `bun run electron:dev`。改動需要實際執行 Agent 時，在設定中配置模型。

修改前閱讀 [AGENTS.md](../../AGENTS.md) 及程式碼附近的 README 或 DOCUMENTATION。

## 找到對應模組

| 修改內容 | 入口 |
| --- | --- |
| 對話、面板、編輯器和共用介面 | [packages/ui](../../packages/ui/DOCUMENTATION.md) |
| 模型連線、應用程式服務與遠端存取 | [Application Host](../../packages/web/README.md) |
| Agent 執行、歷史、檔案和程序 | [Rust 核心](../../kernel/README.md) |
| 擴充介面與開發 | [擴充功能作者指南](../../docs/ops/varin-extension-authoring.md)、[範例](../../examples/extensions/README.md) |
| 使用指南與翻譯 | [公開文件編寫](../../packages/docs/CONTRIBUTING.md) |
| 系統各部分如何配合 | [架構](../../docs/architecture.md)、[文件索引](../../docs/README.md) |

沿現有職責修改：Rust 執行環境管理對話與執行，Application Host 提供可信服務，客戶端透過共用 API 呈現這些能力。保留使用者檔案與資料，擴充功能沿用既有公開介面。

## 實作與驗證

一個 Pull Request 聚焦一個完整的問題。閱讀實作及其呼叫端，沿用既有程式碼風格與共用 UI 元件，並更新描述該行為的文件。

依實際改動選擇驗證。優先重用既有測試；重要行為或已重現的問題，適合補充小而明確的回歸測試。[開發指南](../../docs/development.md#修改与验证)按改動類型列出了檢查方式。文件和連結修改使用 `bun run docs:validate`。

介面改動附上對應狀態的截圖或錄影；效能改動提供有代表性的量測。記錄實際執行的指令和結果，以及受環境影響尚未驗證的相關行為。

公開使用指南和儲存庫介紹以英文為源語言。修改行為、指令或連結時，同步既有譯本。主要工程文件使用中文，套件內和程式碼旁的文件沿用既有語言。

## 提交 Pull Request

先說明問題和改動後的行為，再提供相關驗證。關聯已有 Issue，必要時附圖。[PR 範本](../pull_request_template.md)提供了這些資訊的填寫位置。

提交標題簡潔描述改動。解決衝突時確認預期行為，保留與本次修改無關的工作。

## 社群與授權

請遵守[行為準則](CODE_OF_CONDUCT.zh-TW.md)。

提交貢獻即表示你同意相關內容可依 [AGPL-3.0-only](../../LICENSE) 散布。引入第三方內容時保留其著作權與授權聲明，詳見 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。
