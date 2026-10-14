[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | 繁體中文 | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 為 Varin 貢獻

歡迎改進執行環境、桌面與遠端介面、擴充功能、文件、無障礙功能和平台支援。本文介紹公開貢獻流程。
儲存庫規則見 [AGENTS.md](../../AGENTS.md)；環境、命令和驗證方式見[開發指南](../../docs/development.md)；
模組職責見[架構](../../docs/architecture.md)。

## 開始之前

- 閱讀[行為準則](CODE_OF_CONDUCT.zh-TW.md)。
- 先搜尋已有的 issue 和 pull request，避免重複工作。透過
  [GitHub Issues](https://github.com/Youzini-afk/Varin/issues) 回報可重現的問題、提出功能建議和技術討論。
- 按[安全性政策](../SECURITY.md)私下回報漏洞，避免在公開 issue、pull request、日誌或截圖中洩漏利用細節。
- 較大的產品或架構變更，應及早討論預期使用者成果和影響範圍。必要時用原型釐清具體設計問題。

## 實作變更

修改前閱讀負責該行為的實作、實際呼叫端和最近的 README 或 DOCUMENTATION。保持變更聚焦，
保留無關工作，沿用既有程式碼風格和共用 UI 元件。

Pi 是預設對話執行環境。明確選用的 Rust Agent runtime 擁有獨立的歷史和執行管理，兩者共用 Host 服務。
按架構中實際的職責歸屬修改，避免將狀態複製到另一層。切換預設執行環境或遷移使用者資產需要明確約定。

透過公開介面整合擴充功能，保留外掛程式自己的設定和資料。特權操作由受信任的 Host 執行，不能放在 Renderer 中。
按涉及的功能閱讀[安全性](../../docs/security.md)和[擴充功能](../../docs/extensions.md)說明，
不要記錄憑證或使用者私密內容。

過時的內部格式無需相容讀取器或自動遷移機制。不支援的儲存格式必須保留既有資產。工作區檔案、
Git 歷史、Pi 原生資料和外部設定仍屬於使用者資產；目前格式的持久性和復原要求仍然適用。

## 文件

程式碼、型別、schema、測試和套件腳本確定目前行為；文件解釋職責、機制、約束和有價值的設計理由；
Git 保存歷史。行為變更時更新對應的目前說明。[文件入口](../../docs/README.md)用於尋找所屬文件，
進行中的設計和計畫按 [AGENTS.md](../../AGENTS.md) 處理。

面向使用者的公開文件、儲存庫首頁 README、貢獻指南和安全性政策以英文為來源語言。修改事實、命令、
安全性建議或連結時，同步適用的既有譯本；本地化根文件保留語言導覽。

主要工程文件使用中文，原始碼旁和套件內文件沿用既有語言，無需另建平行譯本。
公開文件的語言約定不改變工程文件的約定。

## 驗證

根據變更影響的行為和呼叫端選擇檢查。具體命令查最近的 `package.json` 和
[開發指南](../../docs/development.md)。

優先重用有效的既有檢查。保護重要行為或可重現故障時補回歸測試，不要求每次變更都新增測試。
刪除過時或重複的檢查。共用契約需要實際呼叫端的證據，封裝與平台行為需要相應執行環境；
僅通過型別檢查不能證明這些行為。

UI 變更可用截圖或錄影驗證相關版面、主題和狀態；效能結論應有代表性的測量。
說明實際執行了什麼、哪些仍未驗證。出現新失敗或尚未解決的風險時，再擴大驗證範圍。

## 提交與 pull request

提交標題簡潔說明變更。Pull request 說明問題、變更後的行為、相關驗證和重要限制；
職責歸屬或外部契約的變化有助於理解時一併說明，詳細程度與工作相稱。

更新分支時不要重寫其他貢獻者的工作。解決衝突時核對預期行為和狀態歸屬，避免機械式選擇其中一側。
保留使用者的無關變更，不使用破壞性 Git 清理。

問題回報、文件改進、翻譯更新和平台實測也都是有價值的貢獻，請附上相關環境與重現步驟。

## 授權條款

提交貢獻即表示你同意相關內容可按 Varin 的
[GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）散布，
匯入的第三方內容仍保留[第三方通知](../../THIRD_PARTY_NOTICES.md)要求的聲明。
